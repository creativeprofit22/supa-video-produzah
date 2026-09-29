//! Agent/rule edit proposals: native validation, durable pending store and audit.
//!
//! A proposal is produced and reviewed in the UI, but the native side is the
//! authority: it re-validates the proposal against the open project before
//! storing or applying it, and keeps pending proposals in a sidecar file so a
//! restart during review does not lose them.

use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::NamedTempFile;

use super::{
    commands::locked_mutation_target,
    hash::{canonical_bytes, canonical_hash},
    integrity::is_canonical_uuid,
    journal::sidecar_path,
    types::{
        CommandGroupRequest, ProjectCommand, ProjectRevisionDescriptorV2, VideoProjectSnapshotV2,
        MAX_COMMAND_GROUP_BYTES,
    },
};
use crate::video::error::{VideoCommandError, VideoErrorCode};
use crate::video::types::RationalTime;

pub const PROPOSAL_STORE_FILE: &str = "proposals.json";
pub const MAX_OPEN_PROPOSALS: usize = 64;
pub const MAX_RESOLVED_PROPOSALS: usize = 64;
pub const MAX_AUDIT_ENTRIES: usize = 500;
pub const MAX_PROPOSAL_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PROPOSAL_STORE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PARAMETERS: usize = 32;
/// Matches `defaultProposalPolicy.maxRevisionDrift` in `@supa-video/project`.
pub const MAX_REVISION_DRIFT: u64 = 20;

fn error(code: VideoErrorCode, category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        code,
        "Edit proposal was rejected",
        "project_proposal",
        category,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalProducerKind {
    User,
    Rule,
    Model,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalProducer {
    pub id: String,
    pub version: String,
    pub kind: ProposalProducerKind,
    pub parameters: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalTimelineRange {
    pub start: RationalTime,
    pub end: RationalTime,
}

/// The parts of a deleted range native code checks; other fields pass through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDeletedRange {
    pub clip_id: String,
    pub asset_id: String,
    pub source_range: ProposalTimelineRange,
    pub original_timeline_range: ProposalTimelineRange,
}

impl ProposalDeletedRange {
    /// Matches `rangeIdOf` in `@supa-video/project`. It names the clip that was
    /// cut, so the audit trail records what the applied group really touched.
    /// Offer checks use `ranges_are_offered`, not this id.
    pub fn range_id(&self) -> String {
        format!(
            "{}:{}:{}",
            self.clip_id, self.source_range.start.value, self.source_range.end.value
        )
    }
}

/// `a < b` for times that may use different rates (exact, no rounding).
/// `None` when either rate is invalid.
fn time_less(a: &RationalTime, b: &RationalTime) -> Option<bool> {
    if a.rate_numerator == 0
        || a.rate_denominator == 0
        || b.rate_numerator == 0
        || b.rate_denominator == 0
    {
        return None;
    }
    // a.value * a.den / a.num < b.value * b.den / b.num
    let left = u128::from(a.value) * u128::from(a.rate_denominator) * u128::from(b.rate_numerator);
    let right = u128::from(b.value) * u128::from(b.rate_denominator) * u128::from(a.rate_numerator);
    Some(left < right)
}

/// Content-based offer check: every approved cut must lie inside the union of
/// the offered cuts for the same asset, whatever clip now holds those source
/// frames. A repair after an unrelated edit (a split elsewhere in the clip)
/// gives the words a new clip id but not new source bounds.
pub fn ranges_are_offered(
    offered: &[ProposalDeletedRange],
    approved: &[ProposalDeletedRange],
) -> bool {
    approved.iter().all(|range| {
        let end = &range.source_range.end;
        if time_less(&range.source_range.start, end) != Some(true) {
            return false;
        }
        // Advance a cursor from the start across offered ranges that cover it.
        let mut cursor = range.source_range.start.clone();
        while time_less(&cursor, end) == Some(true) {
            let mut furthest: Option<&RationalTime> = None;
            for candidate in offered.iter().filter(|c| c.asset_id == range.asset_id) {
                let covers = time_less(&candidate.source_range.start, &cursor).is_some()
                    && time_less(&cursor, &candidate.source_range.start) == Some(false)
                    && time_less(&cursor, &candidate.source_range.end) == Some(true);
                if covers
                    && furthest.is_none_or(|best| {
                        time_less(best, &candidate.source_range.end) == Some(true)
                    })
                {
                    furthest = Some(&candidate.source_range.end);
                }
            }
            match furthest {
                Some(next) => cursor = next.clone(),
                None => return false,
            }
        }
        true
    })
}

/// Typed view over the proposal JSON produced by `@supa-video/project`.
/// Only schema v2 is accepted natively; the UI upgrades v1 before sending.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub schema_version: u8,
    pub proposal_id: String,
    pub project_id: String,
    pub project_revision: ProjectRevisionDescriptorV2,
    pub sequence_id: String,
    pub track_id: String,
    pub producer: ProposalProducer,
    pub deleted_ranges: Vec<ProposalDeletedRange>,
    pub command_group: CommandGroupRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeProposalStatus {
    Pending,
    Applied,
    Rejected,
    Expired,
    Stale,
    Restored,
}

impl NativeProposalStatus {
    pub fn is_open(self) -> bool {
        self == Self::Pending
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredProposal {
    pub proposal_id: String,
    pub producer: ProposalProducer,
    pub sequence_id: String,
    pub track_id: String,
    pub base_revision: ProjectRevisionDescriptorV2,
    pub status: NativeProposalStatus,
    pub status_reason: Option<String>,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    /// Group id of the commit that applied this proposal, once applied.
    pub applied_group_id: Option<String>,
    /// Revision and state the project had just before the proposal was applied.
    pub pre_apply_revision: Option<ProjectRevisionDescriptorV2>,
    /// Range ids the user approved when it was applied.
    #[serde(default)]
    pub approved_range_ids: Vec<String>,
    /// Operation id and step count of a "restore to before proposal", for retries.
    #[serde(default)]
    pub restore_operation_id: Option<String>,
    #[serde(default)]
    pub restore_steps: u64,
    /// Full proposal JSON as produced by the UI, validated on insert.
    pub proposal: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalAuditAction {
    Applied,
    Rejected,
    Expired,
    Stale,
    Restored,
}

/// Durable record of what happened to a proposal. Apply audits are also
/// written inside the journal commit record, atomically with the cut.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalAudit {
    pub action: ProposalAuditAction,
    pub proposal_id: String,
    /// Id of the proposal actually committed (differs after partial re-derivation).
    pub applied_proposal_id: Option<String>,
    pub producer: ProposalProducer,
    pub approved_range_ids: Vec<String>,
    pub base_revision: u64,
    pub resulting_revision: Option<u64>,
    pub affected_ranges: Vec<ProposalTimelineRange>,
    pub at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalStoreV1 {
    pub schema_version: u8,
    pub project_id: String,
    pub proposals: Vec<StoredProposal>,
    pub audit: Vec<ProposalAudit>,
    pub store_hash: String,
}

impl ProposalStoreV1 {
    pub fn empty(project_id: &str) -> Self {
        Self {
            schema_version: 1,
            project_id: project_id.to_owned(),
            proposals: Vec::new(),
            audit: Vec::new(),
            store_hash: String::new(),
        }
    }

    pub fn find(&self, proposal_id: &str) -> Option<&StoredProposal> {
        self.proposals
            .iter()
            .find(|proposal| proposal.proposal_id == proposal_id)
    }

    pub fn find_mut(&mut self, proposal_id: &str) -> Option<&mut StoredProposal> {
        self.proposals
            .iter_mut()
            .find(|proposal| proposal.proposal_id == proposal_id)
    }

    /// Appends an audit entry, dropping the oldest beyond the bound.
    pub fn push_audit(&mut self, entry: ProposalAudit) {
        self.audit.push(entry);
        let excess = self.audit.len().saturating_sub(MAX_AUDIT_ENTRIES);
        self.audit.drain(..excess);
    }

    pub fn open_count(&self) -> usize {
        self.proposals
            .iter()
            .filter(|proposal| proposal.status.is_open())
            .count()
    }

    /// Keeps at most `MAX_RESOLVED_PROPOSALS` resolved proposals, dropping the
    /// oldest first (they stay in insertion order); open ones always stay.
    fn prune_resolved(&mut self) {
        let resolved = self.proposals.len() - self.open_count();
        let mut excess = resolved.saturating_sub(MAX_RESOLVED_PROPOSALS);
        self.proposals.retain(|proposal| {
            if excess > 0 && !proposal.status.is_open() {
                excess -= 1;
                return false;
            }
            true
        });
    }
}

pub fn proposal_store_path(project_path: &Path) -> Result<PathBuf, VideoCommandError> {
    Ok(sidecar_path(project_path)?.join(PROPOSAL_STORE_FILE))
}

fn with_store_hash(store: &ProposalStoreV1) -> Result<ProposalStoreV1, VideoCommandError> {
    let mut candidate = store.clone();
    candidate.store_hash.clear();
    candidate.store_hash = canonical_hash(&candidate)?;
    Ok(candidate)
}

/// Outcome of loading the store: `discarded` is true when an unreadable or
/// tampered store was moved aside and an empty one started.
#[derive(Debug)]
pub struct LoadedProposalStore {
    pub store: ProposalStoreV1,
    pub discarded: bool,
}

pub fn load_proposal_store(
    project_path: &Path,
    project_id: &str,
) -> Result<LoadedProposalStore, VideoCommandError> {
    let path = proposal_store_path(project_path)?;
    let bytes = match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_PROPOSAL_STORE_BYTES => None,
        Ok(_) => Some(fs::read(&path).map_err(|_| error(VideoErrorCode::ProjectIo, "store_read"))?),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LoadedProposalStore {
                store: ProposalStoreV1::empty(project_id),
                discarded: false,
            })
        }
        Err(_) => return Err(error(VideoErrorCode::ProjectIo, "store_metadata")),
    };
    let parsed = bytes
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<ProposalStoreV1>(bytes).ok())
        .filter(|store| {
            store.schema_version == 1
                && store.project_id == project_id
                && with_store_hash(store).is_ok_and(|hashed| hashed.store_hash == store.store_hash)
        });
    match parsed {
        Some(store) => Ok(LoadedProposalStore {
            store,
            discarded: false,
        }),
        None => {
            // Keep the bad file for inspection; proposals are advisory, so the
            // project still opens with an empty store.
            let quarantine = path.with_extension("rejected.json");
            fs::rename(&path, quarantine)
                .map_err(|_| error(VideoErrorCode::ProjectIo, "store_quarantine"))?;
            Ok(LoadedProposalStore {
                store: ProposalStoreV1::empty(project_id),
                discarded: true,
            })
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum StoreWriteFailpoint {
    #[default]
    None,
    BeforeReplace,
}

/// Atomically replaces the store: synced temp file, then rename.
pub fn save_proposal_store(
    project_path: &Path,
    store: &mut ProposalStoreV1,
    failpoint: StoreWriteFailpoint,
) -> Result<(), VideoCommandError> {
    store.prune_resolved();
    let hashed = with_store_hash(store)?;
    let mut bytes = canonical_bytes(&hashed)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_PROPOSAL_STORE_BYTES {
        return Err(error(VideoErrorCode::StorageLimit, "store_bytes"));
    }
    let sidecar = sidecar_path(project_path)?;
    fs::create_dir_all(&sidecar).map_err(|_| error(VideoErrorCode::ProjectIo, "store_dir"))?;
    let mut temporary = NamedTempFile::new_in(&sidecar)
        .map_err(|_| error(VideoErrorCode::ProjectIo, "store_temp"))?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.flush())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| error(VideoErrorCode::ProjectIo, "store_sync"))?;
    if failpoint == StoreWriteFailpoint::BeforeReplace {
        return Err(error(
            VideoErrorCode::ProjectIo,
            "failpoint_store_before_replace",
        ));
    }
    temporary
        .persist(proposal_store_path(project_path)?)
        .map_err(|_| error(VideoErrorCode::ProjectIo, "store_promote"))?;
    store.store_hash = hashed.store_hash;
    Ok(())
}

fn valid_producer(producer: &ProposalProducer) -> bool {
    let id_ok = !producer.id.is_empty()
        && producer.id.len() <= 64
        && producer.id.starts_with(|c: char| c.is_ascii_lowercase())
        && producer
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let version_ok = !producer.version.is_empty()
        && producer.version.len() <= 32
        && producer
            .version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'));
    let parameters_ok = producer.parameters.len() <= MAX_PARAMETERS
        && producer.parameters.iter().all(|(key, value)| {
            key.len() <= 64
                && match value {
                    Value::String(text) => text.len() <= 256,
                    Value::Number(_) | Value::Bool(_) => true,
                    Value::Array(items) => {
                        items.len() <= 256
                            && items
                                .iter()
                                .all(|item| item.as_str().is_some_and(|text| text.len() <= 64))
                    }
                    _ => false,
                }
        });
    id_ok && version_ok && parameters_ok
}

/// Commands a transcript cut proposal may contain.
fn allowed_command(command: &ProjectCommand) -> bool {
    matches!(
        command,
        ProjectCommand::SplitClip { .. }
            | ProjectCommand::RippleDeleteClip { .. }
            | ProjectCommand::ApplyCaptionArtifact { .. }
    )
}

/// Parses and validates an untrusted proposal against the open project:
/// schema, ids, producer, base revision, command policy and locked tracks.
pub fn validate_proposal(
    value: &Value,
    snapshot: &VideoProjectSnapshotV2,
) -> Result<ProposalView, VideoCommandError> {
    if canonical_bytes(value)?.len() > MAX_PROPOSAL_BYTES {
        return Err(error(VideoErrorCode::StorageLimit, "proposal_bytes"));
    }
    let view: ProposalView = serde_json::from_value(value.clone())
        .map_err(|_| error(VideoErrorCode::InvalidCommand, "proposal_schema"))?;
    if view.schema_version != 2 {
        return Err(error(
            VideoErrorCode::UnsupportedSchema,
            "proposal_schema_version",
        ));
    }
    if !is_canonical_uuid(&view.proposal_id)
        || !is_canonical_uuid(&view.command_group.group_id)
        || !is_canonical_uuid(&view.sequence_id)
        || !is_canonical_uuid(&view.track_id)
    {
        return Err(error(VideoErrorCode::InvalidCommand, "proposal_ids"));
    }
    if !valid_producer(&view.producer) {
        return Err(error(VideoErrorCode::InvalidCommand, "proposal_producer"));
    }
    if view.project_id != snapshot.id || view.command_group.project_id != snapshot.id {
        return Err(error(VideoErrorCode::InvalidCommand, "proposal_project"));
    }
    if view.project_revision != snapshot.revision
        || view.command_group.base_revision != snapshot.revision.number
    {
        return Err(error(
            VideoErrorCode::StaleRevision,
            "proposal_base_revision",
        ));
    }
    if view.deleted_ranges.is_empty()
        || view.command_group.commands.is_empty()
        || canonical_bytes(&view.command_group)?.len() > MAX_COMMAND_GROUP_BYTES
    {
        return Err(error(VideoErrorCode::InvalidCommand, "proposal_empty"));
    }
    let sequence = snapshot
        .state
        .sequences
        .iter()
        .find(|sequence| sequence.id == view.sequence_id)
        .ok_or_else(|| error(VideoErrorCode::InvalidCommand, "proposal_sequence"))?;
    if !sequence
        .tracks
        .iter()
        .any(|track| track.id() == view.track_id)
    {
        return Err(error(VideoErrorCode::InvalidCommand, "proposal_track"));
    }
    for command in &view.command_group.commands {
        if !allowed_command(command) {
            return Err(error(
                VideoErrorCode::InvalidCommand,
                "proposal_command_policy",
            ));
        }
        let Some((sequence_id, track_id)) = locked_mutation_target(command) else {
            return Err(error(
                VideoErrorCode::InvalidCommand,
                "proposal_command_policy",
            ));
        };
        if sequence_id != view.sequence_id {
            return Err(error(
                VideoErrorCode::InvalidCommand,
                "proposal_command_scope",
            ));
        }
        let is_clip_edit = !matches!(command, ProjectCommand::ApplyCaptionArtifact { .. });
        if is_clip_edit && track_id != view.track_id {
            return Err(error(
                VideoErrorCode::InvalidCommand,
                "proposal_command_scope",
            ));
        }
        let track = sequence
            .tracks
            .iter()
            .find(|track| track.id() == track_id)
            .ok_or_else(|| error(VideoErrorCode::InvalidCommand, "proposal_command_track"))?;
        if track.is_locked() {
            return Err(error(
                VideoErrorCode::InvalidCommand,
                "proposal_track_locked",
            ));
        }
    }
    Ok(view)
}

/// Expires timed-out proposals and ones the project has moved too far past,
/// and marks stale those whose base is no longer in the project's past (history
/// went backwards or diverged). Returns the audit entries it generated.
pub fn refresh_open_proposals(
    store: &mut ProposalStoreV1,
    revision: &ProjectRevisionDescriptorV2,
    now_ms: u64,
) -> Vec<ProposalAudit> {
    let mut audits = Vec::new();
    for proposal in store.proposals.iter_mut().filter(|p| p.status.is_open()) {
        let base = &proposal.base_revision;
        let (status, action, reason) = if now_ms >= proposal.expires_at_ms {
            (
                NativeProposalStatus::Expired,
                ProposalAuditAction::Expired,
                "Proposal timed out",
            )
        } else if revision.number < base.number
            || (revision.number == base.number && revision != base)
        {
            (
                NativeProposalStatus::Stale,
                ProposalAuditAction::Stale,
                "Project history no longer contains the proposal base",
            )
        } else if revision.number - base.number > MAX_REVISION_DRIFT {
            (
                NativeProposalStatus::Expired,
                ProposalAuditAction::Expired,
                "Project changed too much since the proposal",
            )
        } else {
            continue;
        };
        proposal.status = status;
        proposal.status_reason = Some(reason.to_owned());
        audits.push(ProposalAudit {
            action,
            proposal_id: proposal.proposal_id.clone(),
            applied_proposal_id: None,
            producer: proposal.producer.clone(),
            approved_range_ids: Vec::new(),
            base_revision: proposal.base_revision.number,
            resulting_revision: None,
            affected_ranges: Vec::new(),
            at_ms: now_ms,
        });
    }
    for audit in &audits {
        store.push_audit(audit.clone());
    }
    audits
}

/// A proposal commit found in the journal during recovery.
#[derive(Debug, Clone)]
pub struct JournalProposalCommit {
    pub group_id: String,
    pub base_revision: ProjectRevisionDescriptorV2,
    pub audit: ProposalAudit,
}

/// Settles open proposals the journal shows as applied: a crash between the
/// journal append and the store write. Returns how many were settled.
pub fn reconcile_with_journal(
    store: &mut ProposalStoreV1,
    commits: &[JournalProposalCommit],
) -> usize {
    let mut settled = 0;
    for commit in commits {
        let Some(proposal) = store.find_mut(&commit.audit.proposal_id) else {
            continue;
        };
        if proposal.status.is_open() {
            proposal.status = NativeProposalStatus::Applied;
            proposal.status_reason = Some("Recovered from the project journal".to_owned());
            proposal.applied_group_id = Some(commit.group_id.clone());
            proposal.pre_apply_revision = Some(commit.base_revision.clone());
            proposal.approved_range_ids = commit.audit.approved_range_ids.clone();
            settled += 1;
            if !store.audit.contains(&commit.audit) {
                store.push_audit(commit.audit.clone());
            }
        }
    }
    settled
}

pub fn affected_ranges(view: &ProposalView) -> Vec<ProposalTimelineRange> {
    view.deleted_ranges
        .iter()
        .map(|range| range.original_timeline_range.clone())
        .collect()
}
