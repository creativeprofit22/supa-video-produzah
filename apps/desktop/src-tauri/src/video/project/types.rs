use serde::{Deserialize, Serialize};

use crate::video::types::{
    deserialize_optional_non_null, AssetLocator, MediaContentIdentityV1, MediaProbe, RationalRate,
    RationalTime, VideoAsset,
};

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_GROUP_COMMANDS: usize = 100;
pub const MAX_COMMAND_GROUP_BYTES: usize = 1024 * 1024;
pub const MAX_NON_BLANK_UTF16: usize = 512;
pub const MAX_CAPTION_TEXT_UTF16: usize = 16_384;
pub const MAX_LANGUAGE_TAG_UTF16: usize = 64;
pub const MAX_ASSETS: usize = 100_000;
pub const MAX_SEQUENCES: usize = 10_000;
pub const MAX_TRACKS: usize = 10_000;
pub const MAX_TRACK_ITEMS: usize = 100_000;
pub const MAX_MARKERS: usize = 100_000;
pub const MAX_HISTORY_ENTRIES: usize = 10_000;
pub const MAX_AFFECTED_RANGES: usize = 10_000;
pub const MAX_CACHE_INVALIDATIONS: usize = 6;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipTransform {
    pub position_x_permille: i64,
    pub position_y_permille: i64,
    pub scale_x_permille: u64,
    pub scale_y_permille: u64,
    pub rotation_milli_degrees: i64,
    pub opacity_permille: u64,
}

impl Default for ClipTransform {
    fn default() -> Self {
        Self {
            position_x_permille: 0,
            position_y_permille: 0,
            scale_x_permille: 1_000,
            scale_y_permille: 1_000,
            rotation_milli_degrees: 0,
            opacity_permille: 1_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClipSource {
    Asset {
        #[serde(rename = "assetId")]
        asset_id: String,
    },
    Sequence {
        #[serde(rename = "sequenceId")]
        sequence_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectClip {
    pub id: String,
    pub source: ClipSource,
    pub timeline_start: RationalTime,
    pub source_in: RationalTime,
    pub source_out: RationalTime,
    pub transform: ClipTransform,
    pub gain_milli_decibels: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkerColor {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectMarker {
    pub id: String,
    pub time: RationalTime,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<MarkerColor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCaption {
    pub id: String,
    pub start: RationalTime,
    pub end: RationalTime,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProjectTrack {
    Video {
        id: String,
        name: String,
        clips: Vec<ProjectClip>,
    },
    Audio {
        id: String,
        name: String,
        clips: Vec<ProjectClip>,
    },
    Caption {
        id: String,
        name: String,
        captions: Vec<ProjectCaption>,
    },
}

impl ProjectTrack {
    pub fn id(&self) -> &str {
        match self {
            Self::Video { id, .. } | Self::Audio { id, .. } | Self::Caption { id, .. } => id,
        }
    }
    pub fn clips(&self) -> Option<&[ProjectClip]> {
        match self {
            Self::Video { clips, .. } | Self::Audio { clips, .. } => Some(clips),
            Self::Caption { .. } => None,
        }
    }
    pub fn clips_mut(&mut self) -> Option<&mut Vec<ProjectClip>> {
        match self {
            Self::Video { clips, .. } | Self::Audio { clips, .. } => Some(clips),
            Self::Caption { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoSequenceV2 {
    pub id: String,
    pub name: String,
    pub rate: RationalRate,
    pub width: u64,
    pub height: u64,
    pub audio_sample_rate: u64,
    pub tracks: Vec<ProjectTrack>,
    pub markers: Vec<ProjectMarker>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoProjectStateV2 {
    pub assets: Vec<VideoAsset>,
    pub sequences: Vec<VideoSequenceV2>,
    pub active_sequence_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRevisionDescriptorV2 {
    pub number: u64,
    pub id: String,
    pub parent_id: Option<String>,
    pub committed_at: String,
    pub operation_id: String,
    pub state_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheInvalidation {
    Timeline,
    Preview,
    AudioMix,
    Captions,
    RenderPlan,
    AssetSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AffectedRange {
    pub sequence_id: String,
    pub start: RationalTime,
    pub end: RationalTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ProjectCommand {
    ImportAsset {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<u64>,
        asset: VideoAsset,
    },
    CreateSequence {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<u64>,
        #[serde(
            rename = "activeSequenceId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        active_sequence_id: Option<String>,
        sequence: VideoSequenceV2,
    },
    RemoveSequence {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(
            rename = "activeSequenceId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        active_sequence_id: Option<String>,
    },
    InsertTrack {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        index: u64,
        track: ProjectTrack,
    },
    RemoveTrack {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
    },
    InsertClip {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<u64>,
        clip: ProjectClip,
    },
    RemoveClip {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
    },
    RippleDeleteClip {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
    },
    RestoreRippleDeletedClip {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        index: u64,
        clip: ProjectClip,
    },
    SplitClip {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
        #[serde(rename = "splitAt")]
        split_at: RationalTime,
        #[serde(rename = "rightClipId")]
        right_clip_id: String,
    },
    MoveClip {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
        #[serde(rename = "timelineStart")]
        timeline_start: RationalTime,
    },
    TrimClip {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
        #[serde(rename = "sourceIn")]
        source_in: RationalTime,
        #[serde(rename = "sourceOut")]
        source_out: RationalTime,
    },
    SetClipTransform {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
        transform: ClipTransform,
    },
    SetClipGain {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
        #[serde(rename = "gainMilliDecibels")]
        gain_milli_decibels: i64,
    },
    AddMarker {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<u64>,
        marker: ProjectMarker,
    },
    RemoveMarker {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "markerId")]
        marker_id: String,
    },
    AddCaption {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<u64>,
        caption: ProjectCaption,
    },
    RemoveCaption {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "sequenceId")]
        sequence_id: String,
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(rename = "captionId")]
        caption_id: String,
    },
    RelinkAsset {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "assetId")]
        asset_id: String,
        locator: AssetLocator,
        probe: MediaProbe,
        #[serde(
            rename = "contentIdentity",
            default,
            deserialize_with = "deserialize_optional_non_null",
            skip_serializing_if = "Option::is_none"
        )]
        content_identity: Option<MediaContentIdentityV1>,
    },
    RemoveAsset {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "assetId")]
        asset_id: String,
    },
}

impl ProjectCommand {
    pub fn command_id(&self) -> &str {
        match self {
            Self::ImportAsset { command_id, .. }
            | Self::CreateSequence { command_id, .. }
            | Self::RemoveSequence { command_id, .. }
            | Self::InsertTrack { command_id, .. }
            | Self::RemoveTrack { command_id, .. }
            | Self::InsertClip { command_id, .. }
            | Self::RemoveClip { command_id, .. }
            | Self::RippleDeleteClip { command_id, .. }
            | Self::RestoreRippleDeletedClip { command_id, .. }
            | Self::SplitClip { command_id, .. }
            | Self::MoveClip { command_id, .. }
            | Self::TrimClip { command_id, .. }
            | Self::SetClipTransform { command_id, .. }
            | Self::SetClipGain { command_id, .. }
            | Self::AddMarker { command_id, .. }
            | Self::RemoveMarker { command_id, .. }
            | Self::AddCaption { command_id, .. }
            | Self::RemoveCaption { command_id, .. }
            | Self::RelinkAsset { command_id, .. }
            | Self::RemoveAsset { command_id, .. } => command_id,
        }
    }

    pub(crate) fn is_private_inverse(&self) -> bool {
        matches!(self, Self::RestoreRippleDeletedClip { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandGroupRequest {
    pub group_id: String,
    pub project_id: String,
    pub base_revision: u64,
    pub commands: Vec<ProjectCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectHistoryEntryV2 {
    pub group_id: String,
    pub summary: String,
    pub forward_commands: Vec<ProjectCommand>,
    pub inverse_commands: Vec<ProjectCommand>,
    pub affected_ranges: Vec<AffectedRange>,
    pub cache_invalidations: Vec<CacheInvalidation>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectHistoryV2 {
    pub undo_stack: Vec<ProjectHistoryEntryV2>,
    pub redo_stack: Vec<ProjectHistoryEntryV2>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoProjectSnapshotV2 {
    pub schema_version: u64,
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub storage_generation_id: String,
    pub revision: ProjectRevisionDescriptorV2,
    pub state: VideoProjectStateV2,
    pub history: ProjectHistoryV2,
    pub last_applied_record_number: u64,
    pub last_record_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalHealth {
    Healthy,
    SnapshotPending,
    Unhealthy,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStatus {
    Clean,
    Recovered,
    Degraded,
    JournalRecreated,
    MigratedV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastCommandMetadata {
    pub operation_id: String,
    pub group_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectProjection {
    pub project_id: String,
    pub name: String,
    pub revision: ProjectRevisionDescriptorV2,
    pub state: VideoProjectStateV2,
    pub can_undo: bool,
    pub can_redo: bool,
    pub last_command: Option<LastCommandMetadata>,
    pub sources: Vec<super::super::project_io::VideoSourceRecord>,
    pub journal_health: JournalHealth,
    pub snapshot_revision: u64,
    pub recovery_status: RecoveryStatus,
    pub replayed_record_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryReport {
    pub status: RecoveryStatus,
    pub recovered_revision: u64,
    pub replayed_record_count: u64,
    pub discarded_tail_bytes: u64,
    pub message: String,
    pub legacy_history_reset: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenedProjectV2 {
    pub projection: ProjectProjection,
    pub recovery: RecoveryReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandResult {
    pub project_id: String,
    pub operation_id: String,
    pub group_id: String,
    pub prior_revision: ProjectRevisionDescriptorV2,
    pub new_revision: ProjectRevisionDescriptorV2,
    pub state_hash: String,
    pub projection: ProjectProjection,
    pub affected_ranges: Vec<AffectedRange>,
    pub cache_invalidations: Vec<CacheInvalidation>,
    pub events: Vec<ProjectEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProjectEvent {
    ProjectChanged {
        #[serde(rename = "projectId")]
        project_id: String,
        revision: u64,
    },
    HistoryChanged {
        #[serde(rename = "canUndo")]
        can_undo: bool,
        #[serde(rename = "canRedo")]
        can_redo: bool,
    },
    SnapshotWarning {
        message: String,
    },
    RecoveryChanged {
        status: RecoveryStatus,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectInspector {
    pub project_id: String,
    pub revision: ProjectRevisionDescriptorV2,
    pub last_command: Option<LastCommandMetadata>,
    pub snapshot_revision: u64,
    pub journal_health: JournalHealth,
    pub replayed_record_count: u64,
    pub recovery_status: RecoveryStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalHeader {
    pub journal_version: u64,
    pub project_id: String,
    pub storage_generation_id: String,
    pub base_revision: ProjectRevisionDescriptorV2,
    pub base_state_hash: String,
    pub created_at: String,
    pub header_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalRecordKind {
    Commit,
    Undo,
    Redo,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalRecord {
    pub kind: JournalRecordKind,
    pub record_number: u64,
    pub operation_id: String,
    pub group_id: String,
    pub committed_at: String,
    pub base_revision: ProjectRevisionDescriptorV2,
    pub resulting_revision: ProjectRevisionDescriptorV2,
    pub commands: Vec<ProjectCommand>,
    pub history_group: ProjectHistoryEntryV2,
    pub summary: String,
    pub affected_ranges: Vec<AffectedRange>,
    pub cache_invalidations: Vec<CacheInvalidation>,
    pub previous_state_hash: String,
    pub resulting_state_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_result: Option<Box<CommandResult>>,
    pub previous_record_hash: String,
    pub record_hash: String,
}
