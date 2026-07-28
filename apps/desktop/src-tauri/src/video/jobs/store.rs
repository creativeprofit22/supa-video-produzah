use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use super::model::{
    MediaJobError, MediaJobErrorCategory, MediaJobEvent, MediaJobEventType, MediaJobKind,
    MediaJobModelError, MediaJobPriority, MediaJobProgress, MediaJobRecord, MediaJobRecoveryAction,
    MediaJobRecoveryReport, MediaJobState, MAX_PRIVATE_JSON_BYTES, MAX_PUBLIC_EVENTS,
    MAX_PUBLIC_JOBS, MAX_RETAINED_EVENTS, MAX_RETAINED_SETTLED_JOBS, MAX_UNSETTLED_JOBS,
    MEDIA_JOB_SCHEMA_VERSION,
};

pub(crate) const MEDIA_STATE_FILENAME: &str = "media-state-v1.sqlite3";
pub(crate) const MEDIA_STATE_SCHEMA_VERSION: i64 = 1;
pub(crate) const DEFAULT_CACHE_BUDGET_BYTES: i64 = 20 * 1024 * 1024 * 1024;
const MEDIA_STATE_APPLICATION_ID: i64 = 0x5356_504A;
const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Error)]
pub(crate) enum MediaStateStoreError {
    #[error("media state directory is not a regular directory")]
    UnsafeDirectory,
    #[error("media state schema version {0} is newer than this application supports")]
    UnsupportedSchema(i64),
    #[error("media state database belongs to another application")]
    ForeignDatabase,
    #[error("media state database failed its integrity check")]
    Integrity,
    #[error("media state record is invalid")]
    CorruptRecord,
    #[error("media job limit reached")]
    JobLimit,
    #[error("media job was not found")]
    NotFound,
    #[error("media job transition is invalid")]
    InvalidTransition,
    #[error("media state payload exceeds its size limit")]
    PayloadTooLarge,
    #[error("media state worker stopped")]
    WorkerStopped,
    #[error("media state lock was poisoned")]
    LockPoisoned,
    #[error("media state model validation failed")]
    Model(#[from] MediaJobModelError),
    #[error("media state JSON operation failed")]
    Json(#[from] serde_json::Error),
    #[error("media state filesystem operation failed")]
    Io(#[from] std::io::Error),
    #[error("media state database operation failed")]
    Sqlite(#[from] rusqlite::Error),
}

#[derive(Clone, Debug)]
pub(crate) struct MediaStateStore {
    path: PathBuf,
}

impl MediaStateStore {
    pub(crate) fn initialize(local_data_dir: &Path) -> Result<Self, MediaStateStoreError> {
        ensure_local_data_directory(local_data_dir)?;
        let store = Self {
            path: local_data_dir.join(MEDIA_STATE_FILENAME),
        };
        let mut connection = store.open_connection()?;
        migrate(&mut connection)?;
        verify_integrity(&connection)?;
        Ok(store)
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn open_connection(&self) -> Result<Connection, MediaStateStoreError> {
        let connection = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        configure_connection(&connection)?;
        Ok(connection)
    }
}

fn ensure_local_data_directory(path: &Path) -> Result<(), MediaStateStoreError> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(MediaStateStoreError::UnsafeDirectory);
        }
    } else {
        fs::create_dir_all(path)?;
    }
    Ok(())
}

fn configure_connection(connection: &Connection) -> Result<(), MediaStateStoreError> {
    connection.busy_timeout(DATABASE_BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "wal_autocheckpoint", 1_000_i64)?;
    Ok(())
}

fn migrate(connection: &mut Connection) -> Result<(), MediaStateStoreError> {
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != 0 && application_id != MEDIA_STATE_APPLICATION_ID {
        return Err(MediaStateStoreError::ForeignDatabase);
    }

    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > MEDIA_STATE_SCHEMA_VERSION {
        return Err(MediaStateStoreError::UnsupportedSchema(version));
    }
    if version == MEDIA_STATE_SCHEMA_VERSION {
        return Ok(());
    }

    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE media_jobs (
            id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
            schema_version INTEGER NOT NULL CHECK(schema_version = 1),
            kind TEXT NOT NULL CHECK(kind IN ('asset_preparation', 'proxy', 'thumbnail_tile', 'final_render')),
            parent_id TEXT REFERENCES media_jobs(id) ON DELETE CASCADE,
            dedupe_key TEXT NOT NULL CHECK(length(dedupe_key) BETWEEN 1 AND 512),
            project_id TEXT CHECK(project_id IS NULL OR length(project_id) BETWEEN 1 AND 64),
            asset_id TEXT CHECK(asset_id IS NULL OR length(asset_id) BETWEEN 1 AND 64),
            revision_id TEXT CHECK(revision_id IS NULL OR length(revision_id) BETWEEN 1 AND 128),
            priority_class TEXT NOT NULL CHECK(priority_class IN ('interactive', 'export', 'background')),
            priority_value INTEGER NOT NULL CHECK(priority_value BETWEEN 0 AND 1000),
            state TEXT NOT NULL CHECK(state IN ('queued', 'probing', 'running', 'blocked', 'retrying', 'cancelled', 'failed', 'complete')),
            stage TEXT NOT NULL CHECK(length(stage) BETWEEN 1 AND 64),
            progress_completed INTEGER NOT NULL CHECK(progress_completed >= 0),
            progress_total INTEGER NOT NULL CHECK(progress_total >= 0),
            progress_unit TEXT NOT NULL CHECK(progress_unit IN ('items', 'bytes', 'frames', 'microseconds', 'stages')),
            attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 100),
            max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 100),
            safe_summary TEXT NOT NULL CHECK(length(safe_summary) BETWEEN 1 AND 512),
            payload_version INTEGER NOT NULL CHECK(payload_version >= 1),
            private_payload_json TEXT NOT NULL CHECK(length(private_payload_json) <= 1048576),
            result_version INTEGER CHECK(result_version IS NULL OR result_version >= 1),
            result_json TEXT CHECK(result_json IS NULL OR length(result_json) <= 1048576),
            error_code TEXT CHECK(error_code IS NULL OR length(error_code) <= 64),
            error_category TEXT CHECK(error_category IS NULL OR length(error_category) <= 64),
            error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 512),
            error_retryable INTEGER CHECK(error_retryable IS NULL OR error_retryable IN (0, 1)),
            error_action TEXT CHECK(error_action IS NULL OR length(error_action) <= 64),
            retry_at_ms INTEGER CHECK(retry_at_ms IS NULL OR retry_at_ms >= 0),
            created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
            updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
            started_at_ms INTEGER CHECK(started_at_ms IS NULL OR started_at_ms >= created_at_ms),
            settled_at_ms INTEGER CHECK(settled_at_ms IS NULL OR settled_at_ms >= created_at_ms),
            cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancellation_requested IN (0, 1)),
            CHECK(progress_completed <= progress_total OR progress_total = 0)
        ) STRICT;

        CREATE INDEX media_jobs_parent_idx ON media_jobs(parent_id, created_at_ms, id);
        CREATE INDEX media_jobs_state_queue_idx ON media_jobs(state, priority_class, retry_at_ms, created_at_ms, id);
        CREATE INDEX media_jobs_recent_idx ON media_jobs(updated_at_ms DESC, id DESC);
        CREATE UNIQUE INDEX media_jobs_unsettled_dedupe_idx ON media_jobs(dedupe_key)
            WHERE state NOT IN ('cancelled', 'failed', 'complete');

        CREATE TABLE media_job_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 64),
            state TEXT NOT NULL CHECK(state IN ('queued', 'probing', 'running', 'blocked', 'retrying', 'cancelled', 'failed', 'complete')),
            stage TEXT NOT NULL CHECK(length(stage) BETWEEN 1 AND 64),
            progress_completed INTEGER NOT NULL CHECK(progress_completed >= 0),
            progress_total INTEGER NOT NULL CHECK(progress_total >= 0),
            progress_unit TEXT NOT NULL CHECK(progress_unit IN ('items', 'bytes', 'frames', 'microseconds', 'stages')),
            safe_message TEXT CHECK(safe_message IS NULL OR length(safe_message) <= 1024),
            category TEXT CHECK(category IS NULL OR length(category) <= 64),
            created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
            CHECK(progress_completed <= progress_total OR progress_total = 0)
        ) STRICT;

        CREATE INDEX media_job_events_job_idx ON media_job_events(job_id, event_id);
        CREATE INDEX media_job_events_created_idx ON media_job_events(created_at_ms, event_id);

        CREATE TABLE cache_artifacts (
            artifact_key TEXT PRIMARY KEY NOT NULL CHECK(length(artifact_key) BETWEEN 1 AND 256),
            content_digest TEXT NOT NULL CHECK(length(content_digest) BETWEEN 1 AND 128),
            kind TEXT NOT NULL CHECK(kind IN ('source_object', 'proxy', 'thumbnail_tile')),
            relative_path TEXT NOT NULL UNIQUE CHECK(length(relative_path) BETWEEN 1 AND 1024),
            byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
            profile_id TEXT CHECK(profile_id IS NULL OR length(profile_id) <= 256),
            toolchain_id TEXT CHECK(toolchain_id IS NULL OR length(toolchain_id) <= 256),
            recipe_id TEXT CHECK(recipe_id IS NULL OR length(recipe_id) <= 256),
            availability TEXT NOT NULL CHECK(availability IN ('available', 'reserved', 'missing', 'invalid')),
            last_verified_at_ms INTEGER NOT NULL CHECK(last_verified_at_ms >= 0),
            last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= 0),
            created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
            updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
        ) STRICT;

        CREATE INDEX cache_artifacts_lru_idx ON cache_artifacts(availability, last_accessed_at_ms, artifact_key);

        CREATE TABLE cache_leases (
            lease_id TEXT PRIMARY KEY NOT NULL CHECK(length(lease_id) BETWEEN 1 AND 64),
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 64),
            owner_label TEXT NOT NULL CHECK(length(owner_label) BETWEEN 1 AND 128),
            project_id TEXT CHECK(project_id IS NULL OR length(project_id) BETWEEN 1 AND 64),
            artifact_key TEXT NOT NULL REFERENCES cache_artifacts(artifact_key) ON DELETE CASCADE,
            acquired_at_ms INTEGER NOT NULL CHECK(acquired_at_ms >= 0)
        ) STRICT;

        CREATE INDEX cache_leases_session_idx ON cache_leases(session_id, owner_label);
        CREATE INDEX cache_leases_artifact_idx ON cache_leases(artifact_key);

        CREATE TABLE media_settings (
            key TEXT PRIMARY KEY NOT NULL CHECK(length(key) BETWEEN 1 AND 128),
            integer_value INTEGER,
            text_value TEXT CHECK(text_value IS NULL OR length(text_value) <= 4096),
            updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
            CHECK((integer_value IS NULL) <> (text_value IS NULL))
        ) STRICT;",
    )?;
    transaction.execute(
        "INSERT INTO media_settings(key, integer_value, text_value, updated_at_ms)
         VALUES ('managed_cache_budget_bytes_v1', ?1, NULL, 0)",
        [DEFAULT_CACHE_BUDGET_BYTES],
    )?;
    transaction.pragma_update(None, "application_id", MEDIA_STATE_APPLICATION_ID)?;
    transaction.pragma_update(None, "user_version", MEDIA_STATE_SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

fn verify_integrity(connection: &Connection) -> Result<(), MediaStateStoreError> {
    let result: String = connection.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(MediaStateStoreError::Integrity)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct NewMediaJob {
    pub(crate) kind: MediaJobKind,
    pub(crate) parent_id: Option<String>,
    pub(crate) dedupe_key: String,
    pub(crate) project_id: Option<String>,
    pub(crate) asset_id: Option<String>,
    pub(crate) revision_id: Option<String>,
    pub(crate) priority: MediaJobPriority,
    pub(crate) priority_value: u16,
    pub(crate) stage: String,
    pub(crate) progress: MediaJobProgress,
    pub(crate) max_attempts: u8,
    pub(crate) summary: String,
    pub(crate) private_payload: Value,
    pub(crate) created_at_ms: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct MediaJobTransition {
    pub(crate) state: MediaJobState,
    pub(crate) stage: String,
    pub(crate) progress: MediaJobProgress,
    pub(crate) attempt: Option<u8>,
    pub(crate) error: Option<MediaJobError>,
    pub(crate) retry_at_ms: Option<i64>,
    pub(crate) result: Option<Value>,
    pub(crate) cancellation_requested: bool,
    pub(crate) event_type: MediaJobEventType,
    pub(crate) message: Option<String>,
    pub(crate) occurred_at_ms: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct EnqueueOutcome {
    pub(crate) job: MediaJobRecord,
    pub(crate) reused: bool,
    refreshed: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct MediaJobEventPage {
    pub(crate) events: Vec<MediaJobEvent>,
    pub(crate) latest_event_id: u64,
    pub(crate) has_more: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct StoredPrivateJob {
    pub(crate) public: MediaJobRecord,
    pub(crate) payload_version: u32,
    pub(crate) private_payload: Value,
    pub(crate) result: Option<Value>,
}

type MediaJobEventSink = Arc<dyn Fn(MediaJobEvent) + Send + Sync + 'static>;

#[derive(Clone)]
pub(crate) struct MediaJobStore {
    state: MediaStateStore,
    recovery_notice: Arc<Mutex<Option<MediaJobRecoveryReport>>>,
    event_sink: Arc<Mutex<Option<MediaJobEventSink>>>,
}

impl MediaJobStore {
    pub(crate) async fn initialize(local_data_dir: PathBuf) -> Result<Self, MediaStateStoreError> {
        tauri::async_runtime::spawn_blocking(move || Self::initialize_sync(&local_data_dir))
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    fn initialize_sync(local_data_dir: &Path) -> Result<Self, MediaStateStoreError> {
        let mut database_recovered = false;
        let state = match MediaStateStore::initialize(local_data_dir) {
            Ok(state) => state,
            Err(error) if is_corruption_error(&error) => {
                quarantine_owned_database(local_data_dir)?;
                database_recovered = true;
                MediaStateStore::initialize(local_data_dir)?
            }
            Err(error) => return Err(error),
        };
        let recovery_notice = database_recovered.then(|| MediaJobRecoveryReport {
            schema_version: MEDIA_JOB_SCHEMA_VERSION,
            requeued_count: 0,
            blocked_count: 0,
            cancelled_count: 0,
            stale_lease_count: 0,
            database_recovered: true,
            warning: Some(
                "The local media job database was rebuilt after an integrity failure.".to_owned(),
            ),
            recovered_at: timestamp_string(now_millis())
                .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_owned()),
        });
        Ok(Self {
            state,
            recovery_notice: Arc::new(Mutex::new(recovery_notice)),
            event_sink: Arc::new(Mutex::new(None)),
        })
    }

    #[cfg(test)]
    fn initialize_for_test(local_data_dir: &Path) -> Result<Self, MediaStateStoreError> {
        Self::initialize_sync(local_data_dir)
    }

    #[cfg(test)]
    pub(crate) fn database_path(&self) -> &Path {
        self.state.path()
    }

    pub(crate) fn state(&self) -> &MediaStateStore {
        &self.state
    }

    #[cfg(test)]
    pub(crate) fn recovery_notice(
        &self,
    ) -> Result<Option<MediaJobRecoveryReport>, MediaStateStoreError> {
        self.recovery_notice
            .lock()
            .map_err(|_| MediaStateStoreError::LockPoisoned)
            .map(|notice| notice.clone())
    }

    pub(crate) fn set_event_sink(
        &self,
        sink: MediaJobEventSink,
    ) -> Result<(), MediaStateStoreError> {
        *self
            .event_sink
            .lock()
            .map_err(|_| MediaStateStoreError::LockPoisoned)? = Some(sink);
        Ok(())
    }

    pub(crate) async fn enqueue(
        &self,
        request: NewMediaJob,
    ) -> Result<EnqueueOutcome, MediaStateStoreError> {
        let state = self.state.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || enqueue_sync(&state, request))
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)??;
        if !outcome.reused || outcome.refreshed {
            self.emit_latest(&outcome.job.id).await;
        }
        Ok(outcome)
    }

    pub(crate) async fn transition(
        &self,
        job_id: String,
        transition: MediaJobTransition,
    ) -> Result<MediaJobRecord, MediaStateStoreError> {
        let event_job_id = job_id.clone();
        let state = self.state.clone();
        let job = tauri::async_runtime::spawn_blocking(move || {
            transition_sync(&state, &job_id, transition)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)??;
        self.emit_latest(&event_job_id).await;
        Ok(job)
    }

    pub(crate) async fn request_cancellation(
        &self,
        job_id: String,
        occurred_at_ms: i64,
    ) -> Result<MediaJobRecord, MediaStateStoreError> {
        let event_job_id = job_id.clone();
        let state = self.state.clone();
        let job = tauri::async_runtime::spawn_blocking(move || {
            request_cancellation_sync(&state, &job_id, occurred_at_ms)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)??;
        self.emit_latest(&event_job_id).await;
        Ok(job)
    }

    async fn emit_latest(&self, job_id: &str) {
        let state = self.state.clone();
        let job_id = job_id.to_owned();
        let event =
            tauri::async_runtime::spawn_blocking(move || latest_event_for_job(&state, &job_id))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
        let sink = self.event_sink.lock().ok().and_then(|sink| sink.clone());
        if let (Some(event), Some(sink)) = (event, sink) {
            sink(event);
        }
    }

    pub(crate) async fn get_private(
        &self,
        job_id: String,
    ) -> Result<StoredPrivateJob, MediaStateStoreError> {
        let state = self.state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let connection = state.open_connection()?;
            load_private_job(&connection, &job_id)?.ok_or(MediaStateStoreError::NotFound)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn replace_private_payload(
        &self,
        job_id: String,
        private_payload: Value,
    ) -> Result<(), MediaStateStoreError> {
        let payload_json = bounded_json(&private_payload)?;
        let state = self.state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let connection = state.open_connection()?;
            let changed = connection.execute(
                "UPDATE media_jobs SET payload_version = payload_version + 1, private_payload_json = ?2 WHERE id = ?1",
                params![job_id, payload_json],
            )?;
            if changed == 1 {
                Ok(())
            } else {
                Err(MediaStateStoreError::NotFound)
            }
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn remove_stale_completed_preparation(
        &self,
        job_id: String,
    ) -> Result<(), MediaStateStoreError> {
        let state = self.state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let connection = state.open_connection()?;
            let changed = connection.execute(
                "DELETE FROM media_jobs
                 WHERE id = ?1 AND kind = 'asset_preparation' AND state = 'complete'",
                [job_id],
            )?;
            if changed == 1 {
                Ok(())
            } else {
                Err(MediaStateStoreError::InvalidTransition)
            }
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn list(
        &self,
        limit: usize,
        include_settled: bool,
        project_id: Option<String>,
        before_updated_at_ms: Option<i64>,
    ) -> Result<Vec<MediaJobRecord>, MediaStateStoreError> {
        if limit == 0 || limit > MAX_PUBLIC_JOBS {
            return Err(MediaStateStoreError::JobLimit);
        }
        let state = self.state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            list_sync(
                &state,
                limit,
                include_settled,
                project_id.as_deref(),
                before_updated_at_ms,
            )
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn recovery_jobs(&self) -> Result<Vec<MediaJobRecord>, MediaStateStoreError> {
        let state = self.state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            list_sync(&state, MAX_UNSETTLED_JOBS, false, None, None)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn child_jobs(
        &self,
        parent_id: String,
    ) -> Result<Vec<MediaJobRecord>, MediaStateStoreError> {
        let state = self.state.clone();
        tauri::async_runtime::spawn_blocking(move || children_sync(&state, &parent_id))
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn events(
        &self,
        job_id: Option<String>,
        after_event_id: u64,
        limit: usize,
    ) -> Result<MediaJobEventPage, MediaStateStoreError> {
        if limit == 0 || limit > MAX_PUBLIC_EVENTS {
            return Err(MediaStateStoreError::JobLimit);
        }
        let state = self.state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            events_sync(&state, job_id.as_deref(), after_event_id, limit)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn recover(
        &self,
        current_session_id: String,
        now_ms: i64,
    ) -> Result<MediaJobRecoveryReport, MediaStateStoreError> {
        let state = self.state.clone();
        let report = tauri::async_runtime::spawn_blocking(move || {
            recover_sync(&state, &current_session_id, now_ms)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)??;
        if let Ok(mut notice) = self.recovery_notice.lock() {
            if let Some(database_notice) = notice.take() {
                return Ok(MediaJobRecoveryReport {
                    database_recovered: true,
                    warning: database_notice.warning,
                    ..report
                });
            }
        }
        Ok(report)
    }

    pub(crate) async fn passive_checkpoint(&self) -> Result<(), MediaStateStoreError> {
        let state = self.state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let connection = state.open_connection()?;
            connection.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
            Ok(())
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    #[cfg(test)]
    async fn responsiveness_probe(&self, delay: Duration) -> Result<(), MediaStateStoreError> {
        let state = self.state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(delay);
            let connection = state.open_connection()?;
            verify_integrity(&connection)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }
}

fn enqueue_sync(
    state: &MediaStateStore,
    request: NewMediaJob,
) -> Result<EnqueueOutcome, MediaStateStoreError> {
    validate_new_job(&request)?;
    let payload_json = bounded_json(&request.private_payload)?;
    let mut connection = state.open_connection()?;
    let transaction = connection.transaction()?;

    if let Some(job) = find_deduplicated_job(&transaction, &request.dedupe_key)? {
        let refreshed = if job.kind == MediaJobKind::FinalRender
            && request.kind == MediaJobKind::FinalRender
            && job.state == MediaJobState::Blocked
            && request
                .private_payload
                .get("outputAuthorizationPresent")
                .and_then(Value::as_bool)
                == Some(true)
        {
            refresh_blocked_final_render(&transaction, &job, &request, &payload_json)?;
            true
        } else {
            false
        };
        let job = if refreshed {
            load_job(&transaction, &job.id)?.ok_or(MediaStateStoreError::CorruptRecord)?
        } else {
            job
        };
        transaction.commit()?;
        return Ok(EnqueueOutcome {
            job,
            reused: true,
            refreshed,
        });
    }
    let unsettled_count: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM media_jobs WHERE state NOT IN ('cancelled', 'failed', 'complete')",
        [],
        |row| row.get(0),
    )?;
    if unsettled_count >= i64::try_from(MAX_UNSETTLED_JOBS).unwrap_or(i64::MAX) {
        return Err(MediaStateStoreError::JobLimit);
    }

    let id = Uuid::new_v4().to_string();
    let now = request.created_at_ms;
    transaction.execute(
        "INSERT INTO media_jobs (
            id, schema_version, kind, parent_id, dedupe_key, project_id, asset_id, revision_id,
            priority_class, priority_value, state, stage, progress_completed, progress_total,
            progress_unit, attempt, max_attempts, safe_summary, payload_version,
            private_payload_json, created_at_ms, updated_at_ms, cancellation_requested
         ) VALUES (
            ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'queued', ?10, ?11, ?12, ?13,
            0, ?14, ?15, 1, ?16, ?17, ?17, 0
         )",
        params![
            id,
            enum_string(request.kind)?,
            request.parent_id,
            request.dedupe_key,
            request.project_id,
            request.asset_id,
            request.revision_id,
            enum_string(request.priority)?,
            request.priority_value,
            request.stage,
            sql_i64(request.progress.completed)?,
            sql_i64(request.progress.total)?,
            enum_string(request.progress.unit)?,
            request.max_attempts,
            request.summary,
            payload_json,
            now,
        ],
    )?;
    let job = load_job(&transaction, &id)?.ok_or(MediaStateStoreError::CorruptRecord)?;
    insert_event(
        &transaction,
        &job,
        MediaJobEventType::Created,
        Some("Media job queued."),
        None,
        now,
    )?;
    transaction.commit()?;
    Ok(EnqueueOutcome {
        job,
        reused: false,
        refreshed: false,
    })
}

fn refresh_blocked_final_render(
    transaction: &Transaction<'_>,
    current: &MediaJobRecord,
    request: &NewMediaJob,
    payload_json: &str,
) -> Result<(), MediaStateStoreError> {
    if request.created_at_ms < parse_timestamp_millis(&current.updated_at)? {
        return Err(MediaStateStoreError::InvalidTransition);
    }
    let changed = transaction.execute(
        "UPDATE media_jobs SET
            state = 'queued', stage = ?2, progress_completed = ?3, progress_total = ?4,
            progress_unit = ?5, payload_version = payload_version + 1,
            private_payload_json = ?6, error_code = NULL, error_category = NULL,
            error_message = NULL, error_retryable = NULL, error_action = NULL,
            retry_at_ms = NULL, settled_at_ms = NULL, cancellation_requested = 0,
            updated_at_ms = ?7
         WHERE id = ?1 AND kind = 'final_render' AND state = 'blocked'",
        params![
            current.id,
            request.stage,
            sql_i64(request.progress.completed)?,
            sql_i64(request.progress.total)?,
            enum_string(request.progress.unit)?,
            payload_json,
            request.created_at_ms,
        ],
    )?;
    if changed != 1 {
        return Err(MediaStateStoreError::InvalidTransition);
    }
    let updated = load_job(transaction, &current.id)?.ok_or(MediaStateStoreError::CorruptRecord)?;
    updated.validate()?;
    insert_event(
        transaction,
        &updated,
        MediaJobEventType::StateChanged,
        Some("Final render reauthorized and queued."),
        None,
        request.created_at_ms,
    )?;
    enforce_retention(transaction, request.created_at_ms)
}

fn transition_sync(
    state: &MediaStateStore,
    job_id: &str,
    transition: MediaJobTransition,
) -> Result<MediaJobRecord, MediaStateStoreError> {
    transition.progress.validate()?;
    if transition.occurred_at_ms < 0 || transition.retry_at_ms.is_some_and(|value| value < 0) {
        return Err(MediaStateStoreError::InvalidTransition);
    }
    let result_json = transition.result.as_ref().map(bounded_json).transpose()?;
    if transition.state == MediaJobState::Complete && result_json.is_none() {
        return Err(MediaStateStoreError::InvalidTransition);
    }
    if transition.state != MediaJobState::Complete && result_json.is_some() {
        return Err(MediaStateStoreError::InvalidTransition);
    }
    if let Some(message) = transition.message.as_deref() {
        if message.trim().is_empty() || message.len() > 1_024 {
            return Err(MediaStateStoreError::InvalidTransition);
        }
    }

    let mut connection = state.open_connection()?;
    let transaction = connection.transaction()?;
    let current = load_job(&transaction, job_id)?.ok_or(MediaStateStoreError::NotFound)?;
    let terminal_reactivation = matches!(
        (current.state, transition.state),
        (
            MediaJobState::Failed,
            MediaJobState::Queued | MediaJobState::Blocked
        )
    );
    if current.state.is_terminal() && !terminal_reactivation {
        return Err(MediaStateStoreError::InvalidTransition);
    }
    if current.state != transition.state && !current.state.can_transition_to(transition.state) {
        return Err(MediaStateStoreError::InvalidTransition);
    }
    if transition.occurred_at_ms < parse_timestamp_millis(&current.updated_at)? {
        return Err(MediaStateStoreError::InvalidTransition);
    }

    let attempt = transition.attempt.unwrap_or(current.attempt);
    let started_at_ms = if matches!(
        transition.state,
        MediaJobState::Probing | MediaJobState::Running
    ) && current.started_at.is_none()
    {
        Some(transition.occurred_at_ms)
    } else {
        current
            .started_at
            .as_deref()
            .map(parse_timestamp_millis)
            .transpose()?
    };
    let settled_at_ms = transition
        .state
        .is_terminal()
        .then_some(transition.occurred_at_ms);
    let error_code = transition.error.as_ref().map(|error| error.code.as_str());
    let error_category = transition
        .error
        .as_ref()
        .map(|error| enum_string(error.category))
        .transpose()?;
    let error_message = transition
        .error
        .as_ref()
        .map(|error| error.message.as_str());
    let error_retryable = transition.error.as_ref().map(|error| error.retryable);
    let error_action = transition
        .error
        .as_ref()
        .and_then(|error| error.action)
        .map(enum_string)
        .transpose()?;

    transaction.execute(
        "UPDATE media_jobs SET
            state = ?2, stage = ?3, progress_completed = ?4, progress_total = ?5,
            progress_unit = ?6, attempt = ?7, result_version = ?8, result_json = ?9,
            error_code = ?10, error_category = ?11, error_message = ?12,
            error_retryable = ?13, error_action = ?14, retry_at_ms = ?15,
            updated_at_ms = ?16, started_at_ms = ?17, settled_at_ms = ?18,
            cancellation_requested = ?19
         WHERE id = ?1",
        params![
            job_id,
            enum_string(transition.state)?,
            transition.stage,
            sql_i64(transition.progress.completed)?,
            sql_i64(transition.progress.total)?,
            enum_string(transition.progress.unit)?,
            attempt,
            result_json.as_ref().map(|_| 1_u32),
            result_json,
            error_code,
            error_category,
            error_message,
            error_retryable,
            error_action,
            transition.retry_at_ms,
            transition.occurred_at_ms,
            started_at_ms,
            settled_at_ms,
            transition.cancellation_requested,
        ],
    )?;
    let updated = load_job(&transaction, job_id)?.ok_or(MediaStateStoreError::CorruptRecord)?;
    updated.validate()?;
    insert_event(
        &transaction,
        &updated,
        transition.event_type,
        transition.message.as_deref(),
        transition.error.as_ref().map(|error| error.category),
        transition.occurred_at_ms,
    )?;
    enforce_retention(&transaction, transition.occurred_at_ms)?;
    transaction.commit()?;
    Ok(updated)
}

fn request_cancellation_sync(
    state: &MediaStateStore,
    job_id: &str,
    occurred_at_ms: i64,
) -> Result<MediaJobRecord, MediaStateStoreError> {
    let mut connection = state.open_connection()?;
    let transaction = connection.transaction()?;
    let current = load_job(&transaction, job_id)?.ok_or(MediaStateStoreError::NotFound)?;
    if current.state.is_terminal() || current.cancellation_requested {
        return Ok(current);
    }
    transaction.execute(
        "UPDATE media_jobs SET cancellation_requested = 1, updated_at_ms = ?2 WHERE id = ?1",
        params![job_id, occurred_at_ms],
    )?;
    let updated = load_job(&transaction, job_id)?.ok_or(MediaStateStoreError::CorruptRecord)?;
    insert_event(
        &transaction,
        &updated,
        MediaJobEventType::CancellationRequested,
        Some("Cancellation requested."),
        None,
        occurred_at_ms,
    )?;
    transaction.commit()?;
    Ok(updated)
}

fn list_sync(
    state: &MediaStateStore,
    limit: usize,
    include_settled: bool,
    project_id: Option<&str>,
    before_updated_at_ms: Option<i64>,
) -> Result<Vec<MediaJobRecord>, MediaStateStoreError> {
    let connection = state.open_connection()?;
    let mut statement = connection.prepare(&format!(
        "SELECT {JOB_COLUMNS} FROM media_jobs
         WHERE (?1 OR state NOT IN ('cancelled', 'failed', 'complete'))
           AND (?2 IS NULL OR project_id = ?2)
           AND (?3 IS NULL OR updated_at_ms < ?3)
         ORDER BY updated_at_ms DESC, id DESC LIMIT ?4"
    ))?;
    let mut rows = statement.query(params![
        include_settled,
        project_id,
        before_updated_at_ms,
        i64::try_from(limit).map_err(|_| MediaStateStoreError::JobLimit)?
    ])?;
    let mut jobs = Vec::new();
    while let Some(row) = rows.next()? {
        let job = job_from_row(row)?;
        job.validate()?;
        jobs.push(job);
    }
    Ok(jobs)
}

fn children_sync(
    state: &MediaStateStore,
    parent_id: &str,
) -> Result<Vec<MediaJobRecord>, MediaStateStoreError> {
    let connection = state.open_connection()?;
    let mut statement = connection.prepare(&format!(
        "SELECT {JOB_COLUMNS} FROM media_jobs WHERE parent_id = ?1 ORDER BY created_at_ms, id"
    ))?;
    let mut rows = statement.query([parent_id])?;
    let mut jobs = Vec::new();
    while let Some(row) = rows.next()? {
        let job = job_from_row(row)?;
        job.validate()?;
        jobs.push(job);
    }
    Ok(jobs)
}

fn events_sync(
    state: &MediaStateStore,
    job_id: Option<&str>,
    after_event_id: u64,
    limit: usize,
) -> Result<MediaJobEventPage, MediaStateStoreError> {
    let connection = state.open_connection()?;
    let latest_event_id = sql_u64(connection.query_row::<i64, _, _>(
        "SELECT COALESCE(MAX(event_id), 0) FROM media_job_events",
        [],
        |row| row.get(0),
    )?)?;
    let mut statement = connection.prepare(
        "SELECT event_id, job_id, event_type, state, stage, progress_completed,
                progress_total, progress_unit, safe_message, category, created_at_ms
         FROM media_job_events
         WHERE event_id > ?1 AND (?2 IS NULL OR job_id = ?2)
         ORDER BY event_id ASC LIMIT ?3",
    )?;
    let query_limit =
        i64::try_from(limit.saturating_add(1)).map_err(|_| MediaStateStoreError::JobLimit)?;
    let mut rows = statement.query(params![sql_i64(after_event_id)?, job_id, query_limit])?;
    let mut events = Vec::new();
    while let Some(row) = rows.next()? {
        events.push(event_from_row(row)?);
    }
    let has_more = events.len() > limit;
    events.truncate(limit);
    Ok(MediaJobEventPage {
        events,
        latest_event_id,
        has_more,
    })
}

fn recover_sync(
    state: &MediaStateStore,
    current_session_id: &str,
    now_ms: i64,
) -> Result<MediaJobRecoveryReport, MediaStateStoreError> {
    let mut connection = state.open_connection()?;
    let transaction = connection.transaction()?;
    let stale_lease_count = transaction.execute(
        "DELETE FROM cache_leases WHERE session_id <> ?1",
        [current_session_id],
    )?;
    let ids = select_interrupted_job_ids(&transaction)?;
    let mut requeued_count = 0_u64;
    let mut blocked_count = 0_u64;
    for id in ids {
        let stored =
            load_private_job(&transaction, &id)?.ok_or(MediaStateStoreError::CorruptRecord)?;
        let canonical_available = stored
            .private_payload
            .get("canonicalObjectAvailable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let can_resume = matches!(
            stored.public.kind,
            MediaJobKind::AssetPreparation | MediaJobKind::Proxy | MediaJobKind::ThumbnailTile
        ) && canonical_available;
        let (state_value, stage, error) = if can_resume {
            requeued_count += 1;
            (MediaJobState::Queued, "recovered", None)
        } else {
            blocked_count += 1;
            let (code, category, message, action) =
                if stored.public.kind == MediaJobKind::FinalRender {
                    (
                        "output_authorization_required",
                        MediaJobErrorCategory::OutputAuthorizationRequired,
                        "Choose the export destination again to continue.",
                        MediaJobRecoveryAction::ReauthorizeOutput,
                    )
                } else {
                    (
                        "source_authorization_required",
                        MediaJobErrorCategory::AuthorizationRequired,
                        "Choose the source again to continue.",
                        MediaJobRecoveryAction::ReauthorizeSource,
                    )
                };
            (
                MediaJobState::Blocked,
                "authorization",
                Some(MediaJobError {
                    code: code.to_owned(),
                    category,
                    message: message.to_owned(),
                    retryable: false,
                    action: Some(action),
                }),
            )
        };
        update_recovered_job(
            &transaction,
            &stored.public,
            state_value,
            stage,
            error,
            now_ms,
        )?;
    }
    enforce_retention(&transaction, now_ms)?;
    transaction.commit()?;
    Ok(MediaJobRecoveryReport {
        schema_version: MEDIA_JOB_SCHEMA_VERSION,
        requeued_count,
        blocked_count,
        cancelled_count: 0,
        stale_lease_count: u64::try_from(stale_lease_count).unwrap_or(u64::MAX),
        database_recovered: false,
        warning: None,
        recovered_at: timestamp_string(now_ms)?,
    })
}

fn select_interrupted_job_ids(
    connection: &Connection,
) -> Result<Vec<String>, MediaStateStoreError> {
    let mut statement = connection.prepare(
        "SELECT id FROM media_jobs
         WHERE state IN ('probing', 'running', 'retrying')
            OR (state = 'queued' AND kind = 'final_render')
         ORDER BY created_at_ms, id",
    )?;
    let mut rows = statement.query([])?;
    let mut ids = Vec::new();
    while let Some(row) = rows.next()? {
        ids.push(row.get(0)?);
    }
    Ok(ids)
}

fn update_recovered_job(
    transaction: &Transaction<'_>,
    current: &MediaJobRecord,
    state: MediaJobState,
    stage: &str,
    error: Option<MediaJobError>,
    now_ms: i64,
) -> Result<(), MediaStateStoreError> {
    let category = error
        .as_ref()
        .map(|value| enum_string(value.category))
        .transpose()?;
    let action = error
        .as_ref()
        .and_then(|value| value.action)
        .map(enum_string)
        .transpose()?;
    transaction.execute(
        "UPDATE media_jobs SET state = ?2, stage = ?3, error_code = ?4,
            error_category = ?5, error_message = ?6, error_retryable = ?7,
            error_action = ?8, retry_at_ms = NULL, settled_at_ms = NULL,
            cancellation_requested = 0, updated_at_ms = ?9 WHERE id = ?1",
        params![
            current.id,
            enum_string(state)?,
            stage,
            error.as_ref().map(|value| value.code.as_str()),
            category,
            error.as_ref().map(|value| value.message.as_str()),
            error.as_ref().map(|value| value.retryable),
            action,
            now_ms,
        ],
    )?;
    let updated = load_job(transaction, &current.id)?.ok_or(MediaStateStoreError::CorruptRecord)?;
    insert_event(
        transaction,
        &updated,
        MediaJobEventType::Recovered,
        error.as_ref().map(|value| value.message.as_str()),
        error.as_ref().map(|value| value.category),
        now_ms,
    )?;
    Ok(())
}

const JOB_COLUMNS: &str = "id, schema_version, kind, parent_id, project_id, asset_id,
    revision_id, priority_class, state, stage, progress_completed, progress_total,
    progress_unit, attempt, max_attempts, safe_summary, error_code, error_category,
    error_message, error_retryable, error_action, retry_at_ms, created_at_ms,
    updated_at_ms, started_at_ms, settled_at_ms, cancellation_requested, result_json";

fn load_job(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<MediaJobRecord>, MediaStateStoreError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {JOB_COLUMNS} FROM media_jobs WHERE id = ?1"
    ))?;
    let mut rows = statement.query([job_id])?;
    rows.next()?.map(job_from_row).transpose()
}

fn load_private_job(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<StoredPrivateJob>, MediaStateStoreError> {
    let Some(public) = load_job(connection, job_id)? else {
        return Ok(None);
    };
    let private = connection
        .query_row(
            "SELECT payload_version, private_payload_json, result_version, result_json
             FROM media_jobs WHERE id = ?1",
            [job_id],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<u32>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((payload_version, payload_json, result_version, result_json)) = private else {
        return Ok(None);
    };
    if result_version != result_json.as_ref().map(|_| 1) {
        return Err(MediaStateStoreError::CorruptRecord);
    }
    Ok(Some(StoredPrivateJob {
        public,
        payload_version,
        private_payload: serde_json::from_str(&payload_json)?,
        result: result_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?,
    }))
}

fn find_deduplicated_job(
    connection: &Connection,
    dedupe_key: &str,
) -> Result<Option<MediaJobRecord>, MediaStateStoreError> {
    let id = connection
        .query_row(
            "SELECT id FROM media_jobs
             WHERE dedupe_key = ?1
               AND (state NOT IN ('cancelled', 'failed', 'complete') OR (state = 'complete' AND result_json IS NOT NULL))
             ORDER BY CASE WHEN state = 'complete' THEN 1 ELSE 0 END, updated_at_ms DESC
             LIMIT 1",
            [dedupe_key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    id.as_deref()
        .map(|id| load_job(connection, id))
        .transpose()
        .map(Option::flatten)
}

fn job_from_row(row: &Row<'_>) -> Result<MediaJobRecord, MediaStateStoreError> {
    let error_code: Option<String> = row.get("error_code")?;
    let error_category: Option<String> = row.get("error_category")?;
    let error_message: Option<String> = row.get("error_message")?;
    let error_retryable: Option<bool> = row.get("error_retryable")?;
    let error_action: Option<String> = row.get("error_action")?;
    let error = match (error_code, error_category, error_message, error_retryable) {
        (Some(code), Some(category), Some(message), Some(retryable)) => Some(MediaJobError {
            code,
            category: enum_value(&category)?,
            message,
            retryable,
            action: error_action.as_deref().map(enum_value).transpose()?,
        }),
        (None, None, None, None) if error_action.is_none() => None,
        _ => return Err(MediaStateStoreError::CorruptRecord),
    };
    let result_json: Option<String> = row.get("result_json")?;
    let record = MediaJobRecord {
        schema_version: row.get("schema_version")?,
        id: row.get("id")?,
        kind: enum_value(&row.get::<_, String>("kind")?)?,
        parent_id: row.get("parent_id")?,
        project_id: row.get("project_id")?,
        asset_id: row.get("asset_id")?,
        revision_id: row.get("revision_id")?,
        priority: enum_value(&row.get::<_, String>("priority_class")?)?,
        state: enum_value(&row.get::<_, String>("state")?)?,
        stage: row.get("stage")?,
        progress: MediaJobProgress {
            completed: row_u64(row, "progress_completed")?,
            total: row_u64(row, "progress_total")?,
            unit: enum_value(&row.get::<_, String>("progress_unit")?)?,
        },
        attempt: row.get("attempt")?,
        max_attempts: row.get("max_attempts")?,
        summary: row.get("safe_summary")?,
        error,
        retry_at: row
            .get::<_, Option<i64>>("retry_at_ms")?
            .map(timestamp_string)
            .transpose()?,
        created_at: timestamp_string(row.get("created_at_ms")?)?,
        updated_at: timestamp_string(row.get("updated_at_ms")?)?,
        started_at: row
            .get::<_, Option<i64>>("started_at_ms")?
            .map(timestamp_string)
            .transpose()?,
        settled_at: row
            .get::<_, Option<i64>>("settled_at_ms")?
            .map(timestamp_string)
            .transpose()?,
        cancellation_requested: row.get("cancellation_requested")?,
        result_available: result_json.is_some(),
    };
    Ok(record)
}

fn insert_event(
    transaction: &Transaction<'_>,
    job: &MediaJobRecord,
    event_type: MediaJobEventType,
    message: Option<&str>,
    category: Option<MediaJobErrorCategory>,
    created_at_ms: i64,
) -> Result<u64, MediaStateStoreError> {
    transaction.execute(
        "INSERT INTO media_job_events (
            job_id, event_type, state, stage, progress_completed, progress_total,
            progress_unit, safe_message, category, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            job.id,
            enum_string(event_type)?,
            enum_string(job.state)?,
            job.stage,
            sql_i64(job.progress.completed)?,
            sql_i64(job.progress.total)?,
            enum_string(job.progress.unit)?,
            message,
            category.map(enum_string).transpose()?,
            created_at_ms,
        ],
    )?;
    u64::try_from(transaction.last_insert_rowid()).map_err(|_| MediaStateStoreError::CorruptRecord)
}

fn latest_event_for_job(
    state: &MediaStateStore,
    job_id: &str,
) -> Result<Option<MediaJobEvent>, MediaStateStoreError> {
    let connection = state.open_connection()?;
    let mut statement = connection.prepare(
        "SELECT event_id, job_id, event_type, state, stage, progress_completed,
                progress_total, progress_unit, safe_message, category, created_at_ms
         FROM media_job_events WHERE job_id = ?1 ORDER BY event_id DESC LIMIT 1",
    )?;
    let mut rows = statement.query([job_id])?;
    rows.next()?.map(event_from_row).transpose()
}

fn event_from_row(row: &Row<'_>) -> Result<MediaJobEvent, MediaStateStoreError> {
    let event = MediaJobEvent {
        schema_version: MEDIA_JOB_SCHEMA_VERSION,
        event_id: row_u64(row, "event_id")?,
        job_id: row.get("job_id")?,
        event_type: enum_value(&row.get::<_, String>("event_type")?)?,
        state: enum_value(&row.get::<_, String>("state")?)?,
        stage: row.get("stage")?,
        progress: MediaJobProgress {
            completed: row_u64(row, "progress_completed")?,
            total: row_u64(row, "progress_total")?,
            unit: enum_value(&row.get::<_, String>("progress_unit")?)?,
        },
        message: row.get("safe_message")?,
        category: row
            .get::<_, Option<String>>("category")?
            .as_deref()
            .map(enum_value)
            .transpose()?,
        created_at: timestamp_string(row.get("created_at_ms")?)?,
    };
    event.validate()?;
    Ok(event)
}

fn enforce_retention(
    transaction: &Transaction<'_>,
    now_ms: i64,
) -> Result<(), MediaStateStoreError> {
    transaction.execute(
        "DELETE FROM media_jobs WHERE id IN (
            SELECT id FROM media_jobs
            WHERE state IN ('cancelled', 'failed', 'complete')
            ORDER BY updated_at_ms DESC, id DESC
            LIMIT -1 OFFSET ?1
        )",
        [i64::try_from(MAX_RETAINED_SETTLED_JOBS).map_err(|_| MediaStateStoreError::JobLimit)?],
    )?;
    let thirty_days_ms = 30_i64 * 24 * 60 * 60 * 1_000;
    transaction.execute(
        "DELETE FROM media_job_events
         WHERE created_at_ms < ?1
           AND event_id NOT IN (SELECT MAX(event_id) FROM media_job_events GROUP BY job_id)",
        [now_ms.saturating_sub(thirty_days_ms)],
    )?;
    transaction.execute(
        "DELETE FROM media_job_events WHERE event_id IN (
            SELECT event_id FROM media_job_events
            WHERE event_id NOT IN (SELECT MAX(event_id) FROM media_job_events GROUP BY job_id)
            ORDER BY event_id DESC LIMIT -1 OFFSET ?1
         )",
        [i64::try_from(MAX_RETAINED_EVENTS).map_err(|_| MediaStateStoreError::JobLimit)?],
    )?;
    Ok(())
}

fn validate_new_job(request: &NewMediaJob) -> Result<(), MediaStateStoreError> {
    if request.dedupe_key.trim().is_empty()
        || request.dedupe_key.len() > 512
        || request.priority_value > 1_000
        || request.max_attempts == 0
        || request.max_attempts > 100
        || request.created_at_ms < 0
    {
        return Err(MediaStateStoreError::InvalidTransition);
    }
    let candidate = MediaJobRecord {
        schema_version: MEDIA_JOB_SCHEMA_VERSION,
        id: Uuid::new_v4().to_string(),
        kind: request.kind,
        parent_id: request.parent_id.clone(),
        project_id: request.project_id.clone(),
        asset_id: request.asset_id.clone(),
        revision_id: request.revision_id.clone(),
        priority: request.priority,
        state: MediaJobState::Queued,
        stage: request.stage.clone(),
        progress: request.progress.clone(),
        attempt: 0,
        max_attempts: request.max_attempts,
        summary: request.summary.clone(),
        error: None,
        retry_at: None,
        created_at: timestamp_string(request.created_at_ms)?,
        updated_at: timestamp_string(request.created_at_ms)?,
        started_at: None,
        settled_at: None,
        cancellation_requested: false,
        result_available: false,
    };
    candidate.validate()?;
    bounded_json(&request.private_payload)?;
    Ok(())
}

fn bounded_json(value: &Value) -> Result<String, MediaStateStoreError> {
    let json = serde_json::to_string(value)?;
    if json.len() > MAX_PRIVATE_JSON_BYTES {
        Err(MediaStateStoreError::PayloadTooLarge)
    } else {
        Ok(json)
    }
}

fn enum_string<T: Serialize>(value: T) -> Result<String, MediaStateStoreError> {
    serde_json::to_value(value)?
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or(MediaStateStoreError::CorruptRecord)
}

fn enum_value<T: DeserializeOwned>(value: &str) -> Result<T, MediaStateStoreError> {
    serde_json::from_value(Value::String(value.to_owned())).map_err(MediaStateStoreError::from)
}

fn sql_i64(value: u64) -> Result<i64, MediaStateStoreError> {
    i64::try_from(value).map_err(|_| MediaStateStoreError::CorruptRecord)
}

fn sql_u64(value: i64) -> Result<u64, MediaStateStoreError> {
    u64::try_from(value).map_err(|_| MediaStateStoreError::CorruptRecord)
}

fn row_u64(row: &Row<'_>, column: &str) -> Result<u64, MediaStateStoreError> {
    sql_u64(row.get::<_, i64>(column)?)
}

fn timestamp_string(timestamp_ms: i64) -> Result<String, MediaStateStoreError> {
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or(MediaStateStoreError::CorruptRecord)
}

fn parse_timestamp_millis(timestamp: &str) -> Result<i64, MediaStateStoreError> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .map(|value| value.timestamp_millis())
        .map_err(|_| MediaStateStoreError::CorruptRecord)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn is_corruption_error(error: &MediaStateStoreError) -> bool {
    match error {
        MediaStateStoreError::Integrity => true,
        MediaStateStoreError::Sqlite(rusqlite::Error::SqliteFailure(inner, _)) => {
            matches!(
                inner.extended_code & 0xff,
                rusqlite::ffi::SQLITE_CORRUPT | rusqlite::ffi::SQLITE_NOTADB
            )
        }
        _ => false,
    }
}

fn quarantine_owned_database(local_data_dir: &Path) -> Result<(), MediaStateStoreError> {
    let database = local_data_dir.join(MEDIA_STATE_FILENAME);
    if !database.exists() {
        return Ok(());
    }
    let suffix = format!("corrupt-{}", now_millis());
    fs::rename(
        &database,
        local_data_dir.join(format!("{MEDIA_STATE_FILENAME}.{suffix}")),
    )?;
    for sidecar_suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{sidecar_suffix}", database.display()));
        if sidecar.exists() {
            fs::rename(
                &sidecar,
                local_data_dir.join(format!("{MEDIA_STATE_FILENAME}.{suffix}{sidecar_suffix}")),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    #[test]
    fn initializes_machine_local_schema_and_reopens_idempotently() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStateStore::initialize(directory.path()).unwrap();
        assert_eq!(store.path(), directory.path().join(MEDIA_STATE_FILENAME));

        let connection = store.open_connection().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let application_id: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .unwrap();
        let budget: i64 = connection
            .query_row(
                "SELECT integer_value FROM media_settings WHERE key = 'managed_cache_budget_bytes_v1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, MEDIA_STATE_SCHEMA_VERSION);
        assert_eq!(application_id, MEDIA_STATE_APPLICATION_ID);
        assert_eq!(budget, DEFAULT_CACHE_BUDGET_BYTES);
        drop(connection);

        MediaStateStore::initialize(directory.path()).unwrap();
    }

    #[test]
    fn rejects_future_schema_without_modifying_it() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStateStore::initialize(directory.path()).unwrap();
        let connection = store.open_connection().unwrap();
        connection
            .pragma_update(None, "user_version", 2_i64)
            .unwrap();
        drop(connection);

        assert!(matches!(
            MediaStateStore::initialize(directory.path()),
            Err(MediaStateStoreError::UnsupportedSchema(2))
        ));
    }

    fn new_job(dedupe_key: &str, kind: MediaJobKind, created_at_ms: i64) -> NewMediaJob {
        NewMediaJob {
            kind,
            parent_id: None,
            dedupe_key: dedupe_key.to_owned(),
            project_id: Some("10000000-0000-4000-8000-000000000001".to_owned()),
            asset_id: Some("20000000-0000-4000-8000-000000000001".to_owned()),
            revision_id: None,
            priority: MediaJobPriority::Interactive,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: 2,
                unit: super::super::model::MediaJobProgressUnit::Stages,
            },
            max_attempts: 3,
            summary: "Prepare test clip".to_owned(),
            private_payload: serde_json::json!({"canonicalObjectAvailable": true}),
            created_at_ms,
        }
    }

    fn running_transition(occurred_at_ms: i64) -> MediaJobTransition {
        MediaJobTransition {
            state: MediaJobState::Running,
            stage: "proxy".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: 100,
                unit: super::super::model::MediaJobProgressUnit::Frames,
            },
            attempt: Some(1),
            error: None,
            retry_at_ms: None,
            result: None,
            cancellation_requested: false,
            event_type: MediaJobEventType::StateChanged,
            message: Some("Proxy creation started.".to_owned()),
            occurred_at_ms,
        }
    }

    const PERFORMANCE_FIXTURE_JOB_COUNT: usize = 10_000;
    const PERFORMANCE_FIXTURE_INTERRUPTED_JOB_COUNT: usize = 1_000;

    fn seed_performance_fixture(state: &MediaStateStore) {
        let mut connection = state.open_connection().unwrap();
        let transaction = connection.transaction().unwrap();
        let inserted = transaction
            .execute(
                "WITH RECURSIVE fixture(job_number) AS (
                     VALUES(1)
                     UNION ALL
                     SELECT job_number + 1 FROM fixture WHERE job_number < ?1
                 )
                 INSERT INTO media_jobs (
                     id, schema_version, kind, parent_id, dedupe_key, project_id, asset_id,
                     revision_id, priority_class, priority_value, state, stage,
                     progress_completed, progress_total, progress_unit, attempt, max_attempts,
                     safe_summary, payload_version, private_payload_json, result_version,
                     result_json, error_code, error_category, error_message, error_retryable,
                     error_action, retry_at_ms, created_at_ms, updated_at_ms, started_at_ms,
                     settled_at_ms, cancellation_requested
                 )
                 SELECT
                     printf('00000000-0000-4000-8000-%012d', job_number),
                     1,
                     'proxy',
                     NULL,
                     printf('performance-fixture:%05d', job_number),
                     '10000000-0000-4000-8000-000000000001',
                     '20000000-0000-4000-8000-000000000001',
                     NULL,
                     'interactive',
                     0,
                     CASE WHEN job_number <= ?2 THEN 'running' ELSE 'complete' END,
                     CASE WHEN job_number <= ?2 THEN 'proxy' ELSE 'complete' END,
                     CASE WHEN job_number <= ?2 THEN 0 ELSE 100 END,
                     100,
                     'frames',
                     1,
                     3,
                     'Performance fixture job',
                     1,
                     '{\"canonicalObjectAvailable\":true}',
                     CASE WHEN job_number <= ?2 THEN NULL ELSE 1 END,
                     CASE WHEN job_number <= ?2 THEN NULL ELSE '{\"artifactKey\":\"fixture\"}' END,
                     NULL,
                     NULL,
                     NULL,
                     NULL,
                     NULL,
                     NULL,
                     1700000000000 + job_number,
                     1700000000000 + job_number,
                     1700000000000 + job_number,
                     CASE WHEN job_number <= ?2 THEN NULL ELSE 1700000000000 + job_number END,
                     0
                 FROM fixture",
                params![
                    i64::try_from(PERFORMANCE_FIXTURE_JOB_COUNT).unwrap(),
                    i64::try_from(PERFORMANCE_FIXTURE_INTERRUPTED_JOB_COUNT).unwrap(),
                ],
            )
            .unwrap();
        assert_eq!(inserted, PERFORMANCE_FIXTURE_JOB_COUNT);
        transaction.commit().unwrap();
    }

    #[test]
    fn enqueue_with_durable_event_p95_meets_release_budget() {
        let directory = tempfile::tempdir().unwrap();
        let state = MediaStateStore::initialize(directory.path()).unwrap();
        let requests = (0..100)
            .map(|index| {
                new_job(
                    &format!("enqueue-performance:{index:03}"),
                    MediaJobKind::Proxy,
                    1_800_000_000_000 + index,
                )
            })
            .collect::<Vec<_>>();

        let mut timings = Vec::with_capacity(requests.len());
        for request in requests {
            let started = Instant::now();
            enqueue_sync(&state, request).unwrap();
            timings.push(started.elapsed());
        }
        timings.sort_unstable();
        let p95 = timings[94];
        println!("media job enqueue plus durable event p95: {p95:?}");

        #[cfg(not(debug_assertions))]
        {
            let budget = Duration::from_millis(50);
            assert!(
                p95 < budget,
                "release media job enqueue plus durable event p95 was {p95:?} with budget {budget:?}"
            );
        }
    }

    #[test]
    fn list_100_recent_jobs_meets_release_budget() {
        let directory = tempfile::tempdir().unwrap();
        let state = MediaStateStore::initialize(directory.path()).unwrap();
        seed_performance_fixture(&state);

        let started = Instant::now();
        let jobs = list_sync(&state, MAX_PUBLIC_JOBS, true, None, None).unwrap();
        let elapsed = started.elapsed();
        println!(
            "media job list 100 recent across {PERFORMANCE_FIXTURE_JOB_COUNT} jobs: {elapsed:?} ({} returned)",
            jobs.len()
        );

        #[cfg(not(debug_assertions))]
        {
            let budget = Duration::from_millis(100);
            assert!(
                elapsed < budget,
                "release media job list 100 recent took {elapsed:?} with budget {budget:?}"
            );
        }
    }

    #[test]
    fn restart_recovery_selection_across_10k_jobs_meets_release_budget() {
        let directory = tempfile::tempdir().unwrap();
        let state = MediaStateStore::initialize(directory.path()).unwrap();
        seed_performance_fixture(&state);

        let started = Instant::now();
        let connection = state.open_connection().unwrap();
        let selected = select_interrupted_job_ids(&connection).unwrap();
        let elapsed = started.elapsed();
        println!(
            "restart recovery selection across {PERFORMANCE_FIXTURE_JOB_COUNT} jobs: {elapsed:?} ({} selected)",
            selected.len()
        );

        #[cfg(not(debug_assertions))]
        {
            let budget = Duration::from_secs(2);
            assert!(
                elapsed < budget,
                "release restart recovery selection across 10k jobs took {elapsed:?} with budget {budget:?}"
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn enqueue_deduplicates_and_state_event_updates_are_atomic() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize_for_test(directory.path()).unwrap();
        let first = store
            .enqueue(new_job("proxy:test", MediaJobKind::Proxy, 1_000))
            .await
            .unwrap();
        let duplicate = store
            .enqueue(new_job("proxy:test", MediaJobKind::Proxy, 1_001))
            .await
            .unwrap();
        assert!(!first.reused);
        assert!(duplicate.reused);
        assert_eq!(duplicate.job.id, first.job.id);

        let running = store
            .transition(first.job.id.clone(), running_transition(1_100))
            .await
            .unwrap();
        assert_eq!(running.state, MediaJobState::Running);
        let completed = store
            .transition(
                first.job.id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Complete,
                    stage: "complete".to_owned(),
                    progress: MediaJobProgress {
                        completed: 100,
                        total: 100,
                        unit: super::super::model::MediaJobProgressUnit::Frames,
                    },
                    attempt: None,
                    error: None,
                    retry_at_ms: None,
                    result: Some(serde_json::json!({"artifactKey": "proxy-test"})),
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("Proxy creation complete.".to_owned()),
                    occurred_at_ms: 1_200,
                },
            )
            .await
            .unwrap();
        assert!(completed.result_available);

        let page = store
            .events(Some(first.job.id.clone()), 0, 2)
            .await
            .unwrap();
        assert_eq!(page.events.len(), 2);
        assert_eq!(
            page.events
                .iter()
                .map(|event| event.event_id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(page.latest_event_id, 3);
        assert!(page.has_more);
        let final_page = store
            .events(Some(first.job.id.clone()), 2, 2)
            .await
            .unwrap();
        assert_eq!(final_page.events[0].event_id, 3);
        assert!(!final_page.has_more);
        let private = store.get_private(first.job.id).await.unwrap();
        assert_eq!(
            private.result,
            Some(serde_json::json!({"artifactKey": "proxy-test"}))
        );
        assert_eq!(private.payload_version, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invalid_mutation_rolls_back_both_record_and_event() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize_for_test(directory.path()).unwrap();
        let job = store
            .enqueue(new_job("rollback", MediaJobKind::Proxy, 2_000))
            .await
            .unwrap()
            .job;
        let result = store
            .transition(
                job.id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Queued,
                    stage: "queued".to_owned(),
                    progress: job.progress.clone(),
                    attempt: None,
                    error: Some(MediaJobError {
                        code: "invalid_media".to_owned(),
                        category: MediaJobErrorCategory::InvalidMedia,
                        message: "Invalid media.".to_owned(),
                        retryable: false,
                        action: None,
                    }),
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("This mutation must roll back.".to_owned()),
                    occurred_at_ms: 2_100,
                },
            )
            .await;
        assert!(result.is_err());
        let jobs = store.list(10, true, None, None).await.unwrap();
        assert_eq!(jobs[0].state, MediaJobState::Queued);
        assert!(jobs[0].error.is_none());
        assert_eq!(
            store
                .events(Some(job.id), 0, 10)
                .await
                .unwrap()
                .events
                .len(),
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restart_recovery_requeues_derived_work_and_blocks_fresh_authorization() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize_for_test(directory.path()).unwrap();
        let proxy = store
            .enqueue(new_job("recover-proxy", MediaJobKind::Proxy, 3_000))
            .await
            .unwrap()
            .job;
        store
            .transition(proxy.id.clone(), running_transition(3_100))
            .await
            .unwrap();

        let mut render_request = new_job("recover-render", MediaJobKind::FinalRender, 3_200);
        render_request.asset_id = None;
        render_request.revision_id = Some("revision-1".to_owned());
        render_request.private_payload = serde_json::json!({"canonicalObjectAvailable": false});
        let render = store.enqueue(render_request).await.unwrap().job;
        drop(store);

        let reopened = MediaJobStore::initialize_for_test(directory.path()).unwrap();
        let report = reopened
            .recover("session-new".to_owned(), 4_000)
            .await
            .unwrap();
        assert_eq!(report.requeued_count, 1);
        assert_eq!(report.blocked_count, 1);
        let jobs = reopened.list(10, true, None, None).await.unwrap();
        assert_eq!(
            jobs.iter().find(|job| job.id == proxy.id).unwrap().state,
            MediaJobState::Queued
        );
        let blocked = jobs.iter().find(|job| job.id == render.id).unwrap();
        assert_eq!(blocked.state, MediaJobState::Blocked);
        assert_eq!(
            blocked.error.as_ref().unwrap().category,
            MediaJobErrorCategory::OutputAuthorizationRequired
        );

        let mut fresh_authorization = new_job("recover-render", MediaJobKind::FinalRender, 4_100);
        fresh_authorization.asset_id = None;
        fresh_authorization.revision_id = Some("revision-1".to_owned());
        fresh_authorization.progress = MediaJobProgress {
            completed: 0,
            total: 200,
            unit: super::super::model::MediaJobProgressUnit::Microseconds,
        };
        fresh_authorization.private_payload = serde_json::json!({
            "ownerLabel": "main",
            "plan": { "revisionId": "revision-1", "fresh": true },
            "overwrite": false,
            "outputAuthorizationPresent": true
        });
        let resumed = reopened
            .enqueue(fresh_authorization)
            .await
            .expect("fresh render authorization must resume the blocked job");
        assert!(resumed.reused);
        assert!(resumed.refreshed);
        assert_eq!(resumed.job.id, render.id);
        assert_eq!(resumed.job.state, MediaJobState::Queued);
        assert!(resumed.job.error.is_none());
        assert_eq!(resumed.job.progress.total, 200);
        let refreshed = reopened.get_private(render.id.clone()).await.unwrap();
        assert_eq!(refreshed.payload_version, 2);
        assert_eq!(refreshed.private_payload["plan"]["fresh"], true);

        reopened
            .transition(render.id.clone(), running_transition(4_200))
            .await
            .unwrap();
        reopened
            .transition(
                render.id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Complete,
                    stage: "complete".to_owned(),
                    progress: MediaJobProgress {
                        completed: 200,
                        total: 200,
                        unit: super::super::model::MediaJobProgressUnit::Microseconds,
                    },
                    attempt: None,
                    error: None,
                    retry_at_ms: None,
                    result: Some(serde_json::json!({"outputPath": "complete.mp4"})),
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("Final render complete.".to_owned()),
                    occurred_at_ms: 4_300,
                },
            )
            .await
            .unwrap();
        let mut duplicate_complete = new_job("recover-render", MediaJobKind::FinalRender, 4_400);
        duplicate_complete.asset_id = None;
        duplicate_complete.revision_id = Some("revision-1".to_owned());
        duplicate_complete.private_payload = serde_json::json!({
            "outputAuthorizationPresent": true,
            "plan": { "fresh": "must-not-replace-complete" }
        });
        let immutable = reopened.enqueue(duplicate_complete).await.unwrap();
        assert!(immutable.reused);
        assert!(!immutable.refreshed);
        assert_eq!(immutable.job.id, render.id);
        assert_eq!(immutable.job.state, MediaJobState::Complete);
        let completed = reopened.get_private(render.id).await.unwrap();
        assert_eq!(completed.payload_version, 2);
        assert_eq!(completed.private_payload["plan"]["fresh"], true);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retention_removes_old_progress_but_preserves_each_terminal_event() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize_for_test(directory.path()).unwrap();
        let job = store
            .enqueue(new_job("retention", MediaJobKind::Proxy, 1_000))
            .await
            .unwrap()
            .job;
        store
            .transition(job.id.clone(), running_transition(1_100))
            .await
            .unwrap();
        store
            .transition(
                job.id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Failed,
                    stage: "failed".to_owned(),
                    progress: MediaJobProgress {
                        completed: 1,
                        total: 100,
                        unit: super::super::model::MediaJobProgressUnit::Frames,
                    },
                    attempt: Some(1),
                    error: Some(MediaJobError {
                        code: "invalid_media".to_owned(),
                        category: MediaJobErrorCategory::InvalidMedia,
                        message: "The media is invalid.".to_owned(),
                        retryable: false,
                        action: None,
                    }),
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("The media is invalid.".to_owned()),
                    occurred_at_ms: 1_200,
                },
            )
            .await
            .unwrap();

        let mut connection = store.state.open_connection().unwrap();
        let transaction = connection.transaction().unwrap();
        enforce_retention(&transaction, 31_i64 * 24 * 60 * 60 * 1_000).unwrap();
        transaction.commit().unwrap();
        let events = store.events(Some(job.id), 0, 10).await.unwrap().events;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].state, MediaJobState::Failed);
    }

    #[test]
    fn corrupt_owned_database_is_quarantined_and_rebuilt() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize_for_test(directory.path()).unwrap();
        let database_path = store.database_path().to_owned();
        drop(store);
        fs::write(&database_path, b"not a sqlite database").unwrap();

        let rebuilt = MediaJobStore::initialize_for_test(directory.path()).unwrap();
        assert!(
            rebuilt
                .recovery_notice()
                .unwrap()
                .unwrap()
                .database_recovered
        );
        assert!(directory
            .path()
            .read_dir()
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
        let connection = rebuilt.state.open_connection().unwrap();
        verify_integrity(&connection).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sqlite_work_does_not_block_the_async_runtime() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize_for_test(directory.path()).unwrap();
        let pending = store.responsiveness_probe(Duration::from_millis(100));
        tokio::pin!(pending);

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(25)) => {}
            result = &mut pending => panic!("SQLite worker settled before the responsiveness proof: {result:?}"),
        }
        tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap();
    }
}
