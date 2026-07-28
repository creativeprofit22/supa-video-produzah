use std::time::Duration;

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub(crate) const MEDIA_JOB_SCHEMA_VERSION: u8 = 1;
pub(crate) const MAX_PUBLIC_JOBS: usize = 100;
pub(crate) const MAX_PUBLIC_EVENTS: usize = 500;
pub(crate) const MAX_UNSETTLED_JOBS: usize = 1_000;
pub(crate) const MAX_RETAINED_SETTLED_JOBS: usize = 10_000;
pub(crate) const MAX_RETAINED_EVENTS: usize = 50_000;
pub(crate) const MAX_PRIVATE_JSON_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_PUBLIC_MESSAGE_BYTES: usize = 1_024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaJobKind {
    AssetPreparation,
    Proxy,
    ThumbnailTile,
    FinalRender,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaJobState {
    Queued,
    Probing,
    Running,
    Blocked,
    Retrying,
    Cancelled,
    Failed,
    Complete,
}

impl MediaJobState {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Cancelled | Self::Failed | Self::Complete)
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        use MediaJobState::{
            Blocked, Cancelled, Complete, Failed, Probing, Queued, Retrying, Running,
        };
        matches!(
            (self, next),
            (Queued, Probing | Running | Blocked | Cancelled | Failed)
                | (Probing, Running | Blocked | Retrying | Cancelled | Failed)
                | (Running, Complete | Blocked | Retrying | Cancelled | Failed)
                | (Retrying, Queued | Blocked | Cancelled | Failed)
                | (Blocked, Queued | Cancelled | Failed)
                | (Failed, Queued | Blocked | Cancelled | Failed)
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaJobPriority {
    Interactive,
    Export,
    Background,
}

impl MediaJobPriority {
    pub(crate) fn rank(self) -> u8 {
        match self {
            Self::Interactive => 0,
            Self::Export => 1,
            Self::Background => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaJobProgressUnit {
    Items,
    Bytes,
    Frames,
    Microseconds,
    Stages,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaJobProgress {
    pub(crate) completed: u64,
    pub(crate) total: u64,
    pub(crate) unit: MediaJobProgressUnit,
}

impl MediaJobProgress {
    pub(crate) fn validate(&self) -> Result<(), MediaJobModelError> {
        if self.total != 0 && self.completed > self.total {
            return Err(MediaJobModelError::InvalidProgress);
        }
        ensure_safe_integer(self.completed)?;
        ensure_safe_integer(self.total)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaJobErrorCategory {
    AuthorizationRequired,
    CanonicalObjectMissing,
    ToolchainUnavailable,
    OutputAuthorizationRequired,
    CachePressure,
    TransientIo,
    ProcessFailed,
    InvalidMedia,
    IntegrityFailed,
    PolicyRejected,
    DatabaseRecovered,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaJobRecoveryAction {
    ReauthorizeSource,
    ReauthorizeOutput,
    VerifyToolchain,
    FreeCache,
    Retry,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaJobError {
    pub(crate) code: String,
    pub(crate) category: MediaJobErrorCategory,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    pub(crate) action: Option<MediaJobRecoveryAction>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaJobRecord {
    pub(crate) schema_version: u8,
    pub(crate) id: String,
    pub(crate) kind: MediaJobKind,
    pub(crate) parent_id: Option<String>,
    pub(crate) project_id: Option<String>,
    pub(crate) asset_id: Option<String>,
    pub(crate) revision_id: Option<String>,
    pub(crate) priority: MediaJobPriority,
    pub(crate) state: MediaJobState,
    pub(crate) stage: String,
    pub(crate) progress: MediaJobProgress,
    pub(crate) attempt: u8,
    pub(crate) max_attempts: u8,
    pub(crate) summary: String,
    pub(crate) error: Option<MediaJobError>,
    pub(crate) retry_at: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) started_at: Option<String>,
    pub(crate) settled_at: Option<String>,
    pub(crate) cancellation_requested: bool,
    pub(crate) result_available: bool,
}

impl MediaJobRecord {
    pub(crate) fn validate(&self) -> Result<(), MediaJobModelError> {
        if self.schema_version != MEDIA_JOB_SCHEMA_VERSION {
            return Err(MediaJobModelError::UnsupportedSchema(self.schema_version));
        }
        validate_uuid(&self.id)?;
        validate_optional_uuid(self.parent_id.as_deref())?;
        validate_optional_uuid(self.project_id.as_deref())?;
        validate_optional_uuid(self.asset_id.as_deref())?;
        validate_code(&self.stage)?;
        validate_label(&self.summary, 512)?;
        self.progress.validate()?;
        if self.max_attempts == 0 || self.max_attempts > 100 || self.attempt > self.max_attempts {
            return Err(MediaJobModelError::InvalidAttempt);
        }
        let created_at = validate_timestamp(&self.created_at)?;
        let updated_at = validate_timestamp(&self.updated_at)?;
        if updated_at < created_at {
            return Err(MediaJobModelError::InvalidTimestampOrder);
        }
        for timestamp in [self.started_at.as_deref(), self.settled_at.as_deref()]
            .into_iter()
            .flatten()
        {
            if validate_timestamp(timestamp)? < created_at {
                return Err(MediaJobModelError::InvalidTimestampOrder);
            }
        }
        if let Some(retry_at) = self.retry_at.as_deref() {
            validate_timestamp(retry_at)?;
        }
        if let Some(error) = &self.error {
            validate_code(&error.code)?;
            validate_label(&error.message, 512)?;
        }
        if let Some(revision_id) = self.revision_id.as_deref() {
            validate_label(revision_id, 128)?;
        }

        match self.state {
            MediaJobState::Queued | MediaJobState::Probing | MediaJobState::Running => {
                require(
                    self.settled_at.is_none() && self.retry_at.is_none() && self.error.is_none(),
                )?;
            }
            MediaJobState::Blocked => {
                require(
                    self.settled_at.is_none() && self.retry_at.is_none() && self.error.is_some(),
                )?;
            }
            MediaJobState::Retrying => {
                require(
                    self.settled_at.is_none() && self.retry_at.is_some() && self.error.is_some(),
                )?;
            }
            MediaJobState::Cancelled => {
                require(
                    self.settled_at.is_some() && self.retry_at.is_none() && self.error.is_none(),
                )?;
            }
            MediaJobState::Failed => {
                require(
                    self.settled_at.is_some() && self.retry_at.is_none() && self.error.is_some(),
                )?;
            }
            MediaJobState::Complete => {
                require(
                    self.settled_at.is_some() && self.retry_at.is_none() && self.error.is_none(),
                )?;
            }
        }
        require(self.result_available == (self.state == MediaJobState::Complete))?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaJobEventType {
    Created,
    StateChanged,
    Progress,
    RetryScheduled,
    CancellationRequested,
    Recovered,
    CacheHit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaJobEvent {
    pub(crate) schema_version: u8,
    pub(crate) event_id: u64,
    pub(crate) job_id: String,
    pub(crate) event_type: MediaJobEventType,
    pub(crate) state: MediaJobState,
    pub(crate) stage: String,
    pub(crate) progress: MediaJobProgress,
    pub(crate) message: Option<String>,
    pub(crate) category: Option<MediaJobErrorCategory>,
    pub(crate) created_at: String,
}

impl MediaJobEvent {
    pub(crate) fn validate(&self) -> Result<(), MediaJobModelError> {
        if self.schema_version != MEDIA_JOB_SCHEMA_VERSION {
            return Err(MediaJobModelError::UnsupportedSchema(self.schema_version));
        }
        ensure_safe_integer(self.event_id)?;
        require(self.event_id > 0)?;
        validate_uuid(&self.job_id)?;
        validate_code(&self.stage)?;
        self.progress.validate()?;
        validate_timestamp(&self.created_at)?;
        if let Some(message) = self.message.as_deref() {
            validate_label(message, MAX_PUBLIC_MESSAGE_BYTES)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaJobRecoveryReport {
    pub(crate) schema_version: u8,
    pub(crate) requeued_count: u64,
    pub(crate) blocked_count: u64,
    pub(crate) cancelled_count: u64,
    pub(crate) stale_lease_count: u64,
    pub(crate) database_recovered: bool,
    pub(crate) warning: Option<String>,
    pub(crate) recovered_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaCachePressure {
    Normal,
    OverBudget,
    Pinned,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaCacheStatus {
    pub(crate) schema_version: u8,
    pub(crate) budget_bytes: u64,
    pub(crate) managed_bytes: u64,
    pub(crate) leased_bytes: u64,
    pub(crate) reclaimable_bytes: u64,
    pub(crate) artifact_count: u64,
    pub(crate) leased_artifact_count: u64,
    pub(crate) pressure: MediaCachePressure,
    pub(crate) legacy_bytes: u64,
    pub(crate) legacy_entry_count: u64,
    pub(crate) legacy_unsafe_entry_count: u64,
    pub(crate) legacy_clear_available: bool,
    pub(crate) recovery_warning: Option<String>,
    pub(crate) refreshed_at: String,
}

impl MediaCacheStatus {
    pub(crate) fn validate(&self) -> Result<(), MediaJobModelError> {
        if self.schema_version != MEDIA_JOB_SCHEMA_VERSION {
            return Err(MediaJobModelError::UnsupportedSchema(self.schema_version));
        }
        for value in [
            self.budget_bytes,
            self.managed_bytes,
            self.leased_bytes,
            self.reclaimable_bytes,
            self.artifact_count,
            self.leased_artifact_count,
            self.legacy_bytes,
            self.legacy_entry_count,
            self.legacy_unsafe_entry_count,
        ] {
            ensure_safe_integer(value)?;
        }
        require(self.leased_bytes <= self.managed_bytes)?;
        require(self.reclaimable_bytes <= self.managed_bytes - self.leased_bytes)?;
        require(self.leased_artifact_count <= self.artifact_count)?;
        require(
            self.pressure != MediaCachePressure::Normal || self.managed_bytes <= self.budget_bytes,
        )?;
        require(self.legacy_clear_available == (self.legacy_entry_count > 0))?;
        if let Some(warning) = self.recovery_warning.as_deref() {
            validate_label(warning, 512)?;
        }
        validate_timestamp(&self.refreshed_at)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RetryClassification {
    Transient,
    Actionable,
    Permanent,
}

impl RetryClassification {
    pub(crate) fn from_category(category: MediaJobErrorCategory) -> Self {
        match category {
            MediaJobErrorCategory::TransientIo | MediaJobErrorCategory::ProcessFailed => {
                Self::Transient
            }
            MediaJobErrorCategory::AuthorizationRequired
            | MediaJobErrorCategory::CanonicalObjectMissing
            | MediaJobErrorCategory::ToolchainUnavailable
            | MediaJobErrorCategory::OutputAuthorizationRequired
            | MediaJobErrorCategory::CachePressure => Self::Actionable,
            MediaJobErrorCategory::InvalidMedia
            | MediaJobErrorCategory::IntegrityFailed
            | MediaJobErrorCategory::PolicyRejected
            | MediaJobErrorCategory::DatabaseRecovered => Self::Permanent,
        }
    }
}

pub(crate) fn automatic_retry_delay(retry_number: u8) -> Option<Duration> {
    [1_u64, 5, 30]
        .get(usize::from(retry_number))
        .copied()
        .map(Duration::from_secs)
}

#[derive(Debug, Error, Eq, PartialEq)]
pub(crate) enum MediaJobModelError {
    #[error("unsupported media job schema version {0}")]
    UnsupportedSchema(u8),
    #[error("invalid public media job identifier")]
    InvalidIdentifier,
    #[error("invalid public media job code")]
    InvalidCode,
    #[error("invalid public media job label")]
    InvalidLabel,
    #[error("invalid public media job timestamp")]
    InvalidTimestamp,
    #[error("public media job timestamps are out of order")]
    InvalidTimestampOrder,
    #[error("media job progress is invalid")]
    InvalidProgress,
    #[error("media job attempt is invalid")]
    InvalidAttempt,
    #[error("public media job integer exceeds the JavaScript safe range")]
    UnsafeInteger,
    #[error("media job state fields are inconsistent")]
    InconsistentState,
}

fn ensure_safe_integer(value: u64) -> Result<(), MediaJobModelError> {
    if value <= 9_007_199_254_740_991 {
        Ok(())
    } else {
        Err(MediaJobModelError::UnsafeInteger)
    }
}

fn validate_uuid(value: &str) -> Result<(), MediaJobModelError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| MediaJobModelError::InvalidIdentifier)
}

fn validate_optional_uuid(value: Option<&str>) -> Result<(), MediaJobModelError> {
    value.map_or(Ok(()), validate_uuid)
}

fn validate_code(value: &str) -> Result<(), MediaJobModelError> {
    if !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        Ok(())
    } else {
        Err(MediaJobModelError::InvalidCode)
    }
}

fn validate_label(value: &str, max_bytes: usize) -> Result<(), MediaJobModelError> {
    if !value.trim().is_empty() && value.len() <= max_bytes {
        Ok(())
    } else {
        Err(MediaJobModelError::InvalidLabel)
    }
}

fn validate_timestamp(value: &str) -> Result<i64, MediaJobModelError> {
    let timestamp = DateTime::parse_from_rfc3339(value)
        .map_err(|_| MediaJobModelError::InvalidTimestamp)?
        .timestamp_millis();
    if timestamp >= 0 {
        Ok(timestamp)
    } else {
        Err(MediaJobModelError::InvalidTimestamp)
    }
}

fn require(condition: bool) -> Result<(), MediaJobModelError> {
    if condition {
        Ok(())
    } else {
        Err(MediaJobModelError::InconsistentState)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PublicFixture {
        jobs: Vec<MediaJobRecord>,
        events: Vec<MediaJobEvent>,
        cache_status: MediaCacheStatus,
        recovery: MediaJobRecoveryReport,
    }

    #[test]
    fn shared_public_fixture_has_strict_rust_parity_and_no_private_fields() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/video-media/fixtures/media-state-v1/public-contracts.json");
        let bytes = std::fs::read(path).unwrap();
        let fixture: PublicFixture = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(fixture.jobs.len(), 8);
        assert_eq!(fixture.events.len(), 8);
        for job in &fixture.jobs {
            job.validate().unwrap();
        }
        for event in &fixture.events {
            event.validate().unwrap();
        }
        fixture.cache_status.validate().unwrap();
        assert_eq!(fixture.recovery.schema_version, MEDIA_JOB_SCHEMA_VERSION);
        validate_timestamp(&fixture.recovery.recovered_at).unwrap();

        let serialized = serde_json::to_string(&fixture.jobs).unwrap();
        for forbidden in [
            "privatePayload",
            "sourcePath",
            "ffmpegArgv",
            "stderr",
            "databasePath",
            "lockError",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn transition_retry_and_priority_rules_are_deterministic() {
        assert!(MediaJobState::Queued.can_transition_to(MediaJobState::Running));
        assert!(MediaJobState::Running.can_transition_to(MediaJobState::Retrying));
        assert!(!MediaJobState::Complete.can_transition_to(MediaJobState::Queued));
        assert!(MediaJobState::Complete.is_terminal());
        assert_eq!(MediaJobPriority::Interactive.rank(), 0);
        assert_eq!(MediaJobPriority::Background.rank(), 2);
        assert_eq!(automatic_retry_delay(0), Some(Duration::from_secs(1)));
        assert_eq!(automatic_retry_delay(1), Some(Duration::from_secs(5)));
        assert_eq!(automatic_retry_delay(2), Some(Duration::from_secs(30)));
        assert_eq!(automatic_retry_delay(3), None);
        assert_eq!(
            RetryClassification::from_category(MediaJobErrorCategory::TransientIo),
            RetryClassification::Transient
        );
        assert_eq!(
            RetryClassification::from_category(MediaJobErrorCategory::InvalidMedia),
            RetryClassification::Permanent
        );
    }

    #[test]
    fn strict_public_model_rejects_unknown_and_inconsistent_data() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/video-media/fixtures/media-state-v1/public-contracts.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        value["jobs"][0]["sourcePath"] = serde_json::json!("C:\\private.mp4");
        assert!(serde_json::from_value::<PublicFixture>(value).is_err());
    }
}
