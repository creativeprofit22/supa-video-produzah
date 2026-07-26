use std::{
    collections::HashMap,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::json;
use uuid::Uuid;

use super::{
    hash::{canonical_hash, state_hash},
    history::{
        command_group_payload_hash, commit_transition, redo_transition, reject_duplicate_conflict,
        undo_transition, HistoryTransition,
    },
    integrity::{is_canonical_uuid, trim_contract_text, validate_snapshot},
    journal::{acquire_project_lock, append_and_sync, journal_path, scan},
    migration::migrate_v1_bytes,
    recovery::{create_journal_for_snapshot, recover},
    snapshot::{
        checkpoint, checkpoint_with_failpoint, previous_snapshot_path, restore_file_bytes,
        CheckpointFailpoint, MAX_SNAPSHOT_BYTES,
    },
    types::{
        CommandGroupRequest, CommandResult, JournalHealth, JournalRecord, JournalRecordKind,
        LastCommandMetadata, OpenedProjectV2, ProjectCommand, ProjectEvent, ProjectHistoryV2,
        ProjectInspector, ProjectProjection, ProjectRevisionDescriptorV2, RecoveryReport,
        RecoveryStatus, VideoProjectSnapshotV2, VideoProjectStateV2, MAX_COMMAND_GROUP_BYTES,
        MAX_NON_BLANK_UTF16, MAX_SAFE_INTEGER,
    },
};
use crate::video::{
    error::{VideoCommandError, VideoErrorCode},
    grants::{normalize_existing_file, GrantCategory, VideoPathGrants},
    project_io::{require_extension, resolve_project_asset_sources, VideoSourceRecord},
    types::{AssetLocator, MediaProbe},
};

const CHECKPOINT_INTERVAL: u64 = 25;

#[derive(Debug, Clone)]
struct IdempotencyEntry {
    payload_hash: String,
    result: CommandResult,
}

#[derive(Debug)]
struct ProjectSession {
    owner: String,
    path: PathBuf,
    _lock_file: File,
    snapshot: VideoProjectSnapshotV2,
    sources: Vec<VideoSourceRecord>,
    journal_health: JournalHealth,
    snapshot_revision: u64,
    recovery_status: RecoveryStatus,
    replayed_record_count: u64,
    last_command: Option<LastCommandMetadata>,
    idempotency: HashMap<String, IdempotencyEntry>,
}

#[derive(Debug, Default)]
pub struct VideoProjectService {
    sessions: Mutex<HashMap<String, Arc<Mutex<ProjectSession>>>>,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProjectInitializationFailpoint {
    None,
    AfterJournal,
    Checkpoint(CheckpointFailpoint),
}

#[derive(Debug)]
struct InitializationArtifacts {
    project_path: PathBuf,
    original_project_bytes: Option<Vec<u8>>,
    previous_path: PathBuf,
    original_previous_bytes: Option<Vec<u8>>,
    journal_path: PathBuf,
    journal_existed: bool,
}

fn error(code: VideoErrorCode, category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        code,
        "Native project service rejected the operation",
        "project_service",
        category,
    )
}

fn now() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn optional_file_bytes(path: &Path) -> Result<Option<Vec<u8>>, VideoCommandError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error(VideoErrorCode::ProjectIo, "initialization_capture")),
    }
}

impl InitializationArtifacts {
    fn capture(
        project_path: &Path,
        original_project_bytes: Option<&[u8]>,
    ) -> Result<Self, VideoCommandError> {
        let previous_path = previous_snapshot_path(project_path)?;
        let journal_path = journal_path(project_path)?;
        let journal_existed = journal_path
            .try_exists()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "journal_existence"))?;
        Ok(Self {
            project_path: project_path.to_owned(),
            original_project_bytes: original_project_bytes.map(<[u8]>::to_vec),
            original_previous_bytes: optional_file_bytes(&previous_path)?,
            previous_path,
            journal_path,
            journal_existed,
        })
    }

    fn rollback(self) -> Result<(), VideoCommandError> {
        let project_result =
            restore_file_bytes(&self.project_path, self.original_project_bytes.as_deref());
        let previous_result =
            restore_file_bytes(&self.previous_path, self.original_previous_bytes.as_deref());
        let journal_result = if self.journal_existed {
            Ok(())
        } else {
            restore_file_bytes(&self.journal_path, None)
        };
        if project_result.is_err() || previous_result.is_err() || journal_result.is_err() {
            return Err(error(VideoErrorCode::ProjectIo, "initialization_rollback"));
        }
        Ok(())
    }
}

fn initialize_project_files(
    project_path: &Path,
    snapshot: &mut VideoProjectSnapshotV2,
    original_project_bytes: Option<&[u8]>,
    failpoint: ProjectInitializationFailpoint,
) -> Result<(), VideoCommandError> {
    let artifacts = InitializationArtifacts::capture(project_path, original_project_bytes)?;
    let attempt = (|| {
        create_journal_for_snapshot(project_path, snapshot)?;
        match failpoint {
            ProjectInitializationFailpoint::None => checkpoint(project_path, snapshot),
            ProjectInitializationFailpoint::AfterJournal => {
                Err(error(VideoErrorCode::ProjectIo, "failpoint_after_journal"))
            }
            ProjectInitializationFailpoint::Checkpoint(checkpoint_failpoint) => {
                checkpoint_with_failpoint(project_path, snapshot, checkpoint_failpoint)
            }
        }
    })();
    if let Err(attempt_error) = attempt {
        artifacts.rollback()?;
        return Err(attempt_error);
    }
    Ok(())
}

fn transition_summary(kind: &JournalRecordKind, summary: &str) -> String {
    let candidate = match kind {
        JournalRecordKind::Commit => summary.to_owned(),
        JournalRecordKind::Undo => format!("Undid {summary}"),
        JournalRecordKind::Redo => format!("Redid {summary}"),
    };
    if candidate.encode_utf16().count() <= MAX_NON_BLANK_UTF16 {
        candidate
    } else {
        match kind {
            JournalRecordKind::Commit => "Applied command group".to_owned(),
            JournalRecordKind::Undo => "Undid command group".to_owned(),
            JournalRecordKind::Redo => "Redid command group".to_owned(),
        }
    }
}

fn new_id() -> String {
    Uuid::new_v4().hyphenated().to_string()
}
fn session_key(owner: &str, project_id: &str) -> String {
    format!("{owner}\0{project_id}")
}

fn projection(session: &ProjectSession) -> ProjectProjection {
    ProjectProjection {
        project_id: session.snapshot.id.clone(),
        name: session.snapshot.name.clone(),
        revision: session.snapshot.revision.clone(),
        state: session.snapshot.state.clone(),
        can_undo: !session.snapshot.history.undo_stack.is_empty(),
        can_redo: !session.snapshot.history.redo_stack.is_empty(),
        last_command: session.last_command.clone(),
        sources: session.sources.clone(),
        journal_health: session.journal_health.clone(),
        snapshot_revision: session.snapshot_revision,
        recovery_status: session.recovery_status.clone(),
        replayed_record_count: session.replayed_record_count,
    }
}

fn validate_gateway_paths(
    owner: &str,
    commands: &[ProjectCommand],
    grants: &VideoPathGrants,
) -> Result<(), VideoCommandError> {
    for command in commands {
        let locator = match command {
            ProjectCommand::ImportAsset { asset, .. } => Some(&asset.locator),
            ProjectCommand::RelinkAsset { locator, .. } => Some(locator),
            _ => None,
        };
        if let Some(path) = locator.and_then(|locator| locator.absolute_path.as_deref()) {
            grants.authorize(owner, GrantCategory::Source, Path::new(path))?;
        }
    }
    Ok(())
}

fn record_for_transition(
    transition: &HistoryTransition,
    payload_hash: String,
    idempotency_result: CommandResult,
    previous_record_hash: String,
    record_number: u64,
) -> JournalRecord {
    let commands = match transition.kind {
        JournalRecordKind::Commit | JournalRecordKind::Redo => {
            transition.history_group.forward_commands.clone()
        }
        JournalRecordKind::Undo => transition.history_group.inverse_commands.clone(),
    };
    let summary = transition_summary(&transition.kind, &transition.history_group.summary);
    JournalRecord {
        kind: transition.kind.clone(),
        record_number,
        operation_id: transition.operation_id.clone(),
        group_id: transition.group_id.clone(),
        committed_at: transition.snapshot.updated_at.clone(),
        base_revision: transition.prior_revision.clone(),
        resulting_revision: transition.snapshot.revision.clone(),
        commands,
        history_group: transition.history_group.clone(),
        summary,
        affected_ranges: transition.applied.affected_ranges.clone(),
        cache_invalidations: transition.applied.cache_invalidations.clone(),
        previous_state_hash: transition.prior_revision.state_hash.clone(),
        resulting_state_hash: transition.snapshot.revision.state_hash.clone(),
        payload_hash: Some(payload_hash),
        idempotency_result: Some(Box::new(idempotency_result)),
        previous_record_hash,
        record_hash: String::new(),
    }
}

fn journal_payload_hash(
    project_id: &str,
    record: &JournalRecord,
) -> Result<String, VideoCommandError> {
    match record.kind {
        JournalRecordKind::Commit => command_group_payload_hash(&CommandGroupRequest {
            group_id: record.group_id.clone(),
            project_id: project_id.to_owned(),
            base_revision: record.base_revision.number,
            commands: record.commands.clone(),
        }),
        JournalRecordKind::Undo | JournalRecordKind::Redo => canonical_hash(&json!({
            "projectId": project_id,
            "baseRevision": record.base_revision.number,
            "operationId": record.operation_id,
            "redo": record.kind == JournalRecordKind::Redo,
        })),
    }
}

fn validate_idempotency_result(
    project_id: &str,
    record: &JournalRecord,
    result: &CommandResult,
) -> Result<(), VideoCommandError> {
    if result.project_id != project_id
        || result.operation_id != record.operation_id
        || result.group_id != record.group_id
        || result.prior_revision != record.base_revision
        || result.new_revision != record.resulting_revision
        || result.state_hash != record.resulting_state_hash
        || result.projection.project_id != project_id
        || result.projection.revision != record.resulting_revision
        || state_hash(&result.projection.state)? != record.resulting_state_hash
        || result.affected_ranges != record.affected_ranges
        || result.cache_invalidations != record.cache_invalidations
    {
        return Err(error(VideoErrorCode::InvalidProject, "idempotency_result"));
    }
    Ok(())
}

fn load_idempotency(
    project_path: &Path,
) -> Result<HashMap<String, IdempotencyEntry>, VideoCommandError> {
    let scanned = scan(&journal_path(project_path)?)?;
    let mut idempotency: HashMap<String, IdempotencyEntry> = HashMap::new();
    for record in scanned.records {
        let reconstructed_hash = journal_payload_hash(&scanned.header.project_id, &record)?;
        let payload_hash = record.payload_hash.as_ref().unwrap_or(&reconstructed_hash);
        if payload_hash != &reconstructed_hash {
            return Err(error(
                VideoErrorCode::InvalidProject,
                "idempotency_payload_hash",
            ));
        }
        let key = match record.kind {
            JournalRecordKind::Commit => &record.group_id,
            JournalRecordKind::Undo | JournalRecordKind::Redo => &record.operation_id,
        };
        if let Some(existing) = idempotency.get(key) {
            if existing.payload_hash != *payload_hash {
                return Err(error(
                    VideoErrorCode::InvalidProject,
                    "idempotency_key_reuse",
                ));
            }
            continue;
        }
        if let Some(result) = record.idempotency_result.as_deref() {
            validate_idempotency_result(&scanned.header.project_id, &record, result)?;
            idempotency.insert(
                key.clone(),
                IdempotencyEntry {
                    payload_hash: payload_hash.clone(),
                    result: result.clone(),
                },
            );
        }
    }
    Ok(idempotency)
}

impl VideoProjectService {
    fn insert_session(
        &self,
        session: ProjectSession,
    ) -> Result<ProjectProjection, VideoCommandError> {
        let result = projection(&session);
        let key = session_key(&session.owner, &session.snapshot.id);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "session_lock"))?;
        if sessions.contains_key(&key) {
            return Err(error(VideoErrorCode::ProjectInUse, "session_exists"));
        }
        sessions.insert(key, Arc::new(Mutex::new(session)));
        Ok(result)
    }

    fn session(
        &self,
        owner: &str,
        project_id: &str,
    ) -> Result<Arc<Mutex<ProjectSession>>, VideoCommandError> {
        self.sessions
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "session_lock"))?
            .get(&session_key(owner, project_id))
            .cloned()
            .ok_or_else(|| error(VideoErrorCode::InvalidProject, "unknown_session"))
    }

    pub fn create(
        &self,
        owner: &str,
        path: &Path,
        name: &str,
        grants: &VideoPathGrants,
    ) -> Result<ProjectProjection, VideoCommandError> {
        self.create_with_initialization_failpoint(
            owner,
            path,
            name,
            grants,
            ProjectInitializationFailpoint::None,
        )
    }

    pub(crate) fn create_with_initialization_failpoint(
        &self,
        owner: &str,
        path: &Path,
        name: &str,
        grants: &VideoPathGrants,
        failpoint: ProjectInitializationFailpoint,
    ) -> Result<ProjectProjection, VideoCommandError> {
        require_extension(path, "svpvideo", "create_project", "project")?;
        let path = grants.authorize(owner, GrantCategory::Project, path)?;
        if path.exists() {
            return Err(error(VideoErrorCode::DuplicateConflict, "project_exists"));
        }
        let name = trim_contract_text(name);
        if name.is_empty() || name.encode_utf16().count() > MAX_NON_BLANK_UTF16 {
            return Err(error(VideoErrorCode::InvalidProject, "project_name"));
        }
        let lock_file = acquire_project_lock(&path)?;
        let timestamp = now();
        let state = VideoProjectStateV2 {
            assets: vec![],
            sequences: vec![],
            active_sequence_id: None,
        };
        let hash = state_hash(&state)?;
        let mut snapshot = VideoProjectSnapshotV2 {
            schema_version: 2,
            id: new_id(),
            name: name.to_owned(),
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
            storage_generation_id: new_id(),
            revision: ProjectRevisionDescriptorV2 {
                number: 0,
                id: new_id(),
                parent_id: None,
                committed_at: timestamp,
                operation_id: new_id(),
                state_hash: hash,
            },
            state,
            history: ProjectHistoryV2::default(),
            last_applied_record_number: 0,
            last_record_hash: "0".repeat(64),
        };
        initialize_project_files(&path, &mut snapshot, None, failpoint)?;
        self.insert_session(ProjectSession {
            owner: owner.to_owned(),
            path,
            _lock_file: lock_file,
            snapshot,
            sources: vec![],
            journal_health: JournalHealth::Healthy,
            snapshot_revision: 0,
            recovery_status: RecoveryStatus::Clean,
            replayed_record_count: 0,
            last_command: None,
            idempotency: HashMap::new(),
        })
    }

    pub fn open(
        &self,
        owner: &str,
        selected_path: &Path,
        grants: &VideoPathGrants,
    ) -> Result<OpenedProjectV2, VideoCommandError> {
        self.open_with_initialization_failpoint(
            owner,
            selected_path,
            grants,
            ProjectInitializationFailpoint::None,
        )
    }

    pub(crate) fn open_with_initialization_failpoint(
        &self,
        owner: &str,
        selected_path: &Path,
        grants: &VideoPathGrants,
        failpoint: ProjectInitializationFailpoint,
    ) -> Result<OpenedProjectV2, VideoCommandError> {
        let path =
            normalize_existing_file(selected_path, "open_project_v2", GrantCategory::Project)?;
        require_extension(&path, "svpvideo", "open_project_v2", "project")?;
        let lock_file = acquire_project_lock(&path)?;
        let metadata = fs::metadata(&path)
            .map_err(|_| error(VideoErrorCode::ProjectIo, "snapshot_metadata"))?;
        if metadata.len() > MAX_SNAPSHOT_BYTES {
            return Err(error(VideoErrorCode::StorageLimit, "snapshot_bytes"));
        }
        let bytes =
            fs::read(&path).map_err(|_| error(VideoErrorCode::ProjectIo, "snapshot_read"))?;
        let schema_version = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .get("schemaVersion")
                    .and_then(serde_json::Value::as_u64)
            })
            .ok_or_else(|| error(VideoErrorCode::InvalidProject, "schema_version"))?;
        let (snapshot, recovery_report, replayed_record_count, last_command) =
            if schema_version == 1 {
                let mut snapshot = migrate_v1_bytes(&bytes)?;
                initialize_project_files(&path, &mut snapshot, Some(&bytes), failpoint)?;
                let report = RecoveryReport {
                    status: RecoveryStatus::MigratedV1,
                    recovered_revision: 0,
                    replayed_record_count: 0,
                    discarded_tail_bytes: 0,
                    message: "Current V1 state migrated; legacy history was reset.".to_owned(),
                    legacy_history_reset: true,
                };
                (snapshot, report, 0, None)
            } else if schema_version == 2 {
                let recovered = recover(&path)?;
                (
                    recovered.snapshot,
                    recovered.report,
                    recovered.replayed_record_count,
                    recovered.last_command,
                )
            } else {
                return Err(error(VideoErrorCode::UnsupportedSchema, "schema_version"));
            };
        validate_snapshot(&snapshot)?;
        let idempotency = load_idempotency(&path)?;
        let (sources, relative_grants) =
            resolve_project_asset_sources(owner, &path, &snapshot.state.assets, grants)?;
        grants.grant_opened_project_sources(owner, path.clone(), relative_grants)?;
        let recovery_status = recovery_report.status.clone();
        let snapshot_revision = snapshot
            .revision
            .number
            .saturating_sub(replayed_record_count);
        let projection = self.insert_session(ProjectSession {
            owner: owner.to_owned(),
            path,
            _lock_file: lock_file,
            snapshot,
            sources,
            journal_health: JournalHealth::Healthy,
            snapshot_revision,
            recovery_status,
            replayed_record_count,
            last_command,
            idempotency,
        })?;
        Ok(OpenedProjectV2 {
            projection,
            recovery: recovery_report,
        })
    }

    fn finish_transition(
        session: &mut ProjectSession,
        mut transition: HistoryTransition,
        sources: Vec<VideoSourceRecord>,
        payload_hash: String,
    ) -> Result<CommandResult, VideoCommandError> {
        let record_number = session
            .snapshot
            .last_applied_record_number
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| error(VideoErrorCode::StorageLimit, "record_number"))?;
        transition.snapshot.last_applied_record_number = record_number;
        let summary = transition_summary(&transition.kind, &transition.history_group.summary);
        let last_command = LastCommandMetadata {
            operation_id: transition.operation_id.clone(),
            group_id: transition.group_id.clone(),
            summary,
        };
        let events = vec![
            ProjectEvent::ProjectChanged {
                project_id: transition.snapshot.id.clone(),
                revision: transition.snapshot.revision.number,
            },
            ProjectEvent::HistoryChanged {
                can_undo: !transition.snapshot.history.undo_stack.is_empty(),
                can_redo: !transition.snapshot.history.redo_stack.is_empty(),
            },
        ];
        let mut result = CommandResult {
            project_id: transition.snapshot.id.clone(),
            operation_id: transition.operation_id.clone(),
            group_id: transition.group_id.clone(),
            prior_revision: transition.prior_revision.clone(),
            new_revision: transition.snapshot.revision.clone(),
            state_hash: transition.snapshot.revision.state_hash.clone(),
            projection: ProjectProjection {
                project_id: transition.snapshot.id.clone(),
                name: transition.snapshot.name.clone(),
                revision: transition.snapshot.revision.clone(),
                state: transition.snapshot.state.clone(),
                can_undo: !transition.snapshot.history.undo_stack.is_empty(),
                can_redo: !transition.snapshot.history.redo_stack.is_empty(),
                last_command: Some(last_command.clone()),
                sources: sources.clone(),
                journal_health: session.journal_health.clone(),
                snapshot_revision: session.snapshot_revision,
                recovery_status: session.recovery_status.clone(),
                replayed_record_count: session.replayed_record_count,
            },
            affected_ranges: transition.applied.affected_ranges.clone(),
            cache_invalidations: transition.applied.cache_invalidations.clone(),
            events,
        };
        let record = record_for_transition(
            &transition,
            payload_hash,
            result.clone(),
            session.snapshot.last_record_hash.clone(),
            record_number,
        );
        let durable_record = append_and_sync(&journal_path(&session.path)?, &record)?;
        transition.snapshot.last_record_hash = durable_record.record_hash;
        session.snapshot = transition.snapshot;
        session.sources = sources;
        session.last_command = Some(last_command);
        if record_number % CHECKPOINT_INTERVAL == 0 {
            if checkpoint(&session.path, &session.snapshot).is_ok() {
                session.snapshot_revision = session.snapshot.revision.number;
                session.journal_health = JournalHealth::Healthy;
            } else {
                session.journal_health = JournalHealth::SnapshotPending;
                result.events.push(ProjectEvent::SnapshotWarning {
                    message:
                        "Edit is durable in the journal, but snapshot checkpointing is pending"
                            .to_owned(),
                });
            }
        }
        result.projection.journal_health = session.journal_health.clone();
        result.projection.snapshot_revision = session.snapshot_revision;
        Ok(result)
    }

    pub fn existing_group_result(
        &self,
        owner: &str,
        request: &CommandGroupRequest,
    ) -> Result<Option<CommandResult>, VideoCommandError> {
        if super::hash::canonical_bytes(request)?.len() > MAX_COMMAND_GROUP_BYTES {
            return Err(error(VideoErrorCode::StorageLimit, "command_group_bytes"));
        }
        let session = self.session(owner, &request.project_id)?;
        let session = session
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "project_mutex"))?;
        let Some(existing) = session.idempotency.get(&request.group_id) else {
            return Ok(None);
        };
        reject_duplicate_conflict(&existing.payload_hash, request)?;
        Ok(Some(existing.result.clone()))
    }

    pub fn execute(
        &self,
        owner: &str,
        request: CommandGroupRequest,
        grants: &VideoPathGrants,
    ) -> Result<CommandResult, VideoCommandError> {
        if super::hash::canonical_bytes(&request)?.len() > MAX_COMMAND_GROUP_BYTES {
            return Err(error(VideoErrorCode::StorageLimit, "command_group_bytes"));
        }
        let session = self.session(owner, &request.project_id)?;
        let mut session = session
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "project_mutex"))?;
        let payload_hash = command_group_payload_hash(&request)?;
        if let Some(existing) = session.idempotency.get(&request.group_id) {
            reject_duplicate_conflict(&existing.payload_hash, &request)?;
            return Ok(existing.result.clone());
        }
        validate_gateway_paths(owner, &request.commands, grants)?;
        let transition = commit_transition(&session.snapshot, &request, &now())?;
        let (sources, relative_grants) = resolve_project_asset_sources(
            owner,
            &session.path,
            &transition.snapshot.state.assets,
            grants,
        )?;
        grants.grant_opened_project_sources(owner, session.path.clone(), relative_grants)?;
        let result =
            Self::finish_transition(&mut session, transition, sources, payload_hash.clone())?;
        session.idempotency.insert(
            request.group_id,
            IdempotencyEntry {
                payload_hash,
                result: result.clone(),
            },
        );
        Ok(result)
    }

    fn history_operation(
        &self,
        owner: &str,
        project_id: &str,
        base_revision: u64,
        operation_id: &str,
        redo: bool,
        grants: &VideoPathGrants,
    ) -> Result<CommandResult, VideoCommandError> {
        if !is_canonical_uuid(operation_id) {
            return Err(error(VideoErrorCode::InvalidCommand, "operation_id"));
        }
        let session = self.session(owner, project_id)?;
        let mut session = session
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "project_mutex"))?;
        let payload_hash = canonical_hash(
            &json!({ "projectId": project_id, "baseRevision": base_revision, "operationId": operation_id, "redo": redo }),
        )?;
        if let Some(existing) = session.idempotency.get(operation_id) {
            if existing.payload_hash == payload_hash {
                return Ok(existing.result.clone());
            }
            return Err(error(
                VideoErrorCode::DuplicateConflict,
                "operation_id_reuse",
            ));
        }
        let transition = if redo {
            redo_transition(&session.snapshot, base_revision, operation_id, &now())?
        } else {
            undo_transition(&session.snapshot, base_revision, operation_id, &now())?
        };
        let (sources, relative_grants) = resolve_project_asset_sources(
            owner,
            &session.path,
            &transition.snapshot.state.assets,
            grants,
        )?;
        grants.grant_opened_project_sources(owner, session.path.clone(), relative_grants)?;
        let result =
            Self::finish_transition(&mut session, transition, sources, payload_hash.clone())?;
        session.idempotency.insert(
            operation_id.to_owned(),
            IdempotencyEntry {
                payload_hash,
                result: result.clone(),
            },
        );
        Ok(result)
    }

    pub fn undo(
        &self,
        owner: &str,
        project_id: &str,
        base_revision: u64,
        operation_id: &str,
        grants: &VideoPathGrants,
    ) -> Result<CommandResult, VideoCommandError> {
        self.history_operation(
            owner,
            project_id,
            base_revision,
            operation_id,
            false,
            grants,
        )
    }
    pub fn redo(
        &self,
        owner: &str,
        project_id: &str,
        base_revision: u64,
        operation_id: &str,
        grants: &VideoPathGrants,
    ) -> Result<CommandResult, VideoCommandError> {
        self.history_operation(owner, project_id, base_revision, operation_id, true, grants)
    }

    pub fn relink(
        &self,
        owner: &str,
        project_id: &str,
        asset_id: &str,
        locator: AssetLocator,
        probe: MediaProbe,
        grants: &VideoPathGrants,
    ) -> Result<CommandResult, VideoCommandError> {
        let session = self.session(owner, project_id)?;
        let base_revision = session
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "project_mutex"))?
            .snapshot
            .revision
            .number;
        let request = CommandGroupRequest {
            group_id: new_id(),
            project_id: project_id.to_owned(),
            base_revision,
            commands: vec![ProjectCommand::RelinkAsset {
                command_id: new_id(),
                asset_id: asset_id.to_owned(),
                locator,
                probe,
            }],
        };
        self.execute(owner, request, grants)
    }

    pub fn inspector(
        &self,
        owner: &str,
        project_id: &str,
    ) -> Result<ProjectInspector, VideoCommandError> {
        let session = self.session(owner, project_id)?;
        let session = session
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "project_mutex"))?;
        Ok(ProjectInspector {
            project_id: project_id.to_owned(),
            revision: session.snapshot.revision.clone(),
            last_command: session.last_command.clone(),
            snapshot_revision: session.snapshot_revision,
            journal_health: session.journal_health.clone(),
            replayed_record_count: session.replayed_record_count,
            recovery_status: session.recovery_status.clone(),
        })
    }

    pub fn close(&self, owner: &str, project_id: &str) -> Result<(), VideoCommandError> {
        let key = session_key(owner, project_id);
        let session = self
            .sessions
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "session_lock"))?
            .remove(&key)
            .ok_or_else(|| error(VideoErrorCode::InvalidProject, "unknown_session"))?;
        let session = session
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "project_mutex"))?;
        checkpoint(&session.path, &session.snapshot)
    }

    pub fn close_owner(&self, owner: &str) -> Result<(), VideoCommandError> {
        let project_ids = self
            .sessions
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "session_lock"))?
            .values()
            .filter_map(|session| {
                session
                    .lock()
                    .ok()
                    .filter(|session| session.owner == owner)
                    .map(|session| session.snapshot.id.clone())
            })
            .collect::<Vec<_>>();
        for project_id in project_ids {
            self.close(owner, &project_id)?;
        }
        Ok(())
    }

    pub fn close_all(&self) -> Result<(), VideoCommandError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| error(VideoErrorCode::ProjectIo, "session_lock"))?
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in sessions {
            let session = session
                .lock()
                .map_err(|_| error(VideoErrorCode::ProjectIo, "project_mutex"))?;
            let _ = checkpoint(&session.path, &session.snapshot);
        }
        Ok(())
    }
}
