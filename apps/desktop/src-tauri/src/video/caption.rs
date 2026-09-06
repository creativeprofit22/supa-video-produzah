use std::{cmp::Ordering, collections::HashSet};

use chrono::DateTime;
use serde::{Deserialize, Serialize};

use super::{
    project::types::ProjectRevisionDescriptorV2,
    types::{
        is_contract_uuid, MediaContentIdentityV1, RationalRate, RationalTime, MAX_SAFE_INTEGER,
    },
};

const MAX_CUES: usize = 100_000;
const MAX_LINES_PER_CUE: usize = 8;
const MAX_LINE_SCALARS: usize = 4_096;
const MAX_SOURCE_LINKS: usize = 10_000;
const MAX_TRANSCRIPT_WORD_IDS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionTrackLinkV1 {
    pub schema_version: u64,
    pub project_id: String,
    pub project_revision: ProjectRevisionDescriptorV2,
    pub sequence_id: String,
    pub caption_track_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionFontStyle {
    Normal,
    Italic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionHorizontalAlignment {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionVerticalAlignment {
    Top,
    Center,
    Bottom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionTypographyV1 {
    pub font_family: String,
    pub font_size_px: u64,
    pub font_weight: u64,
    pub font_style: CaptionFontStyle,
    pub line_height_permille: u64,
    pub foreground_color_rgba: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionAlignmentV1 {
    pub horizontal: CaptionHorizontalAlignment,
    pub vertical: CaptionVerticalAlignment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionStyleV1 {
    pub schema_version: u64,
    pub typography: CaptionTypographyV1,
    pub alignment: CaptionAlignmentV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum CaptionValidationIssueCode {
    #[serde(rename = "CAPTION_SCHEMA_INVALID")]
    SchemaInvalid,
    #[serde(rename = "CAPTION_VERSION_UNSUPPORTED")]
    VersionUnsupported,
    #[serde(rename = "CAPTION_TRACK_LINK_INVALID")]
    TrackLinkInvalid,
    #[serde(rename = "CAPTION_STYLE_INVALID")]
    StyleInvalid,
    #[serde(rename = "CAPTION_SAFE_AREA_INVALID")]
    SafeAreaInvalid,
    #[serde(rename = "CAPTION_DURATION_PROFILE_INVALID")]
    DurationProfileInvalid,
    #[serde(rename = "CAPTION_SOURCE_SPAN_INVALID")]
    SourceSpanInvalid,
    #[serde(rename = "CAPTION_SOURCE_WORD_DUPLICATE")]
    SourceWordDuplicate,
    #[serde(rename = "CAPTION_CUE_ID_DUPLICATE")]
    CueIdDuplicate,
    #[serde(rename = "CAPTION_CUE_RATE_MISMATCH")]
    CueRateMismatch,
    #[serde(rename = "CAPTION_CUE_DURATION_NON_POSITIVE")]
    CueDurationNonPositive,
    #[serde(rename = "CAPTION_CUE_OVERLAP")]
    CueOverlap,
    #[serde(rename = "CAPTION_LINE_COUNT_EXCEEDED")]
    LineCountExceeded,
    #[serde(rename = "CAPTION_LINE_LENGTH_EXCEEDED")]
    LineLengthExceeded,
    #[serde(rename = "CAPTION_CUE_TOO_SHORT")]
    CueTooShort,
    #[serde(rename = "CAPTION_CUE_TOO_LONG")]
    CueTooLong,
    #[serde(rename = "CAPTION_CPS_EXCEEDED")]
    CpsExceeded,
    #[serde(rename = "CAPTION_SAFE_AREA_EXCEEDED")]
    SafeAreaExceeded,
    #[serde(rename = "CAPTION_TRANSCRIPT_LINK_MISMATCH")]
    TranscriptLinkMismatch,
    #[serde(rename = "CAPTION_SOURCE_LINK_OVERLAP")]
    SourceLinkOverlap,
    #[serde(rename = "CAPTION_TRANSCRIPT_WORD_REUSED")]
    TranscriptWordReused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionValidationIssueV1 {
    pub code: CaptionValidationIssueCode,
    pub path: String,
    pub cue_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionValidationResultV1 {
    pub schema_version: u64,
    pub valid: bool,
    pub issues: Vec<CaptionValidationIssueV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionSafeAreaV1 {
    pub top_permille: u64,
    pub right_permille: u64,
    pub bottom_permille: u64,
    pub left_permille: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionValidationProfileV1 {
    pub schema_version: u64,
    pub max_lines_per_cue: u64,
    pub max_characters_per_line: u64,
    pub max_characters_per_second: u64,
    pub minimum_cue_duration: RationalTime,
    pub maximum_cue_duration: RationalTime,
    pub safe_area: CaptionSafeAreaV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionAnchorV1 {
    pub x_permille: u64,
    pub y_permille: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionSourceLinkV1 {
    pub transcript_artifact_identity_key: String,
    pub source_start_us: u64,
    pub source_end_us: u64,
    pub transcript_word_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionCueV1 {
    pub schema_version: u64,
    pub cue_id: String,
    pub start: RationalTime,
    pub end: RationalTime,
    pub lines: Vec<String>,
    pub anchor: CaptionAnchorV1,
    pub source_links: Vec<CaptionSourceLinkV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionArtifactV1 {
    pub schema_version: u64,
    pub track_link: CaptionTrackLinkV1,
    pub source_identity: MediaContentIdentityV1,
    pub transcript_artifact_identity_key: String,
    pub language: String,
    pub timeline_rate: RationalRate,
    pub style: CaptionStyleV1,
    pub validation_profile: CaptionValidationProfileV1,
    pub cues: Vec<CaptionCueV1>,
}

pub fn parse_caption_artifact(
    bytes: &[u8],
) -> Result<CaptionArtifactV1, CaptionValidationResultV1> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| {
        validation_result(validation_issue(
            CaptionValidationIssueCode::SchemaInvalid,
            "$",
        ))
    })?;
    if let Some(issue) = unsupported_version_issue(&value) {
        return Err(validation_result(issue));
    }
    let artifact: CaptionArtifactV1 = serde_json::from_value(value).map_err(|_| {
        validation_result(validation_issue(
            CaptionValidationIssueCode::SchemaInvalid,
            "$",
        ))
    })?;
    validate_caption_artifact(&artifact)?;
    Ok(artifact)
}

pub fn validate_caption_artifact(
    artifact: &CaptionArtifactV1,
) -> Result<(), CaptionValidationResultV1> {
    let result = caption_validation_result(artifact);
    if result.valid {
        Ok(())
    } else {
        Err(result)
    }
}

pub fn caption_validation_result(artifact: &CaptionArtifactV1) -> CaptionValidationResultV1 {
    let issue = validate_track_link(&artifact.track_link)
        .or_else(|| validate_style(&artifact.style))
        .or_else(|| {
            validate_caption_artifact_inner(artifact)
                .err()
                .map(|message| legacy_validation_issue(&message))
        });
    issue.map_or(
        CaptionValidationResultV1 {
            schema_version: 1,
            valid: true,
            issues: Vec::new(),
        },
        validation_result,
    )
}

fn validate_caption_artifact_inner(artifact: &CaptionArtifactV1) -> Result<(), String> {
    if artifact.schema_version != 1 {
        return Err("caption artifact schema version must be 1".to_owned());
    }
    if !is_sha256(&artifact.transcript_artifact_identity_key) {
        return Err("caption transcript identity must be a SHA-256 digest".to_owned());
    }
    if !is_language_tag(&artifact.language) {
        return Err("caption language must be a bounded language tag".to_owned());
    }
    validate_rate(&artifact.timeline_rate)?;
    validate_profile(&artifact.validation_profile)?;
    if artifact.cues.len() > MAX_CUES {
        return Err("caption artifact has too many cues".to_owned());
    }

    let mut cue_ids = HashSet::new();
    let mut previous_end = None;
    for cue in &artifact.cues {
        if cue.schema_version != 1 {
            return Err("caption cue schema version must be 1".to_owned());
        }
        if !is_ascii_identifier(&cue.cue_id, 128) || !cue_ids.insert(cue.cue_id.as_str()) {
            return Err("caption cue id must be valid and unique".to_owned());
        }
        validate_time(&cue.start)?;
        validate_time(&cue.end)?;
        if !time_uses_rate(&cue.start, &artifact.timeline_rate)
            || !time_uses_rate(&cue.end, &artifact.timeline_rate)
        {
            return Err("caption cue timing must use the artifact rate".to_owned());
        }
        if cue.end.value <= cue.start.value {
            return Err("caption cue duration must be positive".to_owned());
        }
        if previous_end.is_some_and(|end| cue.start.value < end) {
            return Err("caption cues cannot overlap".to_owned());
        }
        previous_end = Some(cue.end.value);
        validate_cue(cue, artifact)?;
    }
    Ok(())
}

fn validate_track_link(link: &CaptionTrackLinkV1) -> Option<CaptionValidationIssueV1> {
    if link.schema_version != 1 {
        return Some(validation_issue(
            CaptionValidationIssueCode::VersionUnsupported,
            "$.trackLink.schemaVersion",
        ));
    }
    let revision = &link.project_revision;
    if !is_contract_uuid(&link.project_id)
        || !is_contract_uuid(&link.sequence_id)
        || !is_contract_uuid(&link.caption_track_id)
        || revision.number > MAX_SAFE_INTEGER
        || !is_contract_uuid(&revision.id)
        || revision
            .parent_id
            .as_deref()
            .is_some_and(|id| !is_contract_uuid(id))
        || !is_contract_uuid(&revision.operation_id)
        || DateTime::parse_from_rfc3339(&revision.committed_at).is_err()
        || !is_sha256(&revision.state_hash)
    {
        return Some(validation_issue(
            CaptionValidationIssueCode::TrackLinkInvalid,
            "$.trackLink",
        ));
    }
    None
}

fn validate_style(style: &CaptionStyleV1) -> Option<CaptionValidationIssueV1> {
    if style.schema_version != 1 {
        return Some(validation_issue(
            CaptionValidationIssueCode::VersionUnsupported,
            "$.style.schemaVersion",
        ));
    }
    let typography = &style.typography;
    if typography.font_family.is_empty()
        || typography.font_family.trim().is_empty()
        || typography.font_family.encode_utf16().count() > 128
        || !(8..=256).contains(&typography.font_size_px)
        || !(100..=900).contains(&typography.font_weight)
        || !typography.font_weight.is_multiple_of(100)
        || !(500..=3_000).contains(&typography.line_height_permille)
        || !is_rgba_color(&typography.foreground_color_rgba)
    {
        return Some(validation_issue(
            CaptionValidationIssueCode::StyleInvalid,
            "$.style",
        ));
    }
    None
}

fn legacy_validation_issue(message: &str) -> CaptionValidationIssueV1 {
    use CaptionValidationIssueCode as Code;
    let (code, path) = match message {
        "caption artifact schema version must be 1"
        | "caption validation profile schema version must be 1"
        | "caption cue schema version must be 1" => (Code::VersionUnsupported, "$"),
        "caption safe area must leave positive width and height" => {
            (Code::SafeAreaInvalid, "$.validationProfile.safeArea")
        }
        "caption maximum duration is shorter than its minimum" => (
            Code::DurationProfileInvalid,
            "$.validationProfile.maximumCueDuration",
        ),
        "caption cue id must be valid and unique" => (Code::CueIdDuplicate, "$.cues"),
        "caption cue timing must use the artifact rate" => (Code::CueRateMismatch, "$.cues"),
        "caption cue duration must be positive" => (Code::CueDurationNonPositive, "$.cues"),
        "caption cues cannot overlap" => (Code::CueOverlap, "$.cues"),
        "caption cue line count is out of range" => (Code::LineCountExceeded, "$.cues"),
        "caption line exceeds the Unicode-scalar limit" => (Code::LineLengthExceeded, "$.cues"),
        "caption cue is shorter than the minimum duration" => (Code::CueTooShort, "$.cues"),
        "caption cue is longer than the maximum duration" => (Code::CueTooLong, "$.cues"),
        "caption cue exceeds the Unicode-scalar CPS limit" => (Code::CpsExceeded, "$.cues"),
        "caption anchor must remain inside the safe area" => (Code::SafeAreaExceeded, "$.cues"),
        "caption source span must be positive and safe" => (Code::SourceSpanInvalid, "$.cues"),
        "caption source link references another transcript" => {
            (Code::TranscriptLinkMismatch, "$.cues")
        }
        "caption source links overlap" => (Code::SourceLinkOverlap, "$.cues"),
        "caption transcript word is reused" => (Code::TranscriptWordReused, "$.cues"),
        "caption source link repeats a transcript word" => (Code::SourceWordDuplicate, "$.cues"),
        _ => (Code::SchemaInvalid, "$"),
    };
    validation_issue(code, path)
}

fn validation_issue(code: CaptionValidationIssueCode, path: &str) -> CaptionValidationIssueV1 {
    CaptionValidationIssueV1 {
        code,
        path: path.to_owned(),
        cue_id: None,
    }
}

fn validation_result(issue: CaptionValidationIssueV1) -> CaptionValidationResultV1 {
    CaptionValidationResultV1 {
        schema_version: 1,
        valid: false,
        issues: vec![issue],
    }
}

fn unsupported_version_issue(value: &serde_json::Value) -> Option<CaptionValidationIssueV1> {
    for (path, version) in [
        ("$.schemaVersion", value.get("schemaVersion")),
        (
            "$.trackLink.schemaVersion",
            value
                .get("trackLink")
                .and_then(|link| link.get("schemaVersion")),
        ),
        (
            "$.sourceIdentity.schemaVersion",
            value
                .get("sourceIdentity")
                .and_then(|source| source.get("schemaVersion")),
        ),
        (
            "$.style.schemaVersion",
            value
                .get("style")
                .and_then(|style| style.get("schemaVersion")),
        ),
        (
            "$.validationProfile.schemaVersion",
            value
                .get("validationProfile")
                .and_then(|profile| profile.get("schemaVersion")),
        ),
    ] {
        if version
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|version| version != 1)
        {
            return Some(validation_issue(
                CaptionValidationIssueCode::VersionUnsupported,
                path,
            ));
        }
    }
    value
        .get("cues")
        .and_then(serde_json::Value::as_array)
        .and_then(|cues| {
            cues.iter().enumerate().find_map(|(index, cue)| {
                cue.get("schemaVersion")
                    .and_then(serde_json::Value::as_u64)
                    .filter(|version| *version != 1)
                    .map(|_| {
                        let mut issue = validation_issue(
                            CaptionValidationIssueCode::VersionUnsupported,
                            &format!("$.cues[{index}].schemaVersion"),
                        );
                        issue.cue_id = cue
                            .get("cueId")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned);
                        issue
                    })
            })
        })
}

fn validate_profile(profile: &CaptionValidationProfileV1) -> Result<(), String> {
    if profile.schema_version != 1 {
        return Err("caption validation profile schema version must be 1".to_owned());
    }
    if !(1..=MAX_LINES_PER_CUE as u64).contains(&profile.max_lines_per_cue)
        || !(1..=1_024).contains(&profile.max_characters_per_line)
        || !(1..=1_000).contains(&profile.max_characters_per_second)
    {
        return Err("caption validation thresholds are out of range".to_owned());
    }
    validate_time(&profile.minimum_cue_duration)?;
    validate_time(&profile.maximum_cue_duration)?;
    if compare_times(&profile.minimum_cue_duration, &profile.maximum_cue_duration)?
        == Ordering::Greater
    {
        return Err("caption maximum duration is shorter than its minimum".to_owned());
    }
    let safe = &profile.safe_area;
    if safe.top_permille > 999
        || safe.right_permille > 999
        || safe.bottom_permille > 999
        || safe.left_permille > 999
        || safe.left_permille + safe.right_permille >= 1_000
        || safe.top_permille + safe.bottom_permille >= 1_000
    {
        return Err("caption safe area must leave positive width and height".to_owned());
    }
    Ok(())
}

fn validate_cue(cue: &CaptionCueV1, artifact: &CaptionArtifactV1) -> Result<(), String> {
    let profile = &artifact.validation_profile;
    if cue.lines.is_empty()
        || cue.lines.len() > MAX_LINES_PER_CUE
        || cue.lines.len() as u64 > profile.max_lines_per_cue
    {
        return Err("caption cue line count is out of range".to_owned());
    }

    let mut scalar_count = 0_u64;
    for line in &cue.lines {
        let line_scalars = line.chars().count();
        if line.is_empty()
            || line.trim().is_empty()
            || line_scalars > MAX_LINE_SCALARS
            || line_scalars as u64 > profile.max_characters_per_line
        {
            return Err("caption line exceeds the Unicode-scalar limit".to_owned());
        }
        scalar_count = scalar_count
            .checked_add(line_scalars as u64)
            .ok_or_else(|| "caption scalar count overflowed".to_owned())?;
    }

    let duration_frames = cue.end.value - cue.start.value;
    if compare_frame_duration(duration_frames, &cue.start, &profile.minimum_cue_duration)?
        == Ordering::Less
    {
        return Err("caption cue is shorter than the minimum duration".to_owned());
    }
    if compare_frame_duration(duration_frames, &cue.start, &profile.maximum_cue_duration)?
        == Ordering::Greater
    {
        return Err("caption cue is longer than the maximum duration".to_owned());
    }

    let cps_left = u128::from(scalar_count) * u128::from(cue.start.rate_numerator);
    let cps_right = u128::from(profile.max_characters_per_second)
        * u128::from(duration_frames)
        * u128::from(cue.start.rate_denominator);
    if cps_left > cps_right {
        return Err("caption cue exceeds the Unicode-scalar CPS limit".to_owned());
    }

    let safe = &profile.safe_area;
    if cue.anchor.x_permille > 1_000
        || cue.anchor.y_permille > 1_000
        || cue.anchor.x_permille < safe.left_permille
        || cue.anchor.x_permille > 1_000 - safe.right_permille
        || cue.anchor.y_permille < safe.top_permille
        || cue.anchor.y_permille > 1_000 - safe.bottom_permille
    {
        return Err("caption anchor must remain inside the safe area".to_owned());
    }

    validate_source_links(cue, &artifact.transcript_artifact_identity_key)
}

fn validate_source_links(cue: &CaptionCueV1, transcript_key: &str) -> Result<(), String> {
    if cue.source_links.is_empty() || cue.source_links.len() > MAX_SOURCE_LINKS {
        return Err("caption cue source-link count is out of range".to_owned());
    }
    let mut previous_end = None;
    let mut cue_word_ids = HashSet::new();
    for link in &cue.source_links {
        if link.transcript_artifact_identity_key != transcript_key {
            return Err("caption source link references another transcript".to_owned());
        }
        if link.source_end_us <= link.source_start_us
            || link.source_end_us > MAX_SAFE_INTEGER
            || link.source_start_us > MAX_SAFE_INTEGER
        {
            return Err("caption source span must be positive and safe".to_owned());
        }
        if previous_end.is_some_and(|end| link.source_start_us < end) {
            return Err("caption source links overlap".to_owned());
        }
        if link.transcript_word_ids.is_empty()
            || link.transcript_word_ids.len() > MAX_TRANSCRIPT_WORD_IDS
        {
            return Err("caption transcript word links must be bounded and unique".to_owned());
        }
        previous_end = Some(link.source_end_us);
        let mut link_word_ids = HashSet::new();
        for word_id in &link.transcript_word_ids {
            if word_id.is_empty() || word_id.encode_utf16().count() > 256 {
                return Err("caption transcript word links must be bounded and unique".to_owned());
            }
            if !link_word_ids.insert(word_id.as_str()) {
                return Err("caption source link repeats a transcript word".to_owned());
            }
            if !cue_word_ids.insert(word_id.as_str()) {
                return Err("caption transcript word is reused".to_owned());
            }
        }
    }
    Ok(())
}

fn validate_rate(rate: &RationalRate) -> Result<(), String> {
    if rate.numerator == 0
        || rate.denominator == 0
        || rate.numerator > MAX_SAFE_INTEGER
        || rate.denominator > MAX_SAFE_INTEGER
        || greatest_common_divisor(rate.numerator, rate.denominator) != 1
    {
        return Err("caption rational rate must be positive, safe, and reduced".to_owned());
    }
    Ok(())
}

fn validate_time(time: &RationalTime) -> Result<(), String> {
    if time.value > MAX_SAFE_INTEGER {
        return Err("caption rational time value must be a safe integer".to_owned());
    }
    validate_rate(&RationalRate {
        numerator: time.rate_numerator,
        denominator: time.rate_denominator,
    })
}

fn time_uses_rate(time: &RationalTime, rate: &RationalRate) -> bool {
    time.rate_numerator == rate.numerator && time.rate_denominator == rate.denominator
}

fn compare_times(left: &RationalTime, right: &RationalTime) -> Result<Ordering, String> {
    validate_time(left)?;
    validate_time(right)?;
    Ok(compare_positive_fractions(
        u128::from(left.value) * u128::from(left.rate_denominator),
        u128::from(left.rate_numerator),
        u128::from(right.value) * u128::from(right.rate_denominator),
        u128::from(right.rate_numerator),
    ))
}

fn compare_frame_duration(
    frame_count: u64,
    frame_time: &RationalTime,
    threshold: &RationalTime,
) -> Result<Ordering, String> {
    validate_time(frame_time)?;
    validate_time(threshold)?;
    Ok(compare_positive_fractions(
        u128::from(frame_count) * u128::from(frame_time.rate_denominator),
        u128::from(frame_time.rate_numerator),
        u128::from(threshold.value) * u128::from(threshold.rate_denominator),
        u128::from(threshold.rate_numerator),
    ))
}

fn compare_positive_fractions(
    mut left_numerator: u128,
    mut left_denominator: u128,
    mut right_numerator: u128,
    mut right_denominator: u128,
) -> Ordering {
    let mut reversed = false;
    loop {
        let left_quotient = left_numerator / left_denominator;
        let right_quotient = right_numerator / right_denominator;
        if left_quotient != right_quotient {
            return if reversed {
                right_quotient.cmp(&left_quotient)
            } else {
                left_quotient.cmp(&right_quotient)
            };
        }

        let left_remainder = left_numerator % left_denominator;
        let right_remainder = right_numerator % right_denominator;
        match (left_remainder == 0, right_remainder == 0) {
            (true, true) => return Ordering::Equal,
            (true, false) => {
                return if reversed {
                    Ordering::Greater
                } else {
                    Ordering::Less
                };
            }
            (false, true) => {
                return if reversed {
                    Ordering::Less
                } else {
                    Ordering::Greater
                };
            }
            (false, false) => {}
        }
        left_numerator = left_denominator;
        left_denominator = left_remainder;
        right_numerator = right_denominator;
        right_denominator = right_remainder;
        reversed = !reversed;
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

fn is_rgba_color(value: &str) -> bool {
    value.len() == 9
        && value.starts_with('#')
        && value[1..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_ascii_identifier(value: &str, max_length: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_language_tag(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && value.split('-').all(|segment| {
            !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{
        caption_validation_result, parse_caption_artifact, validate_caption_artifact,
        CaptionArtifactV1, CaptionValidationIssueCode, CaptionValidationResultV1, MAX_SAFE_INTEGER,
    };

    fn fixture_value() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../packages/video-media/fixtures/caption-artifact-v1.json"
        ))
        .expect("shared caption fixture must be JSON")
    }

    fn fixture() -> CaptionArtifactV1 {
        parse_value(fixture_value()).expect("shared caption fixture must match the Rust mirror")
    }

    fn parse_value(value: Value) -> Result<CaptionArtifactV1, CaptionValidationResultV1> {
        parse_caption_artifact(&serde_json::to_vec(&value).expect("test JSON must serialize"))
    }

    fn validation_codes(value: Value) -> Vec<CaptionValidationIssueCode> {
        let artifact: CaptionArtifactV1 =
            serde_json::from_value(value).expect("validation vector must match the Rust shape");
        caption_validation_result(&artifact)
            .issues
            .into_iter()
            .map(|issue| issue.code)
            .collect()
    }

    fn one_cue() -> Value {
        let mut value = fixture_value();
        value["cues"]
            .as_array_mut()
            .expect("cues must be an array")
            .truncate(1);
        value
    }

    #[test]
    fn validation_issue_codes_preserve_the_wire_contract() {
        use CaptionValidationIssueCode as Code;
        let cases = [
            (Code::SchemaInvalid, "CAPTION_SCHEMA_INVALID"),
            (Code::VersionUnsupported, "CAPTION_VERSION_UNSUPPORTED"),
            (Code::TrackLinkInvalid, "CAPTION_TRACK_LINK_INVALID"),
            (Code::StyleInvalid, "CAPTION_STYLE_INVALID"),
            (Code::SafeAreaInvalid, "CAPTION_SAFE_AREA_INVALID"),
            (
                Code::DurationProfileInvalid,
                "CAPTION_DURATION_PROFILE_INVALID",
            ),
            (Code::SourceSpanInvalid, "CAPTION_SOURCE_SPAN_INVALID"),
            (Code::SourceWordDuplicate, "CAPTION_SOURCE_WORD_DUPLICATE"),
            (Code::CueIdDuplicate, "CAPTION_CUE_ID_DUPLICATE"),
            (Code::CueRateMismatch, "CAPTION_CUE_RATE_MISMATCH"),
            (
                Code::CueDurationNonPositive,
                "CAPTION_CUE_DURATION_NON_POSITIVE",
            ),
            (Code::CueOverlap, "CAPTION_CUE_OVERLAP"),
            (Code::LineCountExceeded, "CAPTION_LINE_COUNT_EXCEEDED"),
            (Code::LineLengthExceeded, "CAPTION_LINE_LENGTH_EXCEEDED"),
            (Code::CueTooShort, "CAPTION_CUE_TOO_SHORT"),
            (Code::CueTooLong, "CAPTION_CUE_TOO_LONG"),
            (Code::CpsExceeded, "CAPTION_CPS_EXCEEDED"),
            (Code::SafeAreaExceeded, "CAPTION_SAFE_AREA_EXCEEDED"),
            (
                Code::TranscriptLinkMismatch,
                "CAPTION_TRANSCRIPT_LINK_MISMATCH",
            ),
            (Code::SourceLinkOverlap, "CAPTION_SOURCE_LINK_OVERLAP"),
            (Code::TranscriptWordReused, "CAPTION_TRANSCRIPT_WORD_REUSED"),
        ];
        for (code, wire) in cases {
            assert_eq!(serde_json::to_value(code).unwrap(), json!(wire));
            assert_eq!(serde_json::from_value::<Code>(json!(wire)).unwrap(), code);
        }
    }

    #[test]
    fn shared_fixture_round_trips_through_the_strict_mirror() {
        let artifact = fixture();
        validate_caption_artifact(&artifact).unwrap();
        assert_eq!(artifact.track_link.project_revision.number, 7);
        assert_eq!(artifact.style.typography.font_family, "Inter");
        assert_eq!(artifact.timeline_rate.numerator, 24);
        assert_eq!(artifact.cues[0].lines[0].chars().count(), 8);
        assert_eq!(
            serde_json::to_value(artifact).unwrap(),
            fixture_value(),
            "the Rust mirror must preserve the shared contract"
        );
    }

    #[test]
    fn rejects_unknown_fields_and_all_schema_versions() {
        for path in ["trackLink", "style", "cue"] {
            let mut unknown = fixture_value();
            match path {
                "trackLink" => unknown["trackLink"]["unexpected"] = json!(true),
                "style" => unknown["style"]["typography"]["unexpected"] = json!(true),
                "cue" => unknown["cues"][0]["anchor"]["unexpected"] = json!(true),
                _ => unreachable!(),
            }
            assert!(parse_value(unknown).is_err());
        }

        for path in ["artifact", "trackLink", "style", "source", "profile", "cue"] {
            let mut value = fixture_value();
            match path {
                "artifact" => value["schemaVersion"] = json!(2),
                "trackLink" => value["trackLink"]["schemaVersion"] = json!(2),
                "style" => value["style"]["schemaVersion"] = json!(2),
                "source" => value["sourceIdentity"]["schemaVersion"] = json!(2),
                "profile" => value["validationProfile"]["schemaVersion"] = json!(2),
                "cue" => value["cues"][0]["schemaVersion"] = json!(2),
                _ => unreachable!(),
            }
            let error = parse_value(value).expect_err("invalid version was accepted");
            assert_eq!(
                error.issues[0].code,
                CaptionValidationIssueCode::VersionUnsupported,
                "missing stable version code for {path}"
            );
        }
    }

    #[test]
    fn validates_versioned_track_linkage_boundaries() {
        let mut boundary = fixture_value();
        boundary["trackLink"]["projectRevision"]["number"] = json!(MAX_SAFE_INTEGER);
        assert!(validation_codes(boundary).is_empty());

        let mut unsafe_revision = fixture_value();
        unsafe_revision["trackLink"]["projectRevision"]["number"] = json!(MAX_SAFE_INTEGER + 1);
        assert_eq!(
            validation_codes(unsafe_revision),
            vec![CaptionValidationIssueCode::TrackLinkInvalid]
        );

        for field in ["projectId", "sequenceId", "captionTrackId"] {
            let mut invalid_id = fixture_value();
            invalid_id["trackLink"][field] = json!("not-a-uuid");
            assert_eq!(
                validation_codes(invalid_id),
                vec![CaptionValidationIssueCode::TrackLinkInvalid]
            );
        }
    }

    #[test]
    fn validates_versioned_typography_and_alignment_boundaries() {
        let mut minimum = fixture_value();
        minimum["style"]["typography"]["fontSizePx"] = json!(8);
        minimum["style"]["typography"]["fontWeight"] = json!(100);
        minimum["style"]["typography"]["lineHeightPermille"] = json!(500);
        minimum["style"]["alignment"] = json!({ "horizontal": "left", "vertical": "top" });
        assert!(validation_codes(minimum).is_empty());

        let mut maximum = fixture_value();
        maximum["style"]["typography"]["fontSizePx"] = json!(256);
        maximum["style"]["typography"]["fontWeight"] = json!(900);
        maximum["style"]["typography"]["lineHeightPermille"] = json!(3_000);
        maximum["style"]["alignment"] = json!({ "horizontal": "right", "vertical": "bottom" });
        assert!(validation_codes(maximum).is_empty());

        for (field, value) in [
            ("fontSizePx", json!(7)),
            ("fontWeight", json!(550)),
            ("lineHeightPermille", json!(3_001)),
            ("foregroundColorRgba", json!("#FFFFFF")),
        ] {
            let mut invalid = fixture_value();
            invalid["style"]["typography"][field] = value;
            assert_eq!(
                validation_codes(invalid),
                vec![CaptionValidationIssueCode::StyleInvalid]
            );
        }
    }

    #[test]
    fn exposes_deterministic_stable_validation_results() {
        let mut overlapping = fixture_value();
        overlapping["cues"][1]["start"]["value"] = json!(23);
        let artifact: CaptionArtifactV1 = serde_json::from_value(overlapping).unwrap();
        let first = caption_validation_result(&artifact);
        let second = caption_validation_result(&artifact);
        assert_eq!(first, second);
        assert!(!first.valid);
        assert_eq!(first.issues[0].code, CaptionValidationIssueCode::CueOverlap);
        assert_eq!(
            serde_json::to_value(&first).unwrap()["issues"][0]["code"],
            json!("CAPTION_CUE_OVERLAP")
        );
    }

    #[test]
    fn validates_rational_timing_and_touching_boundaries() {
        let mut unreduced = fixture_value();
        unreduced["timelineRate"] = json!({ "numerator": 48, "denominator": 2 });
        assert!(parse_value(unreduced).is_err());

        let touching = fixture_value();
        assert_eq!(touching["cues"][0]["end"], touching["cues"][1]["start"]);
        assert!(parse_value(touching).is_ok());

        let mut overlapping = fixture_value();
        overlapping["cues"][1]["start"]["value"] = json!(23);
        assert!(parse_value(overlapping).is_err());
    }

    #[test]
    fn enforces_unicode_scalar_line_and_cps_thresholds() {
        assert_eq!("A😀".chars().count(), 2);
        assert_eq!("👋🏽".chars().count(), 2);

        let mut line_boundary = one_cue();
        line_boundary["validationProfile"]["maxCharactersPerLine"] = json!(2);
        line_boundary["cues"][0]["lines"] = json!(["A😀"]);
        assert!(parse_value(line_boundary.clone()).is_ok());
        line_boundary["validationProfile"]["maxCharactersPerLine"] = json!(1);
        assert!(parse_value(line_boundary).is_err());

        let mut cps_boundary = one_cue();
        cps_boundary["cues"][0]["end"]["value"] = json!(12);
        cps_boundary["cues"][0]["lines"] = json!(["1234567890"]);
        assert!(parse_value(cps_boundary.clone()).is_ok());
        cps_boundary["cues"][0]["lines"] = json!(["1234567890😀"]);
        assert!(parse_value(cps_boundary).is_err());
    }

    #[test]
    fn enforces_source_duration_and_safe_area_boundaries() {
        let mut boundaries = one_cue();
        boundaries["cues"][0]["end"]["value"] = json!(12);
        boundaries["cues"][0]["lines"] = json!(["short"]);
        boundaries["cues"][0]["anchor"] = json!({ "xPermille": 50, "yPermille": 900 });
        assert!(parse_value(boundaries.clone()).is_ok());

        boundaries["cues"][0]["end"]["value"] = json!(11);
        assert!(parse_value(boundaries).is_err());

        let mut maximum = one_cue();
        maximum["cues"][0]["end"]["value"] = json!(168);
        assert!(parse_value(maximum.clone()).is_ok());
        maximum["cues"][0]["end"]["value"] = json!(169);
        assert!(parse_value(maximum).is_err());

        let mut outside = one_cue();
        outside["cues"][0]["anchor"]["xPermille"] = json!(49);
        assert!(parse_value(outside).is_err());

        let mut collapsed = one_cue();
        collapsed["validationProfile"]["safeArea"]["leftPermille"] = json!(500);
        collapsed["validationProfile"]["safeArea"]["rightPermille"] = json!(500);
        assert!(parse_value(collapsed).is_err());
    }

    #[test]
    fn rejects_orphaned_transcript_and_source_links() {
        let mut wrong_transcript = one_cue();
        wrong_transcript["cues"][0]["sourceLinks"][0]["transcriptArtifactIdentityKey"] =
            json!("0".repeat(64));
        assert!(parse_value(wrong_transcript).is_err());

        let mut invalid_span = one_cue();
        invalid_span["cues"][0]["sourceLinks"][0]["sourceEndUs"] = json!(0);
        assert!(parse_value(invalid_span).is_err());

        let mut duplicate_word = one_cue();
        let key = duplicate_word["transcriptArtifactIdentityKey"].clone();
        duplicate_word["cues"][0]["sourceLinks"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "transcriptArtifactIdentityKey": key,
                "sourceStartUs": 1_000_000,
                "sourceEndUs": 1_100_000,
                "transcriptWordIds": ["chunk-0000:0"]
            }));
        assert!(parse_value(duplicate_word).is_err());
    }
}
