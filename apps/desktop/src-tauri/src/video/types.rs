use std::collections::{HashMap, HashSet};

use chrono::DateTime;
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::{
    derived::{DerivedMediaIdentityV1, MediaProfileIdentityV1},
    error::VideoCommandError,
    media_store::SourceFingerprintV1,
};

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn deserialize_schema_version_one<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u64::deserialize(deserializer)?;
    if version != 1 {
        return Err(de::Error::custom("expected schema version 1"));
    }
    Ok(version)
}

fn deserialize_sha256_digest<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let digest = String::deserialize(deserializer)?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(de::Error::custom("expected a lowercase SHA-256 digest"));
    }
    Ok(digest)
}

fn deserialize_positive_safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if !(1..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(de::Error::custom(
            "expected a positive JavaScript-safe integer",
        ));
    }
    Ok(value)
}

fn deserialize_opacity_permille<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > 1_000 {
        return Err(de::Error::custom(
            "expected opacity permille from 0 to 1000",
        ));
    }
    Ok(value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaContentAlgorithm {
    Sha256,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaContentIdentityV1 {
    #[serde(deserialize_with = "deserialize_schema_version_one")]
    pub schema_version: u64,
    pub algorithm: MediaContentAlgorithm,
    #[serde(deserialize_with = "deserialize_sha256_digest")]
    pub digest: String,
    #[serde(deserialize_with = "deserialize_positive_safe_integer")]
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ProjectUuid(String);

impl ProjectUuid {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ProjectUuid {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let text = String::deserialize(deserializer)?;
        if !is_contract_uuid(&text) {
            return Err(de::Error::custom("expected a canonical RFC UUID"));
        }
        Ok(Self(text))
    }
}

pub(crate) fn is_contract_uuid(text: &str) -> bool {
    if text.len() != 36
        || !text.is_ascii()
        || ![8, 13, 18, 23]
            .iter()
            .all(|index| text.as_bytes()[*index] == b'-')
        || text
            .bytes()
            .enumerate()
            .any(|(index, byte)| ![8, 13, 18, 23].contains(&index) && !byte.is_ascii_hexdigit())
    {
        return false;
    }
    if Uuid::parse_str(text).is_err() {
        return false;
    }
    let lowercase = text.to_ascii_lowercase();
    if lowercase == "00000000-0000-0000-0000-000000000000"
        || lowercase == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    matches!(text.as_bytes()[14], b'1'..=b'8')
        && matches!(
            text.as_bytes()[19].to_ascii_lowercase(),
            b'8' | b'9' | b'a' | b'b'
        )
}

pub(crate) fn deserialize_optional_non_null<'de, D, T>(
    deserializer: D,
) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetLocator {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub relative_path: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub absolute_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaAudioShape {
    pub codec_name: String,
    pub channels: u64,
    pub sample_rate: u64,
}

impl MediaAudioShape {
    pub(crate) fn checked(codec_name: String, channels: u64, sample_rate: u64) -> Option<Self> {
        if !is_valid_codec_name(&codec_name)
            || !(1..=64).contains(&channels)
            || !(1..=768_000).contains(&sample_rate)
        {
            return None;
        }
        Some(Self {
            codec_name,
            channels,
            sample_rate,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RationalRate {
    pub numerator: u64,
    pub denominator: u64,
}

impl RationalRate {
    pub(crate) fn checked_reduced(numerator: u64, denominator: u64) -> Option<Self> {
        if numerator == 0
            || denominator == 0
            || numerator > MAX_SAFE_INTEGER
            || denominator > MAX_SAFE_INTEGER
        {
            return None;
        }
        let divisor = greatest_common_divisor(numerator, denominator);
        Some(Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaDisplayShape {
    pub(crate) sample_aspect_ratio: RationalRate,
    pub(crate) display_aspect_ratio: RationalRate,
    pub(crate) rotation_degrees: u16,
}

impl MediaDisplayShape {
    pub(crate) fn checked(
        sample_aspect_ratio: RationalRate,
        display_aspect_ratio: RationalRate,
        rotation_degrees: u16,
    ) -> Option<Self> {
        let sample_aspect_ratio = RationalRate::checked_reduced(
            sample_aspect_ratio.numerator,
            sample_aspect_ratio.denominator,
        )
        .filter(|reduced| *reduced == sample_aspect_ratio)?;
        let display_aspect_ratio = RationalRate::checked_reduced(
            display_aspect_ratio.numerator,
            display_aspect_ratio.denominator,
        )
        .filter(|reduced| *reduced == display_aspect_ratio)?;
        if !matches!(rotation_degrees, 0 | 90 | 180 | 270) {
            return None;
        }
        Some(Self {
            sample_aspect_ratio,
            display_aspect_ratio,
            rotation_degrees,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MediaColorMetadata {
    pub(crate) color_range: Option<String>,
    pub(crate) color_space: Option<String>,
    pub(crate) color_primaries: Option<String>,
    pub(crate) color_transfer: Option<String>,
}

impl MediaColorMetadata {
    pub(crate) fn is_hdr(&self) -> bool {
        matches!(
            self.color_transfer.as_deref(),
            Some("smpte2084" | "arib-std-b67")
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RationalTime {
    pub value: u64,
    pub rate_numerator: u64,
    pub rate_denominator: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaProbe {
    pub duration_microseconds: u64,
    pub average_frame_rate: RationalRate,
    pub real_frame_rate: RationalRate,
    pub variable_frame_rate: bool,
    pub width: u64,
    pub height: u64,
    pub video_codec_name: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub audio: Option<MediaAudioShape>,
    pub file_size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedVideoAsset {
    pub source_fingerprint: SourceFingerprintV1,
    pub source_identity: MediaContentIdentityV1,
    pub source_probe: MediaProbe,
    pub sequence_rate: RationalRate,
    pub profile_identity: MediaProfileIdentityV1,
    pub proxy_identity: DerivedMediaIdentityV1,
    pub proxy_path: String,
    pub proxy_probe: MediaProbe,
    pub thumbnail_identity: DerivedMediaIdentityV1,
    pub thumbnail_path: String,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderExpectation {
    pub duration_frames: u64,
    pub rate: RationalRate,
    pub width: u64,
    pub height: u64,
    pub audio: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub video_hidden: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderExpectationV2 {
    duration_frames: u64,
    rate: RationalRate,
    width: u64,
    height: u64,
    audio: bool,
}

fn deserialize_render_expectation_v2<'de, D>(deserializer: D) -> Result<RenderExpectation, D::Error>
where
    D: Deserializer<'de>,
{
    let expected = RenderExpectationV2::deserialize(deserializer)?;
    Ok(RenderExpectation {
        duration_frames: expected.duration_frames,
        rate: expected.rate,
        width: expected.width,
        height: expected.height,
        audio: expected.audio,
        video_hidden: false,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanV1 {
    pub schema_version: u64,
    pub plan_id: ProjectUuid,
    pub revision_id: ProjectUuid,
    pub executable: String,
    pub input_path: String,
    #[serde(default)]
    pub captions: Vec<RenderCaptionInput>,
    pub output_path: String,
    pub expected: RenderExpectation,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderVideoInputV2 {
    pub asset_id: ProjectUuid,
    pub path: String,
    pub source_in_microseconds: u64,
    #[serde(deserialize_with = "deserialize_opacity_permille")]
    pub opacity_permille: u64,
    pub hidden: bool,
    pub muted: bool,
    pub has_audio: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderCaptionInput {
    pub track_id: ProjectUuid,
    pub caption_id: ProjectUuid,
    pub start_microseconds: u64,
    pub end_microseconds: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanV2 {
    pub schema_version: u64,
    pub plan_id: ProjectUuid,
    pub revision_id: ProjectUuid,
    pub executable: String,
    pub input_paths_by_asset_id: HashMap<ProjectUuid, String>,
    pub video_inputs: Vec<RenderVideoInputV2>,
    #[serde(default)]
    pub captions: Vec<RenderCaptionInput>,
    pub output_path: String,
    #[serde(deserialize_with = "deserialize_render_expectation_v2")]
    pub expected: RenderExpectation,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RenderPlan {
    V1(RenderPlanV1),
    V2(RenderPlanV2),
}

impl RenderPlan {
    pub fn plan_id(&self) -> &ProjectUuid {
        match self {
            Self::V1(plan) => &plan.plan_id,
            Self::V2(plan) => &plan.plan_id,
        }
    }
    pub fn revision_id(&self) -> &ProjectUuid {
        match self {
            Self::V1(plan) => &plan.revision_id,
            Self::V2(plan) => &plan.revision_id,
        }
    }
    pub fn executable(&self) -> &str {
        match self {
            Self::V1(plan) => &plan.executable,
            Self::V2(plan) => &plan.executable,
        }
    }
    pub fn output_path(&self) -> &str {
        match self {
            Self::V1(plan) => &plan.output_path,
            Self::V2(plan) => &plan.output_path,
        }
    }
    pub fn expected(&self) -> &RenderExpectation {
        match self {
            Self::V1(plan) => &plan.expected,
            Self::V2(plan) => &plan.expected,
        }
    }
    pub fn argv(&self) -> &[String] {
        match self {
            Self::V1(plan) => &plan.argv,
            Self::V2(plan) => &plan.argv,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRenderStarted {
    pub job_id: String,
    pub plan_id: String,
    pub revision_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifiedRenderOutput {
    pub output_path: String,
    pub preview_path: String,
    pub probe: MediaProbe,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VideoRenderEvent {
    Started {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "planId")]
        plan_id: String,
        #[serde(rename = "revisionId")]
        revision_id: String,
    },
    Progress {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "planId")]
        plan_id: String,
        #[serde(rename = "revisionId")]
        revision_id: String,
        #[serde(rename = "completedMicroseconds")]
        completed_microseconds: u64,
        #[serde(rename = "durationMicroseconds")]
        duration_microseconds: u64,
    },
    Completed {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "planId")]
        plan_id: String,
        #[serde(rename = "revisionId")]
        revision_id: String,
        output: VerifiedRenderOutput,
    },
    Failed {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "planId")]
        plan_id: String,
        #[serde(rename = "revisionId")]
        revision_id: String,
        error: VideoCommandError,
    },
    Cancelled {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "planId")]
        plan_id: String,
        #[serde(rename = "revisionId")]
        revision_id: String,
    },
}
impl MediaProbe {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn checked(
        duration_microseconds: u64,
        average_frame_rate: RationalRate,
        real_frame_rate: RationalRate,
        variable_frame_rate: bool,
        width: u64,
        height: u64,
        video_codec_name: String,
        audio: Option<MediaAudioShape>,
        file_size_bytes: u64,
    ) -> Option<Self> {
        let positive_safe = |value| (1..=MAX_SAFE_INTEGER).contains(&value);
        if !positive_safe(duration_microseconds)
            || !positive_safe(average_frame_rate.numerator)
            || !positive_safe(average_frame_rate.denominator)
            || !positive_safe(real_frame_rate.numerator)
            || !positive_safe(real_frame_rate.denominator)
            || !positive_safe(width)
            || !positive_safe(height)
            || !positive_safe(file_size_bytes)
            || !is_valid_codec_name(&video_codec_name)
        {
            return None;
        }
        Some(Self {
            duration_microseconds,
            average_frame_rate,
            real_frame_rate,
            variable_frame_rate,
            width,
            height,
            video_codec_name,
            audio,
            file_size_bytes,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoToolProblem {
    NotFound,
    TimedOut,
    Failed,
    InvalidVersion,
    IntegrityFailed,
    IncompatibleBuild,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoToolSource {
    Bundled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoToolInfo {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<VideoToolProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoToolStatus {
    pub source: VideoToolSource,
    pub toolchain_id: String,
    pub ffmpeg: VideoToolInfo,
    pub ffprobe: VideoToolInfo,
    pub ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoAsset {
    pub id: ProjectUuid,
    pub display_name: String,
    pub locator: AssetLocator,
    pub probe: MediaProbe,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub content_identity: Option<MediaContentIdentityV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoClip {
    pub id: ProjectUuid,
    pub asset_id: ProjectUuid,
    pub timeline_start: RationalTime,
    pub source_in: RationalTime,
    pub source_out: RationalTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoTrack {
    pub id: ProjectUuid,
    pub clips: Vec<VideoClip>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoSequence {
    pub id: ProjectUuid,
    pub rate: RationalRate,
    pub width: u64,
    pub height: u64,
    pub audio_sample_rate: u64,
    pub video_tracks: Vec<VideoTrack>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoProjectState {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub asset: Option<VideoAsset>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub sequence: Option<VideoSequence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRevision {
    pub id: ProjectUuid,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub parent_revision_id: Option<ProjectUuid>,
    pub sequence_number: u64,
    pub committed_at: String,
    pub command_summary: String,
    pub state: VideoProjectState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoProjectFileV1 {
    pub schema_version: u64,
    pub id: ProjectUuid,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub current_revision_id: ProjectUuid,
    pub revisions: Vec<ProjectRevision>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub path: String,
    pub message: String,
}

impl VideoProjectFileV1 {
    fn normalize_non_blank_strings(&mut self) {
        normalize_non_blank(&mut self.name);
        for revision in &mut self.revisions {
            normalize_non_blank(&mut revision.command_summary);
            if let Some(asset) = &mut revision.state.asset {
                normalize_non_blank(&mut asset.display_name);
                normalize_non_blank(&mut asset.probe.video_codec_name);
                if let Some(audio) = &mut asset.probe.audio {
                    normalize_non_blank(&mut audio.codec_name);
                }
            }
        }
    }

    pub fn validate(&self) -> Result<(), Vec<ValidationIssue>> {
        let mut issues = Vec::new();
        if self.schema_version != 1 {
            add_issue(&mut issues, "schemaVersion", "must equal 1");
        }
        validate_non_blank(&self.name, "name", &mut issues);
        let created_at = validate_timestamp(&self.created_at, "createdAt", &mut issues);
        let updated_at = validate_timestamp(&self.updated_at, "updatedAt", &mut issues);
        if let (Some(created_at), Some(updated_at)) = (created_at, updated_at) {
            if updated_at < created_at {
                add_issue(&mut issues, "updatedAt", "cannot precede createdAt");
            }
        }
        if self.revisions.is_empty() || self.revisions.len() > 10_000 {
            add_issue(
                &mut issues,
                "revisions",
                "must contain 1 to 10,000 revisions",
            );
        }

        let mut revision_ids = HashSet::new();
        for (index, revision) in self.revisions.iter().enumerate() {
            let path = format!("revisions[{index}]");
            if !revision_ids.insert(revision.id.as_str()) {
                add_issue(&mut issues, &format!("{path}.id"), "must be unique");
            }
            validate_safe_non_negative(
                revision.sequence_number,
                &format!("{path}.sequenceNumber"),
                &mut issues,
            );
            if revision.sequence_number != index as u64 {
                add_issue(
                    &mut issues,
                    &format!("{path}.sequenceNumber"),
                    "must be contiguous from zero",
                );
            }
            let expected_parent = index
                .checked_sub(1)
                .and_then(|parent_index| self.revisions.get(parent_index))
                .map(|parent| &parent.id);
            if revision.parent_revision_id.as_ref() != expected_parent {
                add_issue(
                    &mut issues,
                    &format!("{path}.parentRevisionId"),
                    "must form one linear history",
                );
            }
            validate_timestamp(
                &revision.committed_at,
                &format!("{path}.committedAt"),
                &mut issues,
            );
            validate_non_blank(
                &revision.command_summary,
                &format!("{path}.commandSummary"),
                &mut issues,
            );
            validate_state(&revision.state, &format!("{path}.state"), &mut issues);
        }
        if !self
            .revisions
            .iter()
            .any(|revision| revision.id == self.current_revision_id)
        {
            add_issue(
                &mut issues,
                "currentRevisionId",
                "must identify an existing revision",
            );
        }

        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }
}

pub fn parse_project_json(bytes: &[u8]) -> Result<VideoProjectFileV1, VideoCommandError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        VideoCommandError::invalid_project([json!({
            "path": "$",
            "message": error.to_string(),
        })])
    })?;
    parse_project_value(value)
}

pub fn parse_project_value(mut value: Value) -> Result<VideoProjectFileV1, VideoCommandError> {
    normalize_integral_numbers(&mut value);
    let Some(schema_version) = value.get("schemaVersion") else {
        return Err(VideoCommandError::invalid_project([json!({
            "path": "schemaVersion",
            "message": "is required",
        })]));
    };
    let Some(schema_version_number) = schema_version
        .as_u64()
        .filter(|version| (1..=MAX_SAFE_INTEGER).contains(version))
    else {
        return Err(VideoCommandError::invalid_project([json!({
            "path": "schemaVersion",
            "message": "must be a positive safe integer",
        })]));
    };
    if schema_version_number != 1 {
        return Err(VideoCommandError::unsupported_schema(schema_version));
    }
    let mut document: VideoProjectFileV1 = serde_json::from_value(value).map_err(|error| {
        VideoCommandError::invalid_project([json!({
            "path": "$",
            "message": error.to_string(),
        })])
    })?;
    document.normalize_non_blank_strings();
    document
        .validate()
        .map_err(VideoCommandError::invalid_project)?;
    Ok(document)
}

fn validate_state(state: &VideoProjectState, path: &str, issues: &mut Vec<ValidationIssue>) {
    if let Some(asset) = &state.asset {
        validate_asset(asset, &format!("{path}.asset"), issues);
    }
    if let Some(sequence) = &state.sequence {
        validate_sequence(sequence, &format!("{path}.sequence"), issues);
        let clips = sequence
            .video_tracks
            .first()
            .map_or(&[][..], |track| track.clips.as_slice());
        if !clips.is_empty() && state.asset.is_none() {
            add_issue(issues, path, "a clip requires the project asset");
        }
        if let Some(asset) = &state.asset {
            if clips.iter().any(|clip| clip.asset_id != asset.id) {
                add_issue(
                    issues,
                    path,
                    "clip asset identity must match the project asset",
                );
            }
        }
    }
}

fn validate_asset(asset: &VideoAsset, path: &str, issues: &mut Vec<ValidationIssue>) {
    validate_non_blank(&asset.display_name, &format!("{path}.displayName"), issues);
    validate_locator(&asset.locator, &format!("{path}.locator"), issues);
    validate_positive(
        asset.probe.duration_microseconds,
        &format!("{path}.probe.durationMicroseconds"),
        issues,
    );
    validate_rate(
        &asset.probe.average_frame_rate,
        &format!("{path}.probe.averageFrameRate"),
        issues,
    );
    validate_rate(
        &asset.probe.real_frame_rate,
        &format!("{path}.probe.realFrameRate"),
        issues,
    );
    validate_positive(asset.probe.width, &format!("{path}.probe.width"), issues);
    validate_positive(asset.probe.height, &format!("{path}.probe.height"), issues);
    validate_non_blank(
        &asset.probe.video_codec_name,
        &format!("{path}.probe.videoCodecName"),
        issues,
    );
    validate_positive(
        asset.probe.file_size_bytes,
        &format!("{path}.probe.fileSizeBytes"),
        issues,
    );
    if let Some(audio) = &asset.probe.audio {
        validate_non_blank(
            &audio.codec_name,
            &format!("{path}.probe.audio.codecName"),
            issues,
        );
        validate_positive(
            audio.channels,
            &format!("{path}.probe.audio.channels"),
            issues,
        );
        if audio.channels > 64 {
            add_issue(
                issues,
                &format!("{path}.probe.audio.channels"),
                "must be at most 64",
            );
        }
        validate_positive(
            audio.sample_rate,
            &format!("{path}.probe.audio.sampleRate"),
            issues,
        );
        if audio.sample_rate > 768_000 {
            add_issue(
                issues,
                &format!("{path}.probe.audio.sampleRate"),
                "must be at most 768,000",
            );
        }
    }
}

fn validate_locator(locator: &AssetLocator, path: &str, issues: &mut Vec<ValidationIssue>) {
    if locator.relative_path.is_none() && locator.absolute_path.is_none() {
        add_issue(
            issues,
            path,
            "requires a relative path or absolute fallback",
        );
    }
    if let Some(relative_path) = &locator.relative_path {
        validate_path_text(relative_path, &format!("{path}.relativePath"), issues);
        if !is_safe_relative_path(relative_path) {
            add_issue(
                issues,
                &format!("{path}.relativePath"),
                "must be a safe project-relative path",
            );
        }
    }
    if let Some(absolute_path) = &locator.absolute_path {
        validate_path_text(absolute_path, &format!("{path}.absolutePath"), issues);
        if !is_recognizable_absolute_path(absolute_path) {
            add_issue(
                issues,
                &format!("{path}.absolutePath"),
                "must be an absolute path",
            );
        }
    }
}

fn validate_sequence(sequence: &VideoSequence, path: &str, issues: &mut Vec<ValidationIssue>) {
    validate_rate(&sequence.rate, &format!("{path}.rate"), issues);
    validate_positive(sequence.width, &format!("{path}.width"), issues);
    if sequence.width & 1 == 1 {
        add_issue(issues, &format!("{path}.width"), "must be even");
    }
    validate_positive(sequence.height, &format!("{path}.height"), issues);
    if sequence.height & 1 == 1 {
        add_issue(issues, &format!("{path}.height"), "must be even");
    }
    if sequence.audio_sample_rate != 48_000 {
        add_issue(
            issues,
            &format!("{path}.audioSampleRate"),
            "must equal 48,000",
        );
    }
    if sequence.video_tracks.len() != 1 {
        add_issue(
            issues,
            &format!("{path}.videoTracks"),
            "must contain exactly one track",
        );
        return;
    }
    let track = &sequence.video_tracks[0];
    if track.clips.len() > 1 {
        add_issue(
            issues,
            &format!("{path}.videoTracks[0].clips"),
            "must contain at most one clip",
        );
    }
    for (index, clip) in track.clips.iter().enumerate() {
        validate_clip(
            clip,
            &sequence.rate,
            &format!("{path}.videoTracks[0].clips[{index}]"),
            issues,
        );
    }
}

fn validate_clip(
    clip: &VideoClip,
    sequence_rate: &RationalRate,
    path: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    validate_time(
        &clip.timeline_start,
        &format!("{path}.timelineStart"),
        issues,
    );
    validate_time(&clip.source_in, &format!("{path}.sourceIn"), issues);
    validate_time(&clip.source_out, &format!("{path}.sourceOut"), issues);
    if clip.timeline_start.value != 0 {
        add_issue(
            issues,
            &format!("{path}.timelineStart.value"),
            "must equal zero",
        );
    }
    let clip_rate = RationalRate {
        numerator: clip.timeline_start.rate_numerator,
        denominator: clip.timeline_start.rate_denominator,
    };
    if clip_rate != *sequence_rate
        || clip.source_in.rate_numerator != clip_rate.numerator
        || clip.source_in.rate_denominator != clip_rate.denominator
        || clip.source_out.rate_numerator != clip_rate.numerator
        || clip.source_out.rate_denominator != clip_rate.denominator
    {
        add_issue(issues, path, "clip and sequence rates must match exactly");
    }
    if clip.source_in.value >= clip.source_out.value {
        add_issue(issues, path, "source range must contain at least one frame");
    }
}

fn validate_rate(rate: &RationalRate, path: &str, issues: &mut Vec<ValidationIssue>) {
    validate_positive(rate.numerator, &format!("{path}.numerator"), issues);
    validate_positive(rate.denominator, &format!("{path}.denominator"), issues);
    if rate.numerator > 0
        && rate.denominator > 0
        && greatest_common_divisor(rate.numerator, rate.denominator) != 1
    {
        add_issue(issues, path, "must be reduced");
    }
}

fn validate_time(time: &RationalTime, path: &str, issues: &mut Vec<ValidationIssue>) {
    validate_safe_non_negative(time.value, &format!("{path}.value"), issues);
    validate_positive(
        time.rate_numerator,
        &format!("{path}.rateNumerator"),
        issues,
    );
    validate_positive(
        time.rate_denominator,
        &format!("{path}.rateDenominator"),
        issues,
    );
    if time.rate_numerator > 0
        && time.rate_denominator > 0
        && greatest_common_divisor(time.rate_numerator, time.rate_denominator) != 1
    {
        add_issue(issues, path, "rate must be reduced");
    }
}

fn validate_positive(value: u64, path: &str, issues: &mut Vec<ValidationIssue>) {
    if value == 0 || value > MAX_SAFE_INTEGER {
        add_issue(issues, path, "must be a positive JavaScript-safe integer");
    }
}

fn validate_safe_non_negative(value: u64, path: &str, issues: &mut Vec<ValidationIssue>) {
    if value > MAX_SAFE_INTEGER {
        add_issue(
            issues,
            path,
            "must be a non-negative JavaScript-safe integer",
        );
    }
}

fn normalize_non_blank(value: &mut String) {
    *value = trim_ecmascript_whitespace(value).to_owned();
}

fn validate_non_blank(value: &str, path: &str, issues: &mut Vec<ValidationIssue>) {
    let trimmed = trim_ecmascript_whitespace(value);
    if trimmed.is_empty() || trimmed.encode_utf16().count() > 512 {
        add_issue(
            issues,
            path,
            "must contain 1 to 512 non-whitespace characters",
        );
    }
}

fn trim_ecmascript_whitespace(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'
                | '\u{000A}'
                | '\u{000B}'
                | '\u{000C}'
                | '\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    })
}
fn validate_timestamp(
    value: &str,
    path: &str,
    issues: &mut Vec<ValidationIssue>,
) -> Option<DateTime<chrono::FixedOffset>> {
    match DateTime::parse_from_rfc3339(value) {
        Ok(timestamp) => Some(timestamp),
        Err(_) => {
            add_issue(
                issues,
                path,
                "must be an RFC 3339 timestamp with an explicit offset",
            );
            None
        }
    }
}

fn validate_path_text(value: &str, path: &str, issues: &mut Vec<ValidationIssue>) {
    if value.is_empty() || value.encode_utf16().count() > 32_768 || value.contains('\0') {
        add_issue(
            issues,
            path,
            "must be a non-empty path without NUL characters",
        );
    }
}

pub(crate) fn is_safe_relative_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if path.starts_with(['/', '\\'])
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return false;
    }
    path.split(['/', '\\'])
        .all(|segment| !segment.is_empty() && segment != "..")
}

pub(crate) fn is_recognizable_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive_rooted = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    let posix_rooted = path.starts_with('/');
    let unc =
        if bytes.len() >= 2 && matches!(bytes[0], b'/' | b'\\') && matches!(bytes[1], b'/' | b'\\')
        {
            let mut segments = path[2..].split(['/', '\\']);
            segments.next().is_some_and(|server| !server.is_empty())
                && segments.next().is_some_and(|share| !share.is_empty())
        } else {
            false
        };
    drive_rooted || posix_rooted || unc
}

fn normalize_integral_numbers(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(normalize_integral_numbers),
        Value::Object(values) => values.values_mut().for_each(normalize_integral_numbers),
        Value::Number(number) if number.as_u64().is_none() && number.as_i64().is_none() => {
            if let Some(float) = number.as_f64().filter(|float| float.fract() == 0.0) {
                if float >= 0.0 && float <= u64::MAX as f64 {
                    *number = serde_json::Number::from(float as u64);
                } else if float >= i64::MIN as f64 && float <= i64::MAX as f64 {
                    *number = serde_json::Number::from(float as i64);
                }
            }
        }
        _ => {}
    }
}

fn greatest_common_divisor(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

fn is_valid_codec_name(value: &str) -> bool {
    let trimmed = trim_ecmascript_whitespace(value);
    !trimmed.is_empty() && trimmed.encode_utf16().count() <= 512
}

fn add_issue(issues: &mut Vec<ValidationIssue>, path: &str, message: &str) {
    issues.push(ValidationIssue {
        path: path.to_owned(),
        message: message.to_owned(),
    });
}
