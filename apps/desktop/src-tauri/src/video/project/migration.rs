use uuid::Uuid;

use super::{
    hash::state_hash,
    types::{
        ClipSource, ClipTransform, ProjectClip, ProjectHistoryV2, ProjectRevisionDescriptorV2,
        ProjectTrack, VideoProjectSnapshotV2, VideoProjectStateV2, VideoSequenceV2,
    },
};
use crate::video::{
    error::VideoCommandError,
    types::{parse_project_json, VideoProjectFileV1},
};

fn new_id() -> String {
    Uuid::new_v4().hyphenated().to_string()
}

pub fn migrate_v1_bytes(bytes: &[u8]) -> Result<VideoProjectSnapshotV2, VideoCommandError> {
    migrate_v1(parse_project_json(bytes)?)
}

pub fn migrate_v1(
    document: VideoProjectFileV1,
) -> Result<VideoProjectSnapshotV2, VideoCommandError> {
    let selected = document
        .revisions
        .iter()
        .find(|revision| revision.id == document.current_revision_id)
        .ok_or_else(|| VideoCommandError::invalid_project(["selected V1 revision is missing"]))?;
    let assets = selected.state.asset.clone().into_iter().collect::<Vec<_>>();
    let sequences = selected
        .state
        .sequence
        .as_ref()
        .map(|sequence| {
            let tracks = sequence
                .video_tracks
                .iter()
                .map(|track| ProjectTrack::Video {
                    id: track.id.as_str().to_owned(),
                    name: "Video 1".to_owned(),
                    locked: false,
                    muted: false,
                    hidden: false,
                    clips: track
                        .clips
                        .iter()
                        .map(|clip| ProjectClip {
                            id: clip.id.as_str().to_owned(),
                            source: ClipSource::Asset {
                                asset_id: clip.asset_id.as_str().to_owned(),
                            },
                            timeline_start: clip.timeline_start.clone(),
                            source_in: clip.source_in.clone(),
                            source_out: clip.source_out.clone(),
                            transform: ClipTransform::default(),
                            gain_milli_decibels: 0,
                        })
                        .collect(),
                })
                .collect();
            VideoSequenceV2 {
                id: sequence.id.as_str().to_owned(),
                name: "Sequence 1".to_owned(),
                rate: sequence.rate.clone(),
                width: sequence.width,
                height: sequence.height,
                audio_sample_rate: sequence.audio_sample_rate,
                tracks,
                markers: vec![],
            }
        })
        .into_iter()
        .collect::<Vec<_>>();
    let active_sequence_id = sequences.first().map(|sequence| sequence.id.clone());
    let state = VideoProjectStateV2 {
        assets,
        sequences,
        active_sequence_id,
    };
    let state_hash = state_hash(&state)?;
    let operation_id = new_id();
    Ok(VideoProjectSnapshotV2 {
        schema_version: 2,
        id: document.id.as_str().to_owned(),
        name: document.name,
        created_at: document.created_at,
        updated_at: document.updated_at.clone(),
        storage_generation_id: new_id(),
        revision: ProjectRevisionDescriptorV2 {
            number: 0,
            id: new_id(),
            parent_id: None,
            committed_at: document.updated_at,
            operation_id,
            state_hash,
        },
        state,
        history: ProjectHistoryV2::default(),
        last_applied_record_number: 0,
        last_record_hash: "0".repeat(64),
    })
}
