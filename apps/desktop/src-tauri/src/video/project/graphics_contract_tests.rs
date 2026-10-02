//! Rust side of `packages/video-contracts/fixtures/graphics-commands.json`; the TypeScript side is
//! `packages/video-contracts/src/graphics-commands-contract.test.ts`.

use std::{fs, path::Path};

use serde_json::Value;
use tempfile::tempdir;

use super::{
    commands::apply_group,
    hash::canonical_bytes,
    service::VideoProjectService,
    snapshot::read_snapshot,
    types::{CommandGroupRequest, ProjectCommand, VideoProjectSnapshotV2},
};
use crate::video::VideoPathGrants;

const OWNER: &str = "graphics-contract-test";

fn fixture(name: &str) -> Value {
    serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/video-contracts/fixtures")
                .join(name),
        )
        .unwrap(),
    )
    .unwrap()
}

fn id(value: u64) -> String {
    format!("9d000000-0000-4000-8000-{value:012x}")
}

fn commands(value: &Value) -> Vec<ProjectCommand> {
    serde_json::from_value(value.clone()).unwrap()
}

fn graphics_clips<'a>(contract: &Value, snapshot_state: &'a Value) -> &'a Value {
    let sequence = contract["sequenceIndex"].as_u64().unwrap() as usize;
    let track = contract["trackIndex"].as_u64().unwrap() as usize;
    &snapshot_state["sequences"][sequence]["tracks"][track]["graphicsClips"]
}

#[test]
fn graphics_contract_cases_apply_undo_and_redo_through_the_journaled_history() {
    replay_contract_cases(&fixture("graphics-commands.json"), 0);
}

/// Motion-preset output (`applyMotionPreset` in TypeScript) replays identically in Rust.
#[test]
fn graphics_preset_commands_replay_through_the_journaled_history() {
    replay_contract_cases(&fixture("graphics-preset-commands.json"), 500);
}

fn replay_contract_cases(contract: &Value, id_offset: u64) {
    let base: VideoProjectSnapshotV2 =
        serde_json::from_value(fixture(contract["base"].as_str().unwrap())).unwrap();
    for (case_index, case) in contract["cases"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("graphics.svpvideo");
        fs::write(&path, canonical_bytes(&base).unwrap()).unwrap();
        let grants = VideoPathGrants::default();
        let service = VideoProjectService::default();
        service.open(OWNER, &path, &grants).unwrap();
        let operation = |offset: u64| id(id_offset + case_index as u64 * 10 + offset);

        let applied = service
            .execute(
                OWNER,
                CommandGroupRequest {
                    group_id: operation(1),
                    project_id: base.id.clone(),
                    base_revision: base.revision.number,
                    commands: commands(&case["commands"]),
                },
                &grants,
            )
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        let applied_state = serde_json::to_value(&applied.projection.state).unwrap();
        assert_eq!(
            graphics_clips(contract, &applied_state),
            &case["expectedGraphicsClips"],
            "{name}"
        );

        let undone = service
            .undo(
                OWNER,
                &base.id,
                applied.new_revision.number,
                &operation(2),
                &grants,
            )
            .unwrap();
        assert_eq!(undone.projection.state, base.state, "{name}: undo");
        assert_eq!(
            canonical_bytes(&undone.projection.state).unwrap(),
            canonical_bytes(&base.state).unwrap(),
            "{name}: undo bytes"
        );

        let redone = service
            .redo(
                OWNER,
                &base.id,
                undone.new_revision.number,
                &operation(3),
                &grants,
            )
            .unwrap();
        assert_eq!(
            redone.projection.state, applied.projection.state,
            "{name}: redo"
        );

        // The journal replays to the same state after an unclean drop.
        drop(service);
        let reopened = VideoProjectService::default();
        let open = reopened.open(OWNER, &path, &grants).unwrap();
        assert_eq!(
            open.projection.state, applied.projection.state,
            "{name}: replay"
        );
        assert!(open.projection.can_undo, "{name}: replay keeps history");
        reopened.close(OWNER, &base.id).unwrap();
        assert_eq!(
            read_snapshot(&path).unwrap().state,
            applied.projection.state,
            "{name}: checkpoint"
        );
    }
}

#[test]
fn graphics_contract_invalid_groups_fail_with_the_shared_category() {
    let contract = fixture("graphics-commands.json");
    let base: VideoProjectSnapshotV2 =
        serde_json::from_value(fixture(contract["base"].as_str().unwrap())).unwrap();
    for case in contract["invalid"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut state = base.state.clone();
        if case["lockTrack"].as_bool() == Some(true) {
            let track = contract["trackIndex"].as_u64().unwrap() as usize;
            state.sequences[0].tracks[track].set_locked(true);
        }
        let error = apply_group(&state, &commands(&case["commands"])).unwrap_err();
        assert_eq!(
            serde_json::to_value(error.code).unwrap(),
            case["code"],
            "{name}"
        );
        assert_eq!(error.details["category"], case["category"], "{name}");
    }
}

#[test]
fn graphics_contract_invalid_wire_commands_never_execute() {
    let contract = fixture("graphics-commands.json");
    let base: VideoProjectSnapshotV2 =
        serde_json::from_value(fixture(contract["base"].as_str().unwrap())).unwrap();
    for case in contract["invalidWire"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        // Either the strict wire types refuse it, or the executor's shape checks do.
        if let Ok(command) = serde_json::from_value::<ProjectCommand>(case["command"].clone()) {
            assert!(
                apply_group(&base.state, &[command]).is_err(),
                "{name} must be rejected"
            );
        }
    }
}
