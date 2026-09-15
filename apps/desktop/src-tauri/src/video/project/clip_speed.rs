use std::collections::{HashMap, HashSet};

use super::{
    clip_timing::ClipSpeed,
    integrity::is_canonical_uuid,
    types::{ClipSource, ProjectClip, ProjectTrack, VideoProjectStateV2, VideoSequenceV2},
};
use crate::video::{
    error::{VideoCommandError, VideoErrorCode},
    types::MediaContentIdentityV1,
};

fn invalid(category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        VideoErrorCode::InvalidProject,
        "Clip speed context is unsupported",
        "validate_clip_speed",
        category,
    )
}

pub(super) fn find_speed_target<'a>(
    state: &'a VideoProjectStateV2,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
) -> Result<&'a ProjectClip, VideoCommandError> {
    if ![sequence_id, track_id, clip_id]
        .into_iter()
        .all(is_canonical_uuid)
    {
        return Err(invalid("speed_target_id"));
    }
    let sequence = state
        .sequences
        .iter()
        .find(|sequence| sequence.id == sequence_id)
        .ok_or_else(|| invalid("sequence_id"))?;
    let track = sequence
        .tracks
        .iter()
        .find(|track| track.id() == track_id)
        .ok_or_else(|| invalid("track_id"))?;
    let ProjectTrack::Video { clips, .. } = track else {
        return Err(invalid("speed_video_asset_only"));
    };
    let clip = clips
        .iter()
        .find(|clip| clip.id == clip_id)
        .ok_or_else(|| invalid("clip_id"))?;
    if !matches!(clip.source, ClipSource::Asset { .. }) {
        return Err(invalid("speed_video_asset_only"));
    }
    Ok(clip)
}

fn nested_sequences(state: &VideoProjectStateV2) -> HashSet<&str> {
    state
        .sequences
        .iter()
        .flat_map(|sequence| &sequence.tracks)
        .flat_map(|track| track.clips().unwrap_or_default())
        .filter_map(|clip| match &clip.source {
            ClipSource::Sequence { sequence_id } => Some(sequence_id.as_str()),
            _ => None,
        })
        .collect()
}

// Identity validation fixes schemaVersion=1 and algorithm=sha256; these are the remaining identity fields.
fn managed_sources(sequence: &VideoSequenceV2) -> HashSet<(&str, u64)> {
    sequence
        .tracks
        .iter()
        .filter_map(|track| match track {
            ProjectTrack::Caption {
                active_caption_artifact: Some(artifact),
                ..
            } => Some((
                artifact.source_identity.digest.as_str(),
                artifact.source_identity.byte_length,
            )),
            _ => None,
        })
        .collect()
}

fn check_context(
    nested: bool,
    identity: Option<&MediaContentIdentityV1>,
    managed: &HashSet<(&str, u64)>,
) -> Result<(), VideoCommandError> {
    if nested {
        return Err(invalid("speed_nested_sequence_unsupported"));
    }
    // Missing lineage cannot prove that managed captions are unrelated.
    if !managed.is_empty()
        && identity.is_none_or(|identity| {
            managed.contains(&(identity.digest.as_str(), identity.byte_length))
        })
    {
        return Err(invalid("speed_managed_captions_unsupported"));
    }
    Ok(())
}

/// Shared policy for command preflight and loaded state: no caption retiming or child-duration propagation.
pub(super) fn validate_retimed_context(
    state: &VideoProjectStateV2,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
) -> Result<(), VideoCommandError> {
    let clip = find_speed_target(state, sequence_id, track_id, clip_id)?;
    let ClipSource::Asset { asset_id } = &clip.source else {
        return Err(invalid("speed_video_asset_only"));
    };
    let asset = state
        .assets
        .iter()
        .find(|asset| asset.id.as_str() == asset_id)
        .ok_or_else(|| invalid("clip_reference"))?;
    let sequence = state
        .sequences
        .iter()
        .find(|sequence| sequence.id == sequence_id)
        .ok_or_else(|| invalid("sequence_id"))?;
    check_context(
        nested_sequences(state).contains(sequence_id),
        asset.content_identity.as_ref(),
        &managed_sources(sequence),
    )
}

pub(super) fn validate_retimed_state(state: &VideoProjectStateV2) -> Result<(), VideoCommandError> {
    // Index once, not one whole-project scan for every retimed clip in an uploaded project.
    let nested = nested_sequences(state);
    let assets: HashMap<_, _> = state
        .assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset.content_identity.as_ref()))
        .collect();
    for sequence in &state.sequences {
        let managed = managed_sources(sequence);
        for track in &sequence.tracks {
            for clip in track.clips().unwrap_or_default() {
                if clip.speed.is_none_or(|speed| speed == ClipSpeed::default()) {
                    continue;
                }
                if !matches!(track, ProjectTrack::Video { .. }) {
                    return Err(invalid("speed_video_asset_only"));
                }
                let ClipSource::Asset { asset_id } = &clip.source else {
                    return Err(invalid("speed_video_asset_only"));
                };
                let identity = assets
                    .get(asset_id.as_str())
                    .ok_or_else(|| invalid("clip_reference"))?;
                check_context(nested.contains(sequence.id.as_str()), *identity, &managed)?;
            }
        }
    }
    Ok(())
}
