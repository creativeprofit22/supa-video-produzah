use std::collections::HashSet;

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    clip_speed::{find_speed_target, validate_retimed_context},
    clip_timing::{
        normalize_speed, project_clip_timeline_duration, source_offset_to_timeline, validate_speed,
        ClipSpeed, SamplePolicy, TimingError,
    },
    integrity::{is_canonical_uuid, valid_transform, validate_state},
    types::{
        AffectedRange, CacheInvalidation, ClipFades, ProjectClip, ProjectCommand, ProjectTrack,
        TrackMuteError, TrackVisibilityError, VideoProjectStateV2, MAX_NON_BLANK_UTF16,
        MAX_SAFE_INTEGER,
    },
};
use crate::video::{
    caption::{validate_caption_artifact, CaptionArtifactV1},
    error::{VideoCommandError, VideoErrorCode},
    types::{RationalRate, RationalTime},
};

#[derive(Debug, Clone)]
pub struct AppliedGroup {
    pub state: VideoProjectStateV2,
    pub inverse_commands: Vec<ProjectCommand>,
    pub summary: String,
    pub affected_ranges: Vec<AffectedRange>,
    pub cache_invalidations: Vec<CacheInvalidation>,
}

fn invalid(category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        VideoErrorCode::InvalidCommand,
        "Project command failed its preconditions",
        "execute_project_command",
        category,
    )
}

fn inverse_id(command_id: &str, ordinal: u8) -> String {
    let digest = Sha256::digest(format!("supa-video-inverse:{command_id}:{ordinal}").as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).hyphenated().to_string()
}

fn find_sequence_mut<'a>(
    state: &'a mut VideoProjectStateV2,
    id: &str,
) -> Result<&'a mut super::types::VideoSequenceV2, VideoCommandError> {
    state
        .sequences
        .iter_mut()
        .find(|sequence| sequence.id == id)
        .ok_or_else(|| invalid("unknown_sequence"))
}

fn find_track_mut<'a>(
    state: &'a mut VideoProjectStateV2,
    sequence_id: &str,
    track_id: &str,
) -> Result<&'a mut ProjectTrack, VideoCommandError> {
    find_sequence_mut(state, sequence_id)?
        .tracks
        .iter_mut()
        .find(|track| track.id() == track_id)
        .ok_or_else(|| invalid("unknown_track"))
}

fn find_unlocked_track_mut<'a>(
    state: &'a mut VideoProjectStateV2,
    sequence_id: &str,
    track_id: &str,
) -> Result<&'a mut ProjectTrack, VideoCommandError> {
    let track = find_track_mut(state, sequence_id, track_id)?;
    if track.is_locked() {
        return Err(invalid("track_locked"));
    }
    Ok(track)
}

fn replace_active_caption_artifact(
    state: &mut VideoProjectStateV2,
    sequence_id: &str,
    track_id: &str,
    artifact: Option<&CaptionArtifactV1>,
) -> Result<Option<CaptionArtifactV1>, VideoCommandError> {
    if let Some(artifact) = artifact {
        validate_caption_artifact(artifact).map_err(|_| invalid("caption_artifact"))?;
        if artifact.track_link.sequence_id != sequence_id
            || artifact.track_link.caption_track_id != track_id
        {
            return Err(invalid("caption_artifact_target"));
        }
    }
    let sequence = find_sequence_mut(state, sequence_id)?;
    if artifact.is_some_and(|artifact| artifact.timeline_rate != sequence.rate) {
        return Err(invalid("caption_artifact_rate"));
    }
    let track = sequence
        .tracks
        .iter_mut()
        .find(|track| track.id() == track_id)
        .ok_or_else(|| invalid("unknown_track"))?;
    if track.is_locked() {
        return Err(invalid("track_locked"));
    }
    let ProjectTrack::Caption {
        active_caption_artifact,
        ..
    } = track
    else {
        return Err(invalid("non_caption_track"));
    };
    Ok(std::mem::replace(
        active_caption_artifact,
        artifact.cloned(),
    ))
}

fn find_clip_mut<'a>(
    state: &'a mut VideoProjectStateV2,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
) -> Result<&'a mut ProjectClip, VideoCommandError> {
    find_unlocked_track_mut(state, sequence_id, track_id)?
        .clips_mut()
        .ok_or_else(|| invalid("caption_track"))?
        .iter_mut()
        .find(|clip| clip.id == clip_id)
        .ok_or_else(|| invalid("unknown_clip"))
}

fn timing_error(error: TimingError) -> VideoCommandError {
    invalid(match error {
        TimingError::Inexact => "inexact_time",
        TimingError::Overflow => "safe_integer",
        TimingError::InvalidRate => "time_rate",
        TimingError::InvalidSpeed => "clip_speed",
        TimingError::InvalidRange => "clip_range",
    })
}

fn clip_duration_on_timeline(clip: &ProjectClip) -> Result<u64, VideoCommandError> {
    project_clip_timeline_duration(clip).map_err(timing_error)
}

fn clip_range(sequence_id: &str, clip: &ProjectClip) -> Result<AffectedRange, VideoCommandError> {
    let duration = clip_duration_on_timeline(clip)?;
    let end_value = clip
        .timeline_start
        .value
        .checked_add(duration)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("safe_integer"))?;
    Ok(AffectedRange {
        sequence_id: sequence_id.to_owned(),
        start: clip.timeline_start.clone(),
        end: RationalTime {
            value: end_value,
            rate_numerator: clip.timeline_start.rate_numerator,
            rate_denominator: clip.timeline_start.rate_denominator,
        },
    })
}

fn set_clip_speed(
    state: &mut VideoProjectStateV2,
    command_id: &str,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
    desired: Option<ClipSpeed>,
) -> Result<(Vec<ProjectCommand>, Vec<AffectedRange>), VideoCommandError> {
    if let Some(speed) = desired {
        validate_speed(&speed).map_err(|_| invalid("clip_speed"))?;
    }
    let previous = find_speed_target(state, sequence_id, track_id, clip_id)?.speed;
    if previous.unwrap_or_default() != desired.unwrap_or_default() {
        validate_retimed_context(state, sequence_id, track_id, clip_id)?;
    }
    let clip = find_clip_mut(state, sequence_id, track_id, clip_id)?;
    let before = clip_range(sequence_id, clip)?;
    clip.speed = desired;
    let after = clip_range(sequence_id, clip)?;
    Ok((
        vec![ProjectCommand::RestoreClipSpeed {
            command_id: inverse_id(command_id, 0),
            sequence_id: sequence_id.to_owned(),
            track_id: track_id.to_owned(),
            clip_id: clip_id.to_owned(),
            speed: previous,
        }],
        vec![before, after],
    ))
}

fn set_clip_fades(
    state: &mut VideoProjectStateV2,
    command_id: &str,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
    desired: Option<ClipFades>,
) -> Result<(Vec<ProjectCommand>, Vec<AffectedRange>), VideoCommandError> {
    let clip = find_clip_mut(state, sequence_id, track_id, clip_id)?;
    if desired.is_some_and(|f| {
        !f.valid()
            || f.in_frames.checked_add(f.out_frames).is_none_or(|sum| {
                clip_duration_on_timeline(clip).map_or(true, |duration| sum > duration)
            })
    }) {
        return Err(invalid("clip_fades"));
    }
    let previous = std::mem::replace(&mut clip.fades, desired);
    Ok((
        vec![ProjectCommand::RestoreClipFades {
            command_id: inverse_id(command_id, 0),
            sequence_id: sequence_id.to_owned(),
            track_id: track_id.to_owned(),
            clip_id: clip_id.to_owned(),
            fades: previous,
        }],
        vec![clip_range(sequence_id, clip)?],
    ))
}

fn track_range(
    sequence_id: &str,
    track: &ProjectTrack,
) -> Result<Vec<AffectedRange>, VideoCommandError> {
    let clips = track.clips().ok_or_else(|| invalid("non_audio_track"))?;
    let Some(first) = clips.first() else {
        return Ok(vec![]);
    };
    let mut start = first.timeline_start.clone();
    let mut end = clip_range(sequence_id, first)?.end;
    for clip in &clips[1..] {
        let range = clip_range(sequence_id, clip)?;
        if range.start.value < start.value {
            start = range.start;
        }
        if range.end.value > end.value {
            end = range.end;
        }
    }
    Ok(vec![AffectedRange {
        sequence_id: sequence_id.to_owned(),
        start,
        end,
    }])
}
fn visual_track_range(
    sequence_id: &str,
    track: &ProjectTrack,
) -> Result<Vec<AffectedRange>, VideoCommandError> {
    match track {
        ProjectTrack::Video { .. } => track_range(sequence_id, track),
        ProjectTrack::Caption { captions, .. } => {
            let Some(first) = captions.first() else {
                return Ok(vec![]);
            };
            let mut start = first.start.clone();
            let mut end = first.end.clone();
            for caption in &captions[1..] {
                if caption.start.value < start.value {
                    start = caption.start.clone();
                }
                if caption.end.value > end.value {
                    end = caption.end.clone();
                }
            }
            Ok(vec![AffectedRange {
                sequence_id: sequence_id.to_owned(),
                start,
                end,
            }])
        }
        ProjectTrack::Audio { .. } => Err(invalid("non_visual_track")),
    }
}

fn insertion_index(
    requested: Option<u64>,
    collection_len: usize,
    category: &'static str,
) -> Result<Option<usize>, VideoCommandError> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    let index = usize::try_from(requested).map_err(|_| invalid(category))?;
    if index > collection_len {
        return Err(invalid(category));
    }
    Ok(Some(index))
}

fn command_metadata(command: &ProjectCommand) -> (&'static str, Vec<CacheInvalidation>) {
    match command {
        ProjectCommand::ImportAsset { .. } => (
            "Imported asset",
            vec![
                CacheInvalidation::AssetSource,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::CreateSequence { .. } => (
            "Created sequence",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::RemoveSequence { .. } => (
            "Removed sequence",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::InsertTrack { .. } => (
            "Inserted track",
            vec![CacheInvalidation::Timeline, CacheInvalidation::RenderPlan],
        ),
        ProjectCommand::RemoveTrack { .. } => (
            "Removed track",
            vec![CacheInvalidation::Timeline, CacheInvalidation::RenderPlan],
        ),
        ProjectCommand::SetTrackLocked { locked, .. } => (
            if *locked {
                "Locked track"
            } else {
                "Unlocked track"
            },
            vec![CacheInvalidation::Timeline],
        ),
        ProjectCommand::SetTrackMuted { muted, .. } => (
            if *muted {
                "Muted track"
            } else {
                "Unmuted track"
            },
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::AudioMix,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::SetTrackHidden { hidden, .. } => (
            if *hidden { "Hid track" } else { "Showed track" },
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::Captions,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::InsertClip { .. } => (
            "Inserted clip",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::AudioMix,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::RemoveClip { .. } => (
            "Removed clip",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::AudioMix,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::RippleDeleteClip { .. } => (
            "Ripple deleted clip",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::AudioMix,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::RestoreRippleDeletedClip { .. } => (
            "Restored ripple-deleted clip",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::AudioMix,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::SplitClip { .. } => (
            "Split clip",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::AudioMix,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::MoveClip { .. } => (
            "Moved clip",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::AudioMix,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::TrimClip { .. } => (
            "Applied trim",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::AudioMix,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::SetClipTransform { .. } => (
            "Updated clip transform",
            vec![CacheInvalidation::Preview, CacheInvalidation::RenderPlan],
        ),
        ProjectCommand::SetClipOpacity { .. } => (
            "Updated clip opacity",
            vec![CacheInvalidation::Preview, CacheInvalidation::RenderPlan],
        ),
        ProjectCommand::SetClipSpeed { .. } | ProjectCommand::RestoreClipSpeed { .. } => (
            "Updated clip speed",
            vec![
                CacheInvalidation::Timeline,
                CacheInvalidation::Preview,
                CacheInvalidation::AudioMix,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::SetClipFades { .. } | ProjectCommand::RestoreClipFades { .. } => (
            "Updated clip fades",
            vec![
                CacheInvalidation::AudioMix,
                CacheInvalidation::Preview,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::SetClipGain { .. } => (
            "Updated clip gain",
            vec![CacheInvalidation::AudioMix, CacheInvalidation::RenderPlan],
        ),
        ProjectCommand::AddMarker { .. } => ("Added marker", vec![CacheInvalidation::Timeline]),
        ProjectCommand::RemoveMarker { .. } => {
            ("Removed marker", vec![CacheInvalidation::Timeline])
        }
        ProjectCommand::AddCaption { .. } => (
            "Added caption",
            vec![CacheInvalidation::Captions, CacheInvalidation::RenderPlan],
        ),
        ProjectCommand::RemoveCaption { .. } => (
            "Removed caption",
            vec![CacheInvalidation::Captions, CacheInvalidation::RenderPlan],
        ),
        ProjectCommand::ApplyCaptionArtifact { .. } => (
            "Apply caption artifact",
            vec![CacheInvalidation::Captions, CacheInvalidation::RenderPlan],
        ),
        ProjectCommand::RestoreActiveCaptionArtifact { .. } => (
            "Restore active caption artifact",
            vec![CacheInvalidation::Captions, CacheInvalidation::RenderPlan],
        ),
        ProjectCommand::RelinkAsset { .. } => (
            "Relinked asset",
            vec![
                CacheInvalidation::AssetSource,
                CacheInvalidation::Preview,
                CacheInvalidation::RenderPlan,
            ],
        ),
        ProjectCommand::RemoveAsset { .. } => (
            "Removed asset",
            vec![
                CacheInvalidation::AssetSource,
                CacheInvalidation::RenderPlan,
            ],
        ),
    }
}

fn locked_mutation_target(command: &ProjectCommand) -> Option<(&str, &str)> {
    match command {
        ProjectCommand::InsertClip {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::RemoveClip {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::RippleDeleteClip {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::RestoreRippleDeletedClip {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::SplitClip {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::MoveClip {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::TrimClip {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::SetClipTransform {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::SetClipOpacity {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::SetClipSpeed {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::RestoreClipSpeed {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::SetClipFades {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::RestoreClipFades {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::SetClipGain {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::AddCaption {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::RemoveCaption {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::ApplyCaptionArtifact {
            sequence_id,
            track_id,
            ..
        }
        | ProjectCommand::RestoreActiveCaptionArtifact {
            sequence_id,
            track_id,
            ..
        } => Some((sequence_id, track_id)),
        _ => None,
    }
}

fn apply_one(
    state: &mut VideoProjectStateV2,
    command: &ProjectCommand,
) -> Result<(Vec<ProjectCommand>, Vec<AffectedRange>), VideoCommandError> {
    if let Some((sequence_id, track_id)) = locked_mutation_target(command) {
        let track = find_track_mut(state, sequence_id, track_id)?;
        if track.is_locked() {
            return Err(invalid("track_locked"));
        }
    }
    let id = command.command_id();
    match command {
        ProjectCommand::ImportAsset { index, asset, .. } => {
            if state.assets.iter().any(|item| item.id == asset.id) {
                return Err(invalid("duplicate_asset"));
            }
            if let Some(index) = insertion_index(*index, state.assets.len(), "asset_index")? {
                state.assets.insert(index, asset.clone());
            } else {
                state.assets.push(asset.clone());
            }
            Ok((
                vec![ProjectCommand::RemoveAsset {
                    command_id: inverse_id(id, 0),
                    asset_id: asset.id.as_str().to_owned(),
                }],
                vec![],
            ))
        }
        ProjectCommand::RemoveAsset { asset_id, .. } => {
            if state.sequences.iter().flat_map(|sequence| &sequence.tracks).flat_map(|track| track.clips().unwrap_or_default()).any(|clip| matches!(&clip.source, super::types::ClipSource::Asset { asset_id: source } if source == asset_id)) { return Err(invalid("asset_in_use")); }
            let index = state
                .assets
                .iter()
                .position(|asset| asset.id.as_str() == asset_id)
                .ok_or_else(|| invalid("unknown_asset"))?;
            let asset = state.assets.remove(index);
            Ok((
                vec![ProjectCommand::ImportAsset {
                    command_id: inverse_id(id, 0),
                    index: Some(index as u64),
                    asset,
                }],
                vec![],
            ))
        }
        ProjectCommand::CreateSequence {
            index,
            active_sequence_id,
            sequence,
            ..
        } => {
            if state.sequences.iter().any(|item| item.id == sequence.id) {
                return Err(invalid("duplicate_sequence"));
            }
            let previous_active_sequence_id = state.active_sequence_id.clone();
            if let Some(index) = insertion_index(*index, state.sequences.len(), "sequence_index")? {
                state.sequences.insert(index, sequence.clone());
            } else {
                state.sequences.push(sequence.clone());
            }
            state.active_sequence_id = active_sequence_id
                .clone()
                .or_else(|| Some(sequence.id.clone()));
            Ok((
                vec![ProjectCommand::RemoveSequence {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence.id.clone(),
                    active_sequence_id: previous_active_sequence_id,
                }],
                vec![],
            ))
        }
        ProjectCommand::RemoveSequence {
            sequence_id,
            active_sequence_id,
            ..
        } => {
            if state.sequences.iter().flat_map(|sequence| &sequence.tracks).flat_map(|track| track.clips().unwrap_or_default()).any(|clip| matches!(&clip.source, super::types::ClipSource::Sequence { sequence_id: source } if source == sequence_id)) { return Err(invalid("sequence_in_use")); }
            if active_sequence_id.as_ref().is_some_and(|requested| {
                requested == sequence_id
                    || !state
                        .sequences
                        .iter()
                        .any(|sequence| sequence.id == *requested)
            }) {
                return Err(invalid("active_sequence"));
            }
            let previous_active_sequence_id = state.active_sequence_id.clone();
            let index = state
                .sequences
                .iter()
                .position(|sequence| sequence.id == *sequence_id)
                .ok_or_else(|| invalid("unknown_sequence"))?;
            let sequence = state.sequences.remove(index);
            state.active_sequence_id = active_sequence_id.clone().or_else(|| {
                if previous_active_sequence_id.as_deref() == Some(sequence_id) {
                    state.sequences.first().map(|item| item.id.clone())
                } else {
                    previous_active_sequence_id.clone()
                }
            });
            Ok((
                vec![ProjectCommand::CreateSequence {
                    command_id: inverse_id(id, 0),
                    index: Some(index as u64),
                    active_sequence_id: previous_active_sequence_id,
                    sequence,
                }],
                vec![],
            ))
        }
        ProjectCommand::InsertTrack {
            sequence_id,
            index,
            track,
            ..
        } => {
            let sequence = find_sequence_mut(state, sequence_id)?;
            let index = usize::try_from(*index).map_err(|_| invalid("track_index"))?;
            if index > sequence.tracks.len()
                || sequence.tracks.iter().any(|item| item.id() == track.id())
            {
                return Err(invalid("track_index"));
            }
            sequence.tracks.insert(index, track.clone());
            Ok((
                vec![ProjectCommand::RemoveTrack {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track.id().to_owned(),
                }],
                vec![],
            ))
        }
        ProjectCommand::RemoveTrack {
            sequence_id,
            track_id,
            ..
        } => {
            let sequence = find_sequence_mut(state, sequence_id)?;
            let index = sequence
                .tracks
                .iter()
                .position(|track| track.id() == track_id)
                .ok_or_else(|| invalid("unknown_track"))?;
            let track = sequence.tracks.remove(index);
            Ok((
                vec![ProjectCommand::InsertTrack {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    index: index as u64,
                    track,
                }],
                vec![],
            ))
        }
        ProjectCommand::SetTrackLocked {
            sequence_id,
            track_id,
            locked,
            ..
        } => {
            let previous = find_track_mut(state, sequence_id, track_id)?.set_locked(*locked);
            Ok((
                vec![ProjectCommand::SetTrackLocked {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    locked: previous,
                }],
                vec![],
            ))
        }
        ProjectCommand::SetTrackMuted {
            sequence_id,
            track_id,
            muted,
            ..
        } => {
            let track = find_track_mut(state, sequence_id, track_id)?;
            let affected_ranges = track_range(sequence_id, track)?;
            let previous = track
                .set_muted(*muted)
                .map_err(|TrackMuteError::InvalidTarget| invalid("non_audio_track"))?;
            Ok((
                vec![ProjectCommand::SetTrackMuted {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    muted: previous,
                }],
                affected_ranges,
            ))
        }
        ProjectCommand::SetTrackHidden {
            sequence_id,
            track_id,
            hidden,
            ..
        } => {
            let track = find_track_mut(state, sequence_id, track_id)?;
            let affected_ranges = visual_track_range(sequence_id, track)?;
            let previous = track
                .set_hidden(*hidden)
                .map_err(|TrackVisibilityError::InvalidTarget| invalid("non_visual_track"))?;
            Ok((
                vec![ProjectCommand::SetTrackHidden {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    hidden: previous,
                }],
                affected_ranges,
            ))
        }
        ProjectCommand::InsertClip {
            sequence_id,
            track_id,
            index,
            clip,
            ..
        } => {
            let range = clip_range(sequence_id, clip)?;
            let clips = find_unlocked_track_mut(state, sequence_id, track_id)?
                .clips_mut()
                .ok_or_else(|| invalid("caption_track"))?;
            if clips.iter().any(|item| item.id == clip.id) {
                return Err(invalid("duplicate_clip"));
            }
            if let Some(index) = insertion_index(*index, clips.len(), "clip_index")? {
                clips.insert(index, clip.clone());
            } else {
                clips.push(clip.clone());
                clips.sort_by_key(|item| item.timeline_start.value);
            }
            Ok((
                vec![ProjectCommand::RemoveClip {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    clip_id: clip.id.clone(),
                }],
                vec![range],
            ))
        }
        ProjectCommand::RemoveClip {
            sequence_id,
            track_id,
            clip_id,
            ..
        } => {
            let clips = find_unlocked_track_mut(state, sequence_id, track_id)?
                .clips_mut()
                .ok_or_else(|| invalid("caption_track"))?;
            let index = clips
                .iter()
                .position(|clip| clip.id == *clip_id)
                .ok_or_else(|| invalid("unknown_clip"))?;
            let clip = clips.remove(index);
            let range = clip_range(sequence_id, &clip)?;
            Ok((
                vec![ProjectCommand::InsertClip {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    index: Some(index as u64),
                    clip,
                }],
                vec![range],
            ))
        }
        ProjectCommand::RippleDeleteClip {
            sequence_id,
            track_id,
            clip_id,
            ..
        } => {
            let clips = find_unlocked_track_mut(state, sequence_id, track_id)?
                .clips_mut()
                .ok_or_else(|| invalid("caption_track"))?;
            let index = clips
                .iter()
                .position(|clip| clip.id == *clip_id)
                .ok_or_else(|| invalid("unknown_clip"))?;
            let removed = clips[index].clone();
            let duration = clip_duration_on_timeline(&removed)?;
            let affected_end = clip_range(
                sequence_id,
                clips.last().ok_or_else(|| invalid("unknown_clip"))?,
            )?
            .end;
            clips.remove(index);
            for clip in &mut clips[index..] {
                clip.timeline_start.value = clip
                    .timeline_start
                    .value
                    .checked_sub(duration)
                    .ok_or_else(|| invalid("ripple_underflow"))?;
            }
            Ok((
                vec![ProjectCommand::RestoreRippleDeletedClip {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    index: index as u64,
                    clip: removed.clone(),
                }],
                vec![AffectedRange {
                    sequence_id: sequence_id.clone(),
                    start: removed.timeline_start,
                    end: affected_end,
                }],
            ))
        }
        ProjectCommand::RestoreRippleDeletedClip {
            sequence_id,
            track_id,
            index,
            clip,
            ..
        } => {
            let duration = clip_duration_on_timeline(clip)?;
            let clips = find_unlocked_track_mut(state, sequence_id, track_id)?
                .clips_mut()
                .ok_or_else(|| invalid("caption_track"))?;
            if clips.iter().any(|item| item.id == clip.id) {
                return Err(invalid("duplicate_clip"));
            }
            let index = usize::try_from(*index).map_err(|_| invalid("clip_index"))?;
            if index > clips.len() {
                return Err(invalid("clip_index"));
            }
            for shifted in &mut clips[index..] {
                shifted.timeline_start.value = shifted
                    .timeline_start
                    .value
                    .checked_add(duration)
                    .filter(|value| *value <= MAX_SAFE_INTEGER)
                    .ok_or_else(|| invalid("ripple_overflow"))?;
            }
            clips.insert(index, clip.clone());
            let affected_end = clip_range(
                sequence_id,
                clips.last().ok_or_else(|| invalid("unknown_clip"))?,
            )?
            .end;
            Ok((
                vec![ProjectCommand::RippleDeleteClip {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    clip_id: clip.id.clone(),
                }],
                vec![AffectedRange {
                    sequence_id: sequence_id.clone(),
                    start: clip.timeline_start.clone(),
                    end: affected_end,
                }],
            ))
        }
        ProjectCommand::SplitClip {
            sequence_id,
            track_id,
            clip_id,
            split_at,
            right_clip_id,
            ..
        } => {
            if !is_canonical_uuid(right_clip_id) {
                return Err(invalid("right_clip_id"));
            }
            let clips = find_unlocked_track_mut(state, sequence_id, track_id)?
                .clips_mut()
                .ok_or_else(|| invalid("caption_track"))?;
            if clips.iter().any(|clip| clip.id == *right_clip_id) {
                return Err(invalid("duplicate_clip"));
            }
            let index = clips
                .iter()
                .position(|clip| clip.id == *clip_id)
                .ok_or_else(|| invalid("unknown_clip"))?;
            let original = clips[index].clone();
            if split_at.rate_numerator != original.source_in.rate_numerator
                || split_at.rate_denominator != original.source_in.rate_denominator
                || split_at.value <= original.source_in.value
                || split_at.value >= original.source_out.value
            {
                return Err(invalid("split_range"));
            }
            let source_offset = split_at
                .value
                .checked_sub(original.source_in.value)
                .ok_or_else(|| invalid("split_range"))?;
            let timeline_offset = source_offset_to_timeline(
                &RationalTime {
                    value: source_offset,
                    ..original.source_in.clone()
                },
                &RationalRate {
                    numerator: original.timeline_start.rate_numerator,
                    denominator: original.timeline_start.rate_denominator,
                },
                &original.speed.unwrap_or_default(),
                SamplePolicy::Exact,
            )
            .map_err(timing_error)?
            .value;
            let right_timeline_start = original
                .timeline_start
                .value
                .checked_add(timeline_offset)
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(|| invalid("safe_integer"))?;
            clips[index].source_out = split_at.clone();
            let mut right = original.clone();
            right.id = right_clip_id.clone();
            right.source_in = split_at.clone();
            right.timeline_start.value = right_timeline_start;
            clips.insert(index + 1, right.clone());
            let affected = clip_range(sequence_id, &original)?;
            Ok((
                vec![
                    ProjectCommand::RemoveClip {
                        command_id: inverse_id(id, 0),
                        sequence_id: sequence_id.clone(),
                        track_id: track_id.clone(),
                        clip_id: right.id,
                    },
                    ProjectCommand::TrimClip {
                        command_id: inverse_id(id, 1),
                        sequence_id: sequence_id.clone(),
                        track_id: track_id.clone(),
                        clip_id: original.id.clone(),
                        source_in: original.source_in,
                        source_out: original.source_out,
                    },
                ],
                vec![affected],
            ))
        }
        ProjectCommand::MoveClip {
            sequence_id,
            track_id,
            clip_id,
            timeline_start,
            ..
        } => {
            let clip = find_clip_mut(state, sequence_id, track_id, clip_id)?;
            let before = clip_range(sequence_id, clip)?;
            let previous = clip.timeline_start.clone();
            clip.timeline_start = timeline_start.clone();
            let after = clip_range(sequence_id, clip)?;
            find_unlocked_track_mut(state, sequence_id, track_id)?
                .clips_mut()
                .unwrap()
                .sort_by_key(|item| item.timeline_start.value);
            Ok((
                vec![ProjectCommand::MoveClip {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    clip_id: clip_id.clone(),
                    timeline_start: previous,
                }],
                vec![before, after],
            ))
        }
        ProjectCommand::TrimClip {
            sequence_id,
            track_id,
            clip_id,
            source_in,
            source_out,
            ..
        } => {
            let clip = find_clip_mut(state, sequence_id, track_id, clip_id)?;
            let before = clip_range(sequence_id, clip)?;
            let previous_in = clip.source_in.clone();
            let previous_out = clip.source_out.clone();
            clip.source_in = source_in.clone();
            clip.source_out = source_out.clone();
            let after = clip_range(sequence_id, clip)?;
            Ok((
                vec![ProjectCommand::TrimClip {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    clip_id: clip_id.clone(),
                    source_in: previous_in,
                    source_out: previous_out,
                }],
                vec![before, after],
            ))
        }
        ProjectCommand::SetClipTransform {
            sequence_id,
            track_id,
            clip_id,
            transform,
            ..
        } => {
            if !valid_transform(transform) {
                return Err(invalid("clip_transform"));
            }
            let track = find_unlocked_track_mut(state, sequence_id, track_id)?;
            let ProjectTrack::Video { clips, .. } = track else {
                return Err(invalid("non_video_track"));
            };
            let clip = clips
                .iter_mut()
                .find(|clip| clip.id == *clip_id)
                .ok_or_else(|| invalid("unknown_clip"))?;
            let affected_range = clip_range(sequence_id, clip)?;
            let previous = std::mem::replace(&mut clip.transform, transform.clone());
            Ok((
                vec![ProjectCommand::SetClipTransform {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    clip_id: clip_id.clone(),
                    transform: previous,
                }],
                vec![affected_range],
            ))
        }
        ProjectCommand::SetClipOpacity {
            sequence_id,
            track_id,
            clip_id,
            opacity_permille,
            ..
        } => {
            if *opacity_permille > 1_000 {
                return Err(invalid("opacity_permille"));
            }
            let track = find_unlocked_track_mut(state, sequence_id, track_id)?;
            let ProjectTrack::Video { clips, .. } = track else {
                return Err(invalid("non_video_track"));
            };
            let clip = clips
                .iter_mut()
                .find(|clip| clip.id == *clip_id)
                .ok_or_else(|| invalid("unknown_clip"))?;
            let affected_range = clip_range(sequence_id, clip)?;
            let previous = u16::try_from(clip.transform.opacity_permille)
                .map_err(|_| invalid("opacity_permille"))?;
            clip.transform.opacity_permille = u64::from(*opacity_permille);
            Ok((
                vec![ProjectCommand::SetClipOpacity {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    clip_id: clip_id.clone(),
                    opacity_permille: previous,
                }],
                vec![affected_range],
            ))
        }
        ProjectCommand::SetClipSpeed {
            sequence_id,
            track_id,
            clip_id,
            speed,
            ..
        } => {
            let desired = normalize_speed(*speed).map_err(|_| invalid("clip_speed"))?;
            set_clip_speed(state, id, sequence_id, track_id, clip_id, desired)
        }
        ProjectCommand::RestoreClipSpeed {
            sequence_id,
            track_id,
            clip_id,
            speed,
            ..
        } => set_clip_speed(state, id, sequence_id, track_id, clip_id, *speed),
        ProjectCommand::SetClipFades {
            sequence_id,
            track_id,
            clip_id,
            fades,
            ..
        } => set_clip_fades(
            state,
            id,
            sequence_id,
            track_id,
            clip_id,
            if fades.in_frames == 0 && fades.out_frames == 0 {
                None
            } else {
                Some(*fades)
            },
        ),
        ProjectCommand::RestoreClipFades {
            sequence_id,
            track_id,
            clip_id,
            fades,
            ..
        } => set_clip_fades(state, id, sequence_id, track_id, clip_id, *fades),
        ProjectCommand::SetClipGain {
            sequence_id,
            track_id,
            clip_id,
            gain_milli_decibels,
            ..
        } => {
            let clip = find_clip_mut(state, sequence_id, track_id, clip_id)?;
            let previous = std::mem::replace(&mut clip.gain_milli_decibels, *gain_milli_decibels);
            Ok((
                vec![ProjectCommand::SetClipGain {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    clip_id: clip_id.clone(),
                    gain_milli_decibels: previous,
                }],
                vec![clip_range(sequence_id, clip)?],
            ))
        }
        ProjectCommand::AddMarker {
            sequence_id,
            index,
            marker,
            ..
        } => {
            let sequence = find_sequence_mut(state, sequence_id)?;
            if sequence.markers.iter().any(|item| item.id == marker.id) {
                return Err(invalid("duplicate_marker"));
            }
            if let Some(index) = insertion_index(*index, sequence.markers.len(), "marker_index")? {
                sequence.markers.insert(index, marker.clone());
            } else {
                sequence.markers.push(marker.clone());
                sequence.markers.sort_by_key(|item| item.time.value);
            }
            Ok((
                vec![ProjectCommand::RemoveMarker {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    marker_id: marker.id.clone(),
                }],
                vec![],
            ))
        }
        ProjectCommand::RemoveMarker {
            sequence_id,
            marker_id,
            ..
        } => {
            let sequence = find_sequence_mut(state, sequence_id)?;
            let index = sequence
                .markers
                .iter()
                .position(|marker| marker.id == *marker_id)
                .ok_or_else(|| invalid("unknown_marker"))?;
            let marker = sequence.markers.remove(index);
            Ok((
                vec![ProjectCommand::AddMarker {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    index: Some(index as u64),
                    marker,
                }],
                vec![],
            ))
        }
        ProjectCommand::AddCaption {
            sequence_id,
            track_id,
            index,
            caption,
            ..
        } => {
            let ProjectTrack::Caption { captions, .. } =
                find_unlocked_track_mut(state, sequence_id, track_id)?
            else {
                return Err(invalid("non_caption_track"));
            };
            if captions.iter().any(|item| item.id == caption.id) {
                return Err(invalid("duplicate_caption"));
            }
            if let Some(index) = insertion_index(*index, captions.len(), "caption_index")? {
                captions.insert(index, caption.clone());
            } else {
                captions.push(caption.clone());
                captions.sort_by_key(|item| item.start.value);
            }
            Ok((
                vec![ProjectCommand::RemoveCaption {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    caption_id: caption.id.clone(),
                }],
                vec![],
            ))
        }
        ProjectCommand::RemoveCaption {
            sequence_id,
            track_id,
            caption_id,
            ..
        } => {
            let ProjectTrack::Caption { captions, .. } =
                find_unlocked_track_mut(state, sequence_id, track_id)?
            else {
                return Err(invalid("non_caption_track"));
            };
            let index = captions
                .iter()
                .position(|caption| caption.id == *caption_id)
                .ok_or_else(|| invalid("unknown_caption"))?;
            let caption = captions.remove(index);
            Ok((
                vec![ProjectCommand::AddCaption {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    index: Some(index as u64),
                    caption,
                }],
                vec![],
            ))
        }
        ProjectCommand::ApplyCaptionArtifact {
            sequence_id,
            track_id,
            artifact,
            ..
        } => {
            let previous =
                replace_active_caption_artifact(state, sequence_id, track_id, Some(artifact))?;
            Ok((
                vec![ProjectCommand::RestoreActiveCaptionArtifact {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    artifact: previous,
                }],
                vec![],
            ))
        }
        ProjectCommand::RestoreActiveCaptionArtifact {
            sequence_id,
            track_id,
            artifact,
            ..
        } => {
            let previous =
                replace_active_caption_artifact(state, sequence_id, track_id, artifact.as_ref())?;
            Ok((
                vec![ProjectCommand::RestoreActiveCaptionArtifact {
                    command_id: inverse_id(id, 0),
                    sequence_id: sequence_id.clone(),
                    track_id: track_id.clone(),
                    artifact: previous,
                }],
                vec![],
            ))
        }
        ProjectCommand::RelinkAsset {
            asset_id,
            locator,
            probe,
            content_identity,
            ..
        } => {
            let asset = state
                .assets
                .iter_mut()
                .find(|asset| asset.id.as_str() == asset_id)
                .ok_or_else(|| invalid("unknown_asset"))?;
            let old_locator = std::mem::replace(&mut asset.locator, locator.clone());
            let old_probe = std::mem::replace(&mut asset.probe, probe.clone());
            let old_content_identity =
                std::mem::replace(&mut asset.content_identity, content_identity.clone());
            Ok((
                vec![ProjectCommand::RelinkAsset {
                    command_id: inverse_id(id, 0),
                    asset_id: asset_id.clone(),
                    locator: old_locator,
                    probe: old_probe,
                    content_identity: old_content_identity,
                }],
                vec![],
            ))
        }
    }
}

pub fn apply_group(
    base: &VideoProjectStateV2,
    commands: &[ProjectCommand],
) -> Result<AppliedGroup, VideoCommandError> {
    if commands.is_empty() || commands.len() > super::types::MAX_GROUP_COMMANDS {
        return Err(invalid("group_size"));
    }
    let mut command_ids = HashSet::new();
    if commands.iter().any(|command| {
        !is_canonical_uuid(command.command_id()) || !command_ids.insert(command.command_id())
    }) {
        return Err(invalid("command_id"));
    }
    // A group must not silently detach managed captions before retiming their source.
    for command in commands {
        if let ProjectCommand::SetClipSpeed {
            sequence_id,
            track_id,
            clip_id,
            speed,
            ..
        } = command
        {
            if let Ok(clip) = find_speed_target(base, sequence_id, track_id, clip_id) {
                if clip.speed.unwrap_or_default() != *speed {
                    validate_retimed_context(base, sequence_id, track_id, clip_id)?;
                }
            }
        }
    }
    let mut state = base.clone();
    let mut inverse_commands = Vec::new();
    let mut summaries = Vec::new();
    let mut affected_ranges = Vec::new();
    let mut invalidations = Vec::new();
    for command in commands {
        let (mut inverse, mut ranges) = apply_one(&mut state, command)?;
        inverse.reverse();
        inverse_commands.splice(0..0, inverse);
        affected_ranges.append(&mut ranges);
        let (summary, command_invalidations) = command_metadata(command);
        summaries.push(summary);
        for invalidation in command_invalidations {
            if !invalidations.contains(&invalidation) {
                invalidations.push(invalidation);
            }
        }
    }
    validate_state(&state)?;
    let joined_summary = summaries.join(", ");
    let summary = if joined_summary.encode_utf16().count() <= MAX_NON_BLANK_UTF16 {
        joined_summary
    } else {
        format!("Applied {} commands", commands.len())
    };
    Ok(AppliedGroup {
        state,
        inverse_commands,
        summary,
        affected_ranges,
        cache_invalidations: invalidations,
    })
}
