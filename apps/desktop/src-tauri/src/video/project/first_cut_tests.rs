//! First-cut command groups (packages/video-produce golden fixtures) applied
//! through the native transactional commit path, then undone in one step.
use serde_json::{json, Value};

use super::{
    hash::{canonical_bytes, state_hash},
    history::{commit_transition, undo_transition},
    integrity::validate_snapshot,
    types::{CommandGroupRequest, ProjectTrack, VideoProjectSnapshotV2},
};

fn track_name(track: &ProjectTrack) -> &str {
    match track {
        ProjectTrack::Video { name, .. }
        | ProjectTrack::Audio { name, .. }
        | ProjectTrack::Caption { name, .. }
        | ProjectTrack::Graphics { name, .. } => name,
    }
}

const NOW: &str = "2026-09-29T09:00:00.000Z";
const UNDO_OPERATION: &str = "f1000000-0000-4000-8000-000000000001";

fn snapshot_for(fixture: &Value) -> VideoProjectSnapshotV2 {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../../../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo"
    ))
    .unwrap();
    value["id"] = fixture["projectId"].clone();
    value["state"] = fixture["state"].clone();
    let mut snapshot: VideoProjectSnapshotV2 = serde_json::from_value(value).unwrap();
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    validate_snapshot(&snapshot).unwrap();
    snapshot
}

fn apply_then_undo(fixture_json: &str, expected_json: &str, expected_new_tracks: &[&str]) {
    let fixture: Value = serde_json::from_str(fixture_json).unwrap();
    let expected: Value = serde_json::from_str(expected_json).unwrap();
    let original = snapshot_for(&fixture);
    let mut request_value = expected["compiled"]["request"].clone();
    // Fixtures record the planning revision; bind to this snapshot's revision.
    request_value["baseRevision"] = json!(original.revision.number);
    let request: CommandGroupRequest = serde_json::from_value(request_value).unwrap();

    let applied = commit_transition(&original, &request, NOW).unwrap();
    validate_snapshot(&applied.snapshot).unwrap();
    assert_eq!(
        applied.snapshot.revision.number,
        original.revision.number + 1
    );
    assert_eq!(applied.snapshot.history.undo_stack.len(), 1);

    let before = &original.state.sequences[0];
    let after = &applied.snapshot.state.sequences[0];
    // Existing tracks and markers are untouched; only new tracks are appended.
    assert_eq!(&after.tracks[..before.tracks.len()], &before.tracks[..]);
    assert_eq!(&after.markers[..before.markers.len()], &before.markers[..]);
    let names: Vec<&str> = after.tracks[before.tracks.len()..]
        .iter()
        .map(track_name)
        .collect();
    assert_eq!(names, expected_new_tracks);

    let undone = undo_transition(
        &applied.snapshot,
        applied.snapshot.revision.number,
        UNDO_OPERATION,
        NOW,
    )
    .unwrap();
    assert_eq!(undone.snapshot.state, original.state);
    assert_eq!(
        canonical_bytes(&undone.snapshot.state).unwrap(),
        canonical_bytes(&original.state).unwrap()
    );
    assert_eq!(
        undone.snapshot.revision.state_hash,
        original.revision.state_hash
    );
}

#[test]
fn explainer_first_cut_applies_atomically_and_undoes_to_the_original_state() {
    apply_then_undo(
        include_str!("../../../../../../packages/video-produce/fixtures/v1/explainer.json"),
        include_str!(
            "../../../../../../packages/video-produce/fixtures/v1/explainer.expected.json"
        ),
        &["First cut", "First cut titles"],
    );
}

#[test]
fn podcast_first_cut_adds_cutaways_above_the_a_roll_and_undoes_cleanly() {
    apply_then_undo(
        include_str!("../../../../../../packages/video-produce/fixtures/v1/podcast.json"),
        include_str!("../../../../../../packages/video-produce/fixtures/v1/podcast.expected.json"),
        &["First cut"],
    );
}
