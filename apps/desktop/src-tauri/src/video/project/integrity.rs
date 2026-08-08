use std::collections::{HashMap, HashSet};

use chrono::{FixedOffset, NaiveDate, TimeZone};
use uuid::Uuid;

use super::types::{
    AffectedRange, ClipSource, ClipTransform, ProjectCaption, ProjectClip, ProjectCommand,
    ProjectHistoryEntryV2, ProjectTrack, VideoProjectSnapshotV2, VideoProjectStateV2,
    VideoSequenceV2, MAX_AFFECTED_RANGES, MAX_ASSETS, MAX_CACHE_INVALIDATIONS,
    MAX_CAPTION_TEXT_UTF16, MAX_GROUP_COMMANDS, MAX_HISTORY_ENTRIES, MAX_LANGUAGE_TAG_UTF16,
    MAX_MARKERS, MAX_NON_BLANK_UTF16, MAX_SAFE_INTEGER, MAX_SEQUENCES, MAX_TRACKS, MAX_TRACK_ITEMS,
};
use crate::video::{
    caption::{validate_caption_artifact, CaptionArtifactV1},
    error::{VideoCommandError, VideoErrorCode},
    types::{
        AssetLocator, MediaContentAlgorithm, MediaContentIdentityV1, MediaProbe, RationalRate,
        RationalTime, VideoAsset,
    },
};

fn invalid(category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        VideoErrorCode::InvalidProject,
        "Project graph failed integrity validation",
        "validate_project_v2",
        category,
    )
}

pub fn is_canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value)
        .is_ok_and(|parsed| parsed.hyphenated().to_string() == value.to_ascii_lowercase())
        && value == value.to_ascii_lowercase()
}

pub(crate) fn trim_contract_text(value: &str) -> &str {
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

fn valid_trimmed_text(value: &str, maximum_utf16: usize) -> bool {
    let trimmed = trim_contract_text(value);
    !trimmed.is_empty() && trimmed.encode_utf16().count() <= maximum_utf16
}

fn valid_non_blank(value: &str) -> bool {
    valid_trimmed_text(value, MAX_NON_BLANK_UTF16)
}

fn valid_language_tag(value: &str) -> bool {
    let trimmed = trim_contract_text(value);
    let length = trimmed.encode_utf16().count();
    (2..=MAX_LANGUAGE_TAG_UTF16).contains(&length)
        && trimmed
            .split('-')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn date_time_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 17
        || !value.is_ascii()
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
    {
        return None;
    }
    let digits = |start: usize, end: usize| {
        value
            .get(start..end)
            .filter(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|part| part.parse::<u32>().ok())
    };
    let date = NaiveDate::from_ymd_opt(digits(0, 4)? as i32, digits(5, 7)?, digits(8, 10)?)?;
    let hour = digits(11, 13)?;
    let minute = digits(14, 16)?;
    if hour > 23 || minute > 59 {
        return None;
    }

    let mut cursor = 16;
    let mut second = 0;
    let mut nanosecond = 0;
    if bytes.get(cursor) == Some(&b':') {
        second = digits(cursor + 1, cursor + 3)?;
        if second > 59 {
            return None;
        }
        cursor += 3;
        if bytes.get(cursor) == Some(&b'.') {
            cursor += 1;
            let fraction_start = cursor;
            while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
                cursor += 1;
            }
            if cursor == fraction_start {
                return None;
            }
            let mut fraction = value[fraction_start..cursor]
                .chars()
                .take(9)
                .collect::<String>();
            while fraction.len() < 9 {
                fraction.push('0');
            }
            nanosecond = fraction.parse().ok()?;
        }
    }

    let offset_seconds = match bytes.get(cursor) {
        Some(b'Z') if cursor + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-'))
            if cursor + 6 == bytes.len() && bytes.get(cursor + 3) == Some(&b':') =>
        {
            let offset_hour = digits(cursor + 1, cursor + 3)?;
            let offset_minute = digits(cursor + 4, cursor + 6)?;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let magnitude = (offset_hour * 3_600 + offset_minute * 60) as i32;
            if *sign == b'-' {
                -magnitude
            } else {
                magnitude
            }
        }
        _ => return None,
    };
    let offset = FixedOffset::east_opt(offset_seconds)?;
    let local = date.and_hms_nano_opt(hour, minute, second, nanosecond)?;
    offset
        .from_local_datetime(&local)
        .single()
        .map(|date_time| date_time.timestamp_millis())
}

fn valid_rate(rate: &RationalRate) -> bool {
    rate.numerator > 0
        && rate.denominator > 0
        && rate.numerator <= MAX_SAFE_INTEGER
        && rate.denominator <= MAX_SAFE_INTEGER
        && gcd(rate.numerator, rate.denominator) == 1
}

fn valid_time_shape(time: &RationalTime) -> bool {
    time.value <= MAX_SAFE_INTEGER
        && time.rate_numerator > 0
        && time.rate_denominator > 0
        && time.rate_numerator <= MAX_SAFE_INTEGER
        && time.rate_denominator <= MAX_SAFE_INTEGER
        && gcd(time.rate_numerator, time.rate_denominator) == 1
}

fn valid_time(time: &RationalTime, rate: &RationalRate) -> bool {
    valid_time_shape(time)
        && time.rate_numerator == rate.numerator
        && time.rate_denominator == rate.denominator
}

fn rescale_frames_exact(
    value: u64,
    source_rate_numerator: u64,
    source_rate_denominator: u64,
    timeline_rate_numerator: u64,
    timeline_rate_denominator: u64,
) -> Option<u64> {
    let mut numerators = [value, source_rate_denominator, timeline_rate_numerator];
    let mut denominators = [source_rate_numerator, timeline_rate_denominator];
    for denominator in &mut denominators {
        for numerator in &mut numerators {
            let divisor = gcd(*numerator, *denominator);
            *numerator /= divisor;
            *denominator /= divisor;
        }
    }
    if denominators != [1, 1] {
        return None;
    }
    numerators
        .into_iter()
        .try_fold(1_u64, |product, factor| product.checked_mul(factor))
        .filter(|duration| *duration <= MAX_SAFE_INTEGER)
}

fn valid_transform(transform: &ClipTransform) -> bool {
    transform.position_x_permille.unsigned_abs() <= 1_000_000
        && transform.position_y_permille.unsigned_abs() <= 1_000_000
        && (1..=1_000_000).contains(&transform.scale_x_permille)
        && (1..=1_000_000).contains(&transform.scale_y_permille)
        && transform.rotation_milli_degrees.unsigned_abs() <= 360_000_000
        && transform.opacity_permille <= 1_000
}

fn valid_locator(locator: &AssetLocator) -> bool {
    let valid_path = |path: &str| {
        !path.is_empty() && path.encode_utf16().count() <= 32_768 && !path.contains('\0')
    };
    (locator.relative_path.is_some() || locator.absolute_path.is_some())
        && locator
            .relative_path
            .as_deref()
            .is_none_or(|path| valid_path(path) && crate::video::types::is_safe_relative_path(path))
        && locator.absolute_path.as_deref().is_none_or(|path| {
            valid_path(path) && crate::video::types::is_recognizable_absolute_path(path)
        })
}

fn valid_probe(probe: &MediaProbe) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&probe.duration_microseconds)
        && valid_rate(&probe.average_frame_rate)
        && valid_rate(&probe.real_frame_rate)
        && (1..=MAX_SAFE_INTEGER).contains(&probe.width)
        && (1..=MAX_SAFE_INTEGER).contains(&probe.height)
        && valid_non_blank(&probe.video_codec_name)
        && (1..=MAX_SAFE_INTEGER).contains(&probe.file_size_bytes)
        && probe.audio.as_ref().is_none_or(|audio| {
            valid_non_blank(&audio.codec_name)
                && (1..=64).contains(&audio.channels)
                && (1..=768_000).contains(&audio.sample_rate)
        })
}

fn valid_content_identity(identity: &MediaContentIdentityV1) -> bool {
    identity.schema_version == 1
        && identity.algorithm == MediaContentAlgorithm::Sha256
        && identity.digest.len() == 64
        && identity
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && (1..=MAX_SAFE_INTEGER).contains(&identity.byte_length)
}

fn valid_asset_shape(asset: &VideoAsset) -> bool {
    is_canonical_uuid(asset.id.as_str())
        && valid_non_blank(&asset.display_name)
        && valid_locator(&asset.locator)
        && valid_probe(&asset.probe)
        && asset
            .content_identity
            .as_ref()
            .is_none_or(valid_content_identity)
}

fn valid_marker_shape(marker: &super::types::ProjectMarker) -> bool {
    is_canonical_uuid(&marker.id)
        && valid_time_shape(&marker.time)
        && valid_non_blank(&marker.label)
}

fn valid_caption_shape(caption: &ProjectCaption) -> bool {
    is_canonical_uuid(&caption.id)
        && valid_time_shape(&caption.start)
        && valid_time_shape(&caption.end)
        && caption.end.value > caption.start.value
        && valid_trimmed_text(&caption.text, MAX_CAPTION_TEXT_UTF16)
        && caption.language.as_deref().is_none_or(valid_language_tag)
}

fn valid_clip_shape(clip: &ProjectClip) -> bool {
    let source_id_valid = match &clip.source {
        ClipSource::Asset { asset_id } => is_canonical_uuid(asset_id),
        ClipSource::Sequence { sequence_id } => is_canonical_uuid(sequence_id),
    };
    is_canonical_uuid(&clip.id)
        && source_id_valid
        && valid_time_shape(&clip.timeline_start)
        && valid_time_shape(&clip.source_in)
        && valid_time_shape(&clip.source_out)
        && clip.source_out.value > clip.source_in.value
        && valid_transform(&clip.transform)
        && (-96_000..=24_000).contains(&clip.gain_milli_decibels)
}

fn valid_track_shape(track: &ProjectTrack) -> bool {
    match track {
        ProjectTrack::Video {
            id, name, clips, ..
        }
        | ProjectTrack::Audio {
            id, name, clips, ..
        } => {
            is_canonical_uuid(id)
                && valid_non_blank(name)
                && clips.len() <= MAX_TRACK_ITEMS
                && clips.iter().all(valid_clip_shape)
        }
        ProjectTrack::Caption {
            id,
            name,
            captions,
            active_caption_artifact,
            ..
        } => {
            is_canonical_uuid(id)
                && valid_non_blank(name)
                && captions.len() <= MAX_TRACK_ITEMS
                && captions.iter().all(valid_caption_shape)
                && active_caption_artifact
                    .as_ref()
                    .is_none_or(|artifact| validate_caption_artifact(artifact).is_ok())
        }
    }
}

fn valid_sequence_shape(sequence: &VideoSequenceV2) -> bool {
    is_canonical_uuid(&sequence.id)
        && valid_non_blank(&sequence.name)
        && valid_rate(&sequence.rate)
        && sequence.width > 0
        && sequence.height > 0
        && sequence.width <= 16_384
        && sequence.height <= 16_384
        && sequence.width & 1 == 0
        && sequence.height & 1 == 0
        && (1..=768_000).contains(&sequence.audio_sample_rate)
        && sequence.tracks.len() <= MAX_TRACKS
        && sequence.markers.len() <= MAX_MARKERS
        && sequence.tracks.iter().all(valid_track_shape)
        && sequence.markers.iter().all(valid_marker_shape)
}

fn source_duration_frames(probe: &MediaProbe, rate: &RationalRate) -> Option<u64> {
    let numerator = u128::from(probe.duration_microseconds) * u128::from(rate.numerator);
    let denominator = 1_000_000_u128 * u128::from(rate.denominator);
    let frames = numerator.div_ceil(denominator);
    u64::try_from(frames)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
}

fn register_id(ids: &mut HashSet<String>, id: &str) -> Result<(), VideoCommandError> {
    if !is_canonical_uuid(id) || !ids.insert(id.to_owned()) {
        return Err(invalid("entity_id"));
    }
    Ok(())
}

fn validate_clip_local(
    clip: &ProjectClip,
    sequence: &VideoSequenceV2,
) -> Result<(), VideoCommandError> {
    if !valid_clip_shape(clip)
        || !valid_time(&clip.timeline_start, &sequence.rate)
        || clip.source_out.rate_numerator != clip.source_in.rate_numerator
        || clip.source_out.rate_denominator != clip.source_in.rate_denominator
    {
        return Err(invalid("clip_range"));
    }
    Ok(())
}

fn validate_sequence(
    sequence: &VideoSequenceV2,
    assets: &HashMap<&str, &MediaProbe>,
    sequence_ids: &HashSet<&str>,
    ids: &mut HashSet<String>,
) -> Result<(), VideoCommandError> {
    if !valid_sequence_shape(sequence) {
        return Err(invalid("sequence_shape"));
    }
    for marker in &sequence.markers {
        register_id(ids, &marker.id)?;
        if !valid_non_blank(&marker.label) || !valid_time(&marker.time, &sequence.rate) {
            return Err(invalid("marker"));
        }
    }
    for track in &sequence.tracks {
        register_id(ids, track.id())?;
        match track {
            ProjectTrack::Caption {
                id,
                name,
                captions,
                active_caption_artifact,
                ..
            } => {
                if !valid_non_blank(name) || captions.len() > MAX_TRACK_ITEMS {
                    return Err(invalid("track_name"));
                }
                if let Some(artifact) = active_caption_artifact {
                    if validate_caption_artifact(artifact).is_err()
                        || artifact.track_link.sequence_id != sequence.id
                        || artifact.track_link.caption_track_id != *id
                        || artifact.timeline_rate != sequence.rate
                    {
                        return Err(invalid("active_caption_artifact"));
                    }
                }
                for caption in captions {
                    register_id(ids, &caption.id)?;
                    if !valid_caption_shape(caption)
                        || !valid_time(&caption.start, &sequence.rate)
                        || !valid_time(&caption.end, &sequence.rate)
                    {
                        return Err(invalid("caption"));
                    }
                }
            }
            ProjectTrack::Video { name, clips, .. } | ProjectTrack::Audio { name, clips, .. } => {
                if !valid_non_blank(name) || clips.len() > MAX_TRACK_ITEMS {
                    return Err(invalid("track_shape"));
                }
                let mut previous_end = 0_u64;
                for clip in clips {
                    register_id(ids, &clip.id)?;
                    validate_clip_local(clip, sequence)?;
                    if clip.timeline_start.value < previous_end {
                        return Err(invalid("clip_overlap"));
                    }
                    let source_duration = clip
                        .source_out
                        .value
                        .checked_sub(clip.source_in.value)
                        .ok_or_else(|| invalid("clip_range"))?;
                    let duration = rescale_frames_exact(
                        source_duration,
                        clip.source_in.rate_numerator,
                        clip.source_in.rate_denominator,
                        sequence.rate.numerator,
                        sequence.rate.denominator,
                    )
                    .ok_or_else(|| invalid("clip_range"))?;
                    previous_end = clip
                        .timeline_start
                        .value
                        .checked_add(duration)
                        .ok_or_else(|| invalid("safe_integer"))?;
                    if previous_end > MAX_SAFE_INTEGER {
                        return Err(invalid("safe_integer"));
                    }
                    match &clip.source {
                        ClipSource::Asset { asset_id } => {
                            let probe = assets
                                .get(asset_id.as_str())
                                .ok_or_else(|| invalid("asset_reference"))?;
                            let source_rate = RationalRate {
                                numerator: clip.source_in.rate_numerator,
                                denominator: clip.source_in.rate_denominator,
                            };
                            if !valid_rate(&source_rate)
                                || clip.source_out.value
                                    > source_duration_frames(probe, &source_rate)
                                        .ok_or_else(|| invalid("source_duration"))?
                            {
                                return Err(invalid("source_range"));
                            }
                        }
                        ClipSource::Sequence { sequence_id }
                            if !sequence_ids.contains(sequence_id.as_str()) =>
                        {
                            return Err(invalid("sequence_reference"))
                        }
                        ClipSource::Sequence { .. } => {}
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_acyclic(state: &VideoProjectStateV2) -> Result<(), VideoCommandError> {
    let graph: HashMap<&str, Vec<&str>> = state
        .sequences
        .iter()
        .map(|sequence| {
            let edges = sequence
                .tracks
                .iter()
                .flat_map(|track| track.clips().unwrap_or_default())
                .filter_map(|clip| match &clip.source {
                    ClipSource::Sequence { sequence_id } => Some(sequence_id.as_str()),
                    ClipSource::Asset { .. } => None,
                })
                .collect();
            (sequence.id.as_str(), edges)
        })
        .collect();
    fn visit<'a>(
        id: &'a str,
        graph: &HashMap<&'a str, Vec<&'a str>>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> bool {
        if visiting.contains(id) {
            return false;
        }
        if visited.contains(id) {
            return true;
        }
        visiting.insert(id);
        let valid = graph
            .get(id)
            .into_iter()
            .flatten()
            .all(|next| visit(next, graph, visiting, visited));
        visiting.remove(id);
        visited.insert(id);
        valid
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    if graph
        .keys()
        .copied()
        .all(|id| visit(id, &graph, &mut visiting, &mut visited))
    {
        Ok(())
    } else {
        Err(invalid("sequence_cycle"))
    }
}

pub fn validate_state(state: &VideoProjectStateV2) -> Result<(), VideoCommandError> {
    if state.assets.len() > MAX_ASSETS || state.sequences.len() > MAX_SEQUENCES {
        return Err(invalid("entity_count"));
    }
    let mut ids = HashSet::new();
    let mut assets = HashMap::new();
    for asset in &state.assets {
        register_id(&mut ids, asset.id.as_str())?;
        if !valid_asset_shape(asset) {
            return Err(invalid("asset_shape"));
        }
        assets.insert(asset.id.as_str(), &asset.probe);
    }
    let sequence_ids: HashSet<&str> = state
        .sequences
        .iter()
        .map(|sequence| sequence.id.as_str())
        .collect();
    for sequence in &state.sequences {
        register_id(&mut ids, &sequence.id)?;
        validate_sequence(sequence, &assets, &sequence_ids, &mut ids)?;
    }
    match state.active_sequence_id.as_deref() {
        None if !state.sequences.is_empty() => return Err(invalid("active_sequence")),
        Some(id) if !sequence_ids.contains(id) => return Err(invalid("active_sequence")),
        _ => {}
    }
    validate_acyclic(state)
}

fn valid_command(command: &ProjectCommand) -> bool {
    if !is_canonical_uuid(command.command_id()) {
        return false;
    }
    let valid_optional_index =
        |index: &Option<u64>| index.is_none_or(|value| value <= MAX_SAFE_INTEGER);
    match command {
        ProjectCommand::ImportAsset { index, asset, .. } => {
            valid_optional_index(index) && valid_asset_shape(asset)
        }
        ProjectCommand::CreateSequence {
            index,
            active_sequence_id,
            sequence,
            ..
        } => {
            valid_optional_index(index)
                && active_sequence_id.as_deref().is_none_or(is_canonical_uuid)
                && valid_sequence_shape(sequence)
        }
        ProjectCommand::RemoveSequence {
            sequence_id,
            active_sequence_id,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && active_sequence_id.as_deref().is_none_or(is_canonical_uuid)
        }
        ProjectCommand::InsertTrack {
            sequence_id,
            index,
            track,
            ..
        } => {
            is_canonical_uuid(sequence_id) && *index <= MAX_SAFE_INTEGER && valid_track_shape(track)
        }
        ProjectCommand::RemoveTrack {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::SetTrackLocked {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::SetTrackMuted {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::SetTrackHidden {
            sequence_id,
            track_id,
            ..
        } => is_canonical_uuid(sequence_id) && is_canonical_uuid(track_id),
        ProjectCommand::InsertClip {
            sequence_id,
            track_id,
            index,
            clip,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && valid_optional_index(index)
                && valid_clip_shape(clip)
        }
        ProjectCommand::RemoveClip {
            sequence_id,
            track_id,
            clip_id,
            ..
        }
        | ProjectCommand::RippleDeleteClip {
            sequence_id,
            track_id,
            clip_id,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && is_canonical_uuid(clip_id)
        }
        ProjectCommand::RestoreRippleDeletedClip {
            sequence_id,
            track_id,
            index,
            clip,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && *index <= MAX_SAFE_INTEGER
                && valid_clip_shape(clip)
        }
        ProjectCommand::SplitClip {
            sequence_id,
            track_id,
            clip_id,
            split_at,
            right_clip_id,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && is_canonical_uuid(clip_id)
                && valid_time_shape(split_at)
                && is_canonical_uuid(right_clip_id)
        }
        ProjectCommand::MoveClip {
            sequence_id,
            track_id,
            clip_id,
            timeline_start,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && is_canonical_uuid(clip_id)
                && valid_time_shape(timeline_start)
        }
        ProjectCommand::TrimClip {
            sequence_id,
            track_id,
            clip_id,
            source_in,
            source_out,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && is_canonical_uuid(clip_id)
                && valid_time_shape(source_in)
                && valid_time_shape(source_out)
        }
        ProjectCommand::SetClipTransform {
            sequence_id,
            track_id,
            clip_id,
            transform,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && is_canonical_uuid(clip_id)
                && valid_transform(transform)
        }
        ProjectCommand::SetClipOpacity {
            sequence_id,
            track_id,
            clip_id,
            opacity_permille,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && is_canonical_uuid(clip_id)
                && *opacity_permille <= 1_000
        }
        ProjectCommand::SetClipGain {
            sequence_id,
            track_id,
            clip_id,
            gain_milli_decibels,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && is_canonical_uuid(clip_id)
                && (-96_000..=24_000).contains(gain_milli_decibels)
        }
        ProjectCommand::AddMarker {
            sequence_id,
            index,
            marker,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && valid_optional_index(index)
                && valid_marker_shape(marker)
        }
        ProjectCommand::RemoveMarker {
            sequence_id,
            marker_id,
            ..
        } => is_canonical_uuid(sequence_id) && is_canonical_uuid(marker_id),
        ProjectCommand::AddCaption {
            sequence_id,
            track_id,
            index,
            caption,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && valid_optional_index(index)
                && valid_caption_shape(caption)
        }
        ProjectCommand::RemoveCaption {
            sequence_id,
            track_id,
            caption_id,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && is_canonical_uuid(caption_id)
        }
        ProjectCommand::ApplyCaptionArtifact {
            sequence_id,
            track_id,
            artifact,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && artifact.track_link.sequence_id == *sequence_id
                && artifact.track_link.caption_track_id == *track_id
                && validate_caption_artifact(artifact).is_ok()
        }
        ProjectCommand::RestoreActiveCaptionArtifact {
            sequence_id,
            track_id,
            artifact,
            ..
        } => {
            is_canonical_uuid(sequence_id)
                && is_canonical_uuid(track_id)
                && artifact.as_ref().is_none_or(|artifact| {
                    artifact.track_link.sequence_id == *sequence_id
                        && artifact.track_link.caption_track_id == *track_id
                        && validate_caption_artifact(artifact).is_ok()
                })
        }
        ProjectCommand::RelinkAsset {
            asset_id,
            locator,
            probe,
            content_identity,
            ..
        } => {
            is_canonical_uuid(asset_id)
                && valid_locator(locator)
                && valid_probe(probe)
                && content_identity.as_ref().is_none_or(valid_content_identity)
        }
        ProjectCommand::RemoveAsset { asset_id, .. } => is_canonical_uuid(asset_id),
    }
}

fn valid_affected_range(range: &AffectedRange) -> bool {
    is_canonical_uuid(&range.sequence_id)
        && valid_time_shape(&range.start)
        && valid_time_shape(&range.end)
        && range.end.value > range.start.value
}

fn command_caption_artifact(command: &ProjectCommand) -> Option<&CaptionArtifactV1> {
    match command {
        ProjectCommand::ApplyCaptionArtifact { artifact, .. } => Some(artifact),
        ProjectCommand::RestoreActiveCaptionArtifact { artifact, .. } => artifact.as_ref(),
        _ => None,
    }
}

fn valid_history_entry(entry: &ProjectHistoryEntryV2) -> bool {
    is_canonical_uuid(&entry.group_id)
        && valid_non_blank(&entry.summary)
        && (1..=MAX_GROUP_COMMANDS).contains(&entry.forward_commands.len())
        && (1..=MAX_GROUP_COMMANDS).contains(&entry.inverse_commands.len())
        && entry
            .forward_commands
            .iter()
            .all(|command| valid_command(command) && !command.is_private_inverse())
        && entry.inverse_commands.iter().all(valid_command)
        && entry.affected_ranges.len() <= MAX_AFFECTED_RANGES
        && entry.affected_ranges.iter().all(valid_affected_range)
        && entry.cache_invalidations.len() <= MAX_CACHE_INVALIDATIONS
}

fn validate_history(snapshot: &VideoProjectSnapshotV2) -> Result<(), VideoCommandError> {
    if snapshot.history.undo_stack.len() > MAX_HISTORY_ENTRIES
        || snapshot.history.redo_stack.len() > MAX_HISTORY_ENTRIES
        || !snapshot.history.undo_stack.iter().all(valid_history_entry)
        || !snapshot.history.redo_stack.iter().all(valid_history_entry)
    {
        return Err(invalid("history"));
    }
    let historical_artifacts = snapshot
        .history
        .undo_stack
        .iter()
        .chain(&snapshot.history.redo_stack)
        .flat_map(|entry| entry.forward_commands.iter().chain(&entry.inverse_commands))
        .filter_map(command_caption_artifact);
    if historical_artifacts
        .into_iter()
        .any(|artifact| artifact.track_link.project_id != snapshot.id)
    {
        return Err(invalid("history_caption_artifact_project"));
    }
    Ok(())
}

fn validate_active_caption_artifact_projects(
    snapshot: &VideoProjectSnapshotV2,
) -> Result<(), VideoCommandError> {
    let project_mismatch = snapshot.state.sequences.iter().any(|sequence| {
        sequence.tracks.iter().any(|track| {
            matches!(
                track,
                ProjectTrack::Caption {
                    active_caption_artifact: Some(artifact),
                    ..
                } if artifact.track_link.project_id != snapshot.id
            )
        })
    });
    if project_mismatch {
        return Err(invalid("active_caption_artifact_project"));
    }
    Ok(())
}

pub fn validate_snapshot(snapshot: &VideoProjectSnapshotV2) -> Result<(), VideoCommandError> {
    let created_at = date_time_millis(&snapshot.created_at);
    let updated_at = date_time_millis(&snapshot.updated_at);
    if snapshot.schema_version != 2
        || !is_canonical_uuid(&snapshot.id)
        || !valid_non_blank(&snapshot.name)
        || created_at.is_none()
        || updated_at.is_none()
        || updated_at < created_at
        || !is_canonical_uuid(&snapshot.storage_generation_id)
        || !is_canonical_uuid(&snapshot.revision.id)
        || snapshot
            .revision
            .parent_id
            .as_deref()
            .is_some_and(|id| !is_canonical_uuid(id))
        || date_time_millis(&snapshot.revision.committed_at).is_none()
        || !is_canonical_uuid(&snapshot.revision.operation_id)
        || snapshot.revision.number > MAX_SAFE_INTEGER
        || snapshot.last_applied_record_number > MAX_SAFE_INTEGER
        || !valid_hash(&snapshot.revision.state_hash)
        || !valid_hash(&snapshot.last_record_hash)
    {
        return Err(invalid("snapshot_metadata"));
    }
    validate_state(&snapshot.state)?;
    validate_active_caption_artifact_projects(snapshot)?;
    validate_history(snapshot)?;
    let actual_hash = super::hash::state_hash(&snapshot.state)?;
    if actual_hash != snapshot.revision.state_hash {
        return Err(invalid("state_hash"));
    }
    Ok(())
}

fn gcd(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}
