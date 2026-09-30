//! Core rights types. Mirrored (for IPC validation and UI preview only) by
//! `packages/video-contracts/src/rights.ts`. Rust is the authority.

use serde::{Deserialize, Serialize};

use crate::video::media_store::MediaContentIdentityV1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    WikimediaCommons,
    Openverse,
    Smithsonian,
    Pexels,
    Pixabay,
    Freesound,
    InternetArchive,
}

impl ProviderId {
    pub const ALL: [ProviderId; 7] = [
        ProviderId::WikimediaCommons,
        ProviderId::Openverse,
        ProviderId::Smithsonian,
        ProviderId::Pexels,
        ProviderId::Pixabay,
        ProviderId::Freesound,
        ProviderId::InternetArchive,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::WikimediaCommons => "wikimedia-commons",
            ProviderId::Openverse => "openverse",
            ProviderId::Smithsonian => "smithsonian",
            ProviderId::Pexels => "pexels",
            ProviderId::Pixabay => "pixabay",
            ProviderId::Freesound => "freesound",
            ProviderId::InternetArchive => "internet-archive",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|id| id.as_str() == value)
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ProviderId::WikimediaCommons => "Wikimedia Commons",
            ProviderId::Openverse => "Openverse",
            ProviderId::Smithsonian => "Smithsonian Open Access",
            ProviderId::Pexels => "Pexels",
            ProviderId::Pixabay => "Pixabay",
            ProviderId::Freesound => "Freesound",
            ProviderId::InternetArchive => "Internet Archive",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LicenseCode {
    Cc0,
    Pdm,
    By,
    BySa,
    ByNc,
    ByNcSa,
    ByNd,
    ByNcNd,
    Custom,
    Unknown,
}

impl LicenseCode {
    pub fn as_str(self) -> &'static str {
        match self {
            LicenseCode::Cc0 => "cc0",
            LicenseCode::Pdm => "pdm",
            LicenseCode::By => "by",
            LicenseCode::BySa => "by-sa",
            LicenseCode::ByNc => "by-nc",
            LicenseCode::ByNcSa => "by-nc-sa",
            LicenseCode::ByNd => "by-nd",
            LicenseCode::ByNcNd => "by-nc-nd",
            LicenseCode::Custom => "custom",
            LicenseCode::Unknown => "unknown",
        }
    }

    pub fn requires_attribution(self) -> bool {
        self.as_str().starts_with("by")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicenseId {
    pub code: LicenseCode,
    pub version: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsePolicyProfile {
    PrivatePreview,
    NoncommercialPublic,
    CommercialOnline,
    CommercialClient,
    Broadcast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyReasonCode {
    AttributionRequired,
    ShareAlikeObligation,
    NoncommercialOnly,
    NoDerivatives,
    CustomTermsReview,
    LicenseUnknown,
    LicenseConflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyOutcome {
    Allow,
    Warn,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyDecision {
    pub outcome: PolicyOutcome,
    pub reasons: Vec<PolicyReasonCode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaKind {
    Video,
    Image,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuredAttribution {
    pub title: Option<String>,
    pub creator: Option<String>,
    pub creator_url: Option<String>,
    pub source_url: Option<String>,
    pub provider_name: String,
    pub license_name: String,
    pub license_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RightsCandidate {
    pub provider_id: ProviderId,
    pub provider_item_id: String,
    pub media_kind: MediaKind,
    pub title: Option<String>,
    pub creator: Option<String>,
    pub landing_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub license: LicenseId,
    pub duration_ms: Option<u64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub advisory_policy: PolicyDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotKind {
    ApiRecord,
    LandingPage,
    ProviderTerms,
    LicensePage,
}

impl SnapshotKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SnapshotKind::ApiRecord => "api-record",
            SnapshotKind::LandingPage => "landing-page",
            SnapshotKind::ProviderTerms => "provider-terms",
            SnapshotKind::LicensePage => "license-page",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicenseSnapshot {
    pub kind: SnapshotKind,
    pub digest: String,
    pub byte_length: u64,
    pub url: String,
    pub media_type: String,
    pub fetched_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefreshStatus {
    Unchanged,
    Changed,
    Withdrawn,
}

impl RefreshStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RefreshStatus::Unchanged => "unchanged",
            RefreshStatus::Changed => "changed",
            RefreshStatus::Withdrawn => "withdrawn",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquisitionReceipt {
    pub schema_version: u8,
    pub receipt_id: uuid::Uuid,
    pub provider_id: ProviderId,
    pub provider_item_id: String,
    pub project_id: uuid::Uuid,
    pub intended_use: UsePolicyProfile,
    pub media_kind: MediaKind,
    pub media_type: String,
    pub content: MediaContentIdentityV1,
    pub license: LicenseId,
    pub item_license: LicenseId,
    pub collection_license: Option<LicenseId>,
    pub policy: PolicyDecision,
    pub attribution: StructuredAttribution,
    pub snapshots: Vec<LicenseSnapshot>,
    pub etag: Option<String>,
    pub acquired_at_ms: u64,
    pub last_refresh_at_ms: u64,
    pub last_refresh_status: RefreshStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReleaseGateReason {
    ReceiptMissing,
    ReceiptMismatch,
    SnapshotMissing,
    SnapshotTampered,
    RefreshStale,
    UpstreamChanged,
    UpstreamWithdrawn,
    UseBlocked,
    AttributionIncomplete,
}

impl ReleaseGateReason {
    /// Distinct `invalid_render_plan` field names used by the render authority.
    pub fn render_field(self) -> &'static str {
        match self {
            ReleaseGateReason::ReceiptMissing => "rights_receipt_missing",
            ReleaseGateReason::ReceiptMismatch => "rights_receipt_mismatch",
            ReleaseGateReason::SnapshotMissing => "rights_snapshot_missing",
            ReleaseGateReason::SnapshotTampered => "rights_snapshot_tampered",
            ReleaseGateReason::RefreshStale => "rights_refresh_stale",
            ReleaseGateReason::UpstreamChanged => "rights_upstream_changed",
            ReleaseGateReason::UpstreamWithdrawn => "rights_upstream_withdrawn",
            ReleaseGateReason::UseBlocked => "rights_use_blocked",
            ReleaseGateReason::AttributionIncomplete => "rights_attribution_incomplete",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquireRequest {
    pub provider_id: ProviderId,
    pub provider_item_id: String,
    pub intended_use: UsePolicyProfile,
    pub project_id: uuid::Uuid,
}

/// Mirrors `providerItemIdSchema`; rejects traversal, separators and padding.
pub fn is_valid_provider_item_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.contains("..")
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    '.' | '_' | ':' | '~' | ' ' | '(' | ')' | '\'' | '-'
                )
        })
}
