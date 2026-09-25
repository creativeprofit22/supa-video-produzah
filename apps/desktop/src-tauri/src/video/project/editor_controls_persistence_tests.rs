use std::fs;

use serde_json::{json, Value};
use tempfile::tempdir;

use super::{
    hash::{canonical_bytes, state_hash},
    journal::{journal_path, scan},
    service::VideoProjectService,
    snapshot::read_snapshot,
    speed_edit_tests::{fixture, request},
    types::{ProjectCommand, RecoveryStatus, VideoProjectSnapshotV2},
};
use crate::video::VideoPathGrants;

const OWNER: &str = "editor-controls-storage";

fn id(value: u64) -> String {
    format!("71000000-0000-4000-8000-{value:012x}")
}

fn time(value: u64) -> Value {
    json!({"value": value, "rateNumerator": 30, "rateDenominator": 1})
}

// Two different tracks ensure a later locked target rejects an earlier valid edit.
// Expected state is constructed independently of the command/history implementation.
fn edits(
    original: &VideoProjectSnapshotV2,
    operation: &str,
) -> (Vec<ProjectCommand>, super::types::VideoProjectStateV2) {
    let mut expected = serde_json::to_value(&original.state).unwrap();
    let mut commands = Vec::new();
    for track_index in 0..2 {
        let track = &original.state.sequences[0].tracks[track_index];
        let clip = &track.clips().unwrap()[0];
        let mut command = json!({
            "commandId": id(track_index as u64 + 1),
            "sequenceId": original.state.sequences[0].id,
            "trackId": track.id(), "clipId": clip.id,
        });
        let clips = &mut expected["sequences"][0]["tracks"][track_index]["clips"];
        match operation {
            "speed" => {
                command["type"] = json!("SetClipSpeed");
                command["speed"] = json!({"numerator": 2, "denominator": 1});
                clips[0]["speed"] = command["speed"].clone();
            }
            "gain" => {
                command["type"] = json!("SetClipGain");
                command["gainMilliDecibels"] = json!(-6000);
                clips[0]["gainMilliDecibels"] = json!(-6000);
            }
            "fades" => {
                command["type"] = json!("SetClipFades");
                command["fades"] = json!({"inFrames": 15, "outFrames": 30});
                clips[0]["fades"] = command["fades"].clone();
            }
            "move" => {
                command["type"] = json!("MoveClip");
                command["timelineStart"] = time(clip.timeline_start.value + 5);
                clips[0]["timelineStart"] = command["timelineStart"].clone();
            }
            "delete" => {
                command["type"] = json!("RemoveClip");
                clips.as_array_mut().unwrap().remove(0);
            }
            "source-range" => {
                command["type"] = json!("TrimClip");
                command["sourceIn"] = time(60);
                command["sourceOut"] = time(300);
                clips[0]["sourceIn"] = time(60);
                clips[0]["sourceOut"] = time(300);
            }
            _ => panic!("unknown test operation"),
        }
        commands.push(serde_json::from_value(command).unwrap());
        // Selected source range is a single-target edit, not a bulk UI operation.
        if operation == "source-range" {
            break;
        }
    }
    (commands, serde_json::from_value(expected).unwrap())
}

fn assert_storage_round_trip(operation: &str) {
    let directory = tempdir().unwrap();
    let path = directory.path().join("controls.svpvideo");
    let original = fixture();
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
    let grants = VideoPathGrants::default();
    let (commands, expected) = edits(&original, operation);
    let edit = request(&original, 980, commands.clone());
    let acknowledged = {
        let service = VideoProjectService::default();
        service.open(OWNER, &path, &grants).unwrap();
        let initial_disk = read_snapshot(&path).unwrap();
        let result = service.execute(OWNER, edit.clone(), &grants).unwrap();
        assert_eq!(result.prior_revision.number, 0);
        assert_eq!(result.new_revision.number, 1);
        assert_eq!(result.projection.state, expected);
        assert_eq!(result.state_hash, state_hash(&expected).unwrap());
        assert_eq!(read_snapshot(&path).unwrap(), initial_disk);
        let records = scan(&journal_path(&path).unwrap()).unwrap().records;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].history_group.forward_commands, commands);
        assert_eq!(
            records[0].history_group.inverse_commands.len(),
            commands.len()
        );
        result
    }; // Release without checkpoint: replay the real journal, not a mocked projection.
    let service = VideoProjectService::default();
    let reopened = service.open(OWNER, &path, &grants).unwrap();
    let recovered_snapshot = read_snapshot(&path).unwrap();
    assert_eq!(recovered_snapshot.history.undo_stack.len(), 1);
    assert!(recovered_snapshot.history.redo_stack.is_empty());
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 1);
    assert_eq!(reopened.projection.state, expected);
    assert_eq!(reopened.projection.revision, acknowledged.new_revision);
    assert_eq!(service.execute(OWNER, edit, &grants).unwrap(), acknowledged);
    assert_eq!(read_snapshot(&path).unwrap(), recovered_snapshot);
    let undo = service
        .undo(OWNER, &original.id, 1, &id(20), &grants)
        .unwrap();
    assert_eq!(undo.new_revision.number, 2);
    assert_eq!(undo.projection.state, original.state);
    assert_eq!(undo.state_hash, original.revision.state_hash);
    service.close(OWNER, &original.id).unwrap();
    let saved_undo = read_snapshot(&path).unwrap();
    assert!(saved_undo.history.undo_stack.is_empty());
    assert_eq!(saved_undo.history.redo_stack.len(), 1);
    let service = VideoProjectService::default();
    let reopened = service.open(OWNER, &path, &grants).unwrap();
    assert_eq!(reopened.projection.state, original.state);
    assert_eq!(reopened.projection.revision, undo.new_revision);
    assert!(reopened.projection.can_redo);
    let redo = service
        .redo(OWNER, &original.id, 2, &id(21), &grants)
        .unwrap();
    assert_eq!(redo.new_revision.number, 3);
    assert_eq!(redo.projection.state, expected);
    assert_eq!(redo.state_hash, acknowledged.state_hash);
    service.close(OWNER, &original.id).unwrap();
    let saved_redo = read_snapshot(&path).unwrap();
    assert_eq!(
        saved_redo.history.undo_stack,
        recovered_snapshot.history.undo_stack
    );
    assert!(saved_redo.history.redo_stack.is_empty());
    let service = VideoProjectService::default();
    let reopened = service.open(OWNER, &path, &grants).unwrap();
    assert_eq!(reopened.projection.state, expected);
    assert_eq!(reopened.projection.revision, redo.new_revision);
    service.close(OWNER, &original.id).unwrap();
}

#[test]
fn bulk_speed_real_storage_history_and_recovery() {
    assert_storage_round_trip("speed");
}
#[test]
fn bulk_gain_real_storage_history_and_recovery() {
    assert_storage_round_trip("gain");
}
#[test]
fn bulk_fades_real_storage_history_and_recovery() {
    assert_storage_round_trip("fades");
}
#[test]
fn bulk_move_real_storage_history_and_recovery() {
    assert_storage_round_trip("move");
}
#[test]
fn bulk_delete_real_storage_history_and_recovery() {
    assert_storage_round_trip("delete");
}
#[test]
fn selected_source_range_real_storage_history_and_recovery() {
    assert_storage_round_trip("source-range");
}

#[test]
fn mixed_locked_bulk_groups_leave_no_partial_state_history_or_journal() {
    for operation in ["speed", "gain", "fades", "move", "delete", "source-range"] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("locked.svpvideo");
        let mut value = serde_json::to_value(fixture()).unwrap();
        let locked_index = if operation == "source-range" { 0 } else { 1 };
        value["state"]["sequences"][0]["tracks"][locked_index]["locked"] = json!(true);
        let mut original: VideoProjectSnapshotV2 = serde_json::from_value(value).unwrap();
        original.revision.state_hash = state_hash(&original.state).unwrap();
        fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
        let grants = VideoPathGrants::default();
        let edit = request(&original, 981, edits(&original, operation).0);
        {
            let service = VideoProjectService::default();
            service.open(OWNER, &path, &grants).unwrap();
            let inspector_before = service.inspector(OWNER, &original.id).unwrap();
            let snapshot_before = fs::read(&path).unwrap();
            let journal_before = fs::read(journal_path(&path).unwrap()).unwrap();
            let recovered_before = read_snapshot(&path).unwrap();
            assert!(
                service.execute(OWNER, edit.clone(), &grants).is_err(),
                "{operation}"
            );
            assert_eq!(
                service.inspector(OWNER, &original.id).unwrap(),
                inspector_before
            );
            assert_eq!(fs::read(&path).unwrap(), snapshot_before);
            assert_eq!(
                fs::read(journal_path(&path).unwrap()).unwrap(),
                journal_before
            );
            assert_eq!(read_snapshot(&path).unwrap(), recovered_before);
            assert!(service
                .existing_group_result(OWNER, &edit)
                .unwrap()
                .is_none());
        }
        let service = VideoProjectService::default();
        let reopened = service.open(OWNER, &path, &grants).unwrap();
        assert_eq!(reopened.projection.state, original.state);
        assert_eq!(reopened.projection.revision, original.revision);
        assert!(!reopened.projection.can_undo);
        assert!(!reopened.projection.can_redo);
        service.close(OWNER, &original.id).unwrap();
    }
}
