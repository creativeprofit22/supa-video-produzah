use std::{
    fs,
    io::Write,
    path::Path,
    time::{Duration, Instant},
};

use proptest::prelude::*;
use serde::Deserialize;
use serde_json::Value;

use super::{
    commands::apply_group,
    hash::{canonical_bytes, canonical_hash, state_hash},
    history::{commit_transition, redo_transition, undo_transition},
    integrity::{validate_snapshot, validate_state},
    journal::{
        acquire_project_lock, initialize_journal, journal_path, scan, sidecar_path,
        with_record_hash, TailClassification,
    },
    migration::migrate_v1_bytes,
    recovery::{create_journal_for_snapshot, recover},
    service::{ProjectInitializationFailpoint, VideoProjectService},
    snapshot::{checkpoint, checkpoint_with_failpoint, read_snapshot, CheckpointFailpoint},
    types::{
        AffectedRange, CacheInvalidation, ClipSource, ClipTransform, CommandGroupRequest,
        JournalHeader, JournalRecord, JournalRecordKind, ProjectCaption, ProjectClip,
        ProjectCommand, ProjectHistoryEntryV2, ProjectMarker, ProjectTrack, RecoveryStatus,
        TrackMuteError, TrackVisibilityError, VideoProjectSnapshotV2, VideoProjectStateV2,
    },
};
use crate::video::{
    grants::GrantCategory,
    project_io::VideoSourceStatus,
    types::{AssetLocator, MediaContentAlgorithm, MediaContentIdentityV1, RationalTime},
};

#[test]
fn canonical_json_hash_is_stable_across_key_order() {
    let left = serde_json::json!({"z": 1, "a": {"y": true, "x": null}});
    let right = serde_json::json!({"a": {"x": null, "y": true}, "z": 1});
    assert_eq!(
        canonical_hash(&left).unwrap(),
        canonical_hash(&right).unwrap()
    );
}

#[derive(Deserialize)]
struct Manifest {
    cases: Vec<ManifestCase>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCase {
    name: String,
    path: String,
    expected: String,
    #[serde(default)]
    mutations: Vec<ManifestMutation>,
    #[serde(default)]
    rehash_state: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestMutation {
    pointer: String,
    value: Option<Value>,
    repeat_string: Option<RepeatedString>,
    repeat_array: Option<RepeatedValue>,
}

#[derive(Deserialize)]
struct RepeatedString {
    value: String,
    count: usize,
}

#[derive(Deserialize)]
struct RepeatedValue {
    value: Value,
    count: usize,
}

fn apply_manifest_mutation(input: &mut Value, mutation: ManifestMutation) {
    let replacement = if let Some(repeated) = mutation.repeat_string {
        Value::String(repeated.value.repeat(repeated.count))
    } else if let Some(repeated) = mutation.repeat_array {
        Value::Array(vec![repeated.value; repeated.count])
    } else {
        mutation.value.unwrap()
    };
    let (parent_pointer, encoded_key) = mutation.pointer.rsplit_once('/').unwrap();
    let key = encoded_key.replace("~1", "/").replace("~0", "~");
    let parent = input.pointer_mut(parent_pointer).unwrap();
    match parent {
        Value::Array(values) if key == "-" => values.push(replacement),
        Value::Array(values) => values[key.parse::<usize>().unwrap()] = replacement,
        Value::Object(values) => {
            values.insert(key, replacement);
        }
        _ => panic!("mutation parent must be an array or object"),
    }
}

#[test]
fn shared_v2_fixture_shape_and_integrity_parity() {
    let fixture_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures/project-v2");
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(fixture_dir.join("manifest.json")).unwrap()).unwrap();
    for fixture in manifest.cases {
        if fixture.expected == "unsupported_schema" {
            continue;
        }
        let mut input: Value =
            serde_json::from_slice(&fs::read(fixture_dir.join(&fixture.path)).unwrap()).unwrap();
        for mutation in fixture.mutations {
            apply_manifest_mutation(&mut input, mutation);
        }
        let result = serde_json::from_value::<VideoProjectSnapshotV2>(input)
            .map_err(|_| ())
            .and_then(|mut snapshot| {
                if fixture.rehash_state {
                    snapshot.revision.state_hash = state_hash(&snapshot.state).map_err(|_| ())?;
                }
                validate_snapshot(&snapshot).map_err(|_| ())
            });
        assert_eq!(
            result.is_ok(),
            fixture.expected == "valid",
            "{}",
            fixture.name
        );
    }
}
#[test]
fn relink_asset_command_serde_matches_shared_optional_non_null_contract() {
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
    let asset = &snapshot.state.assets[0];
    let command = serde_json::json!({
        "type": "RelinkAsset",
        "commandId": "7a000000-0000-4000-8000-000000000001",
        "assetId": asset.id.as_str(),
        "locator": asset.locator,
        "probe": asset.probe,
    });

    let omitted: ProjectCommand = serde_json::from_value(command.clone()).unwrap();
    let ProjectCommand::RelinkAsset {
        content_identity, ..
    } = omitted
    else {
        unreachable!();
    };
    assert_eq!(content_identity, None);

    let identity = MediaContentIdentityV1 {
        schema_version: 1,
        algorithm: MediaContentAlgorithm::Sha256,
        digest: "42".repeat(32),
        byte_length: 17,
    };
    let mut valid = command.clone();
    valid["contentIdentity"] = serde_json::to_value(&identity).unwrap();
    let decoded: ProjectCommand = serde_json::from_value(valid).unwrap();
    let ProjectCommand::RelinkAsset {
        content_identity, ..
    } = decoded
    else {
        unreachable!();
    };
    assert_eq!(content_identity, Some(identity));

    let mut explicit_null = command.clone();
    explicit_null["contentIdentity"] = Value::Null;
    assert!(serde_json::from_value::<ProjectCommand>(explicit_null).is_err());

    let mut unknown_field = command;
    unknown_field["unexpected"] = Value::Bool(true);
    assert!(serde_json::from_value::<ProjectCommand>(unknown_field).is_err());
}

#[test]
fn over_limit_sequence_name_is_rejected_without_leaking_a_locked_session() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("over-limit-name.svpvideo");
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let mut snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
    snapshot.state.sequences[0].name = "x".repeat(600);
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();

    let service = VideoProjectService::default();
    let grants = crate::video::VideoPathGrants::default();
    for _ in 0..2 {
        let error = service
            .open("invalid-owner", &project_path, &grants)
            .unwrap_err();
        assert_eq!(
            error.code,
            crate::video::error::VideoErrorCode::InvalidProject
        );
    }
}

#[test]
fn active_locked_project_relinks_a_missing_source_without_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("missing-source.svpvideo");
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    fs::copy(fixture_path, &project_path).unwrap();

    let owner = "missing-source-owner";
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service.open(owner, &project_path, &grants).unwrap();
    assert_eq!(
        opened.projection.sources[0].status,
        VideoSourceStatus::Missing
    );

    let competing_service = VideoProjectService::default();
    let lock_error = competing_service
        .open("competing-owner", &project_path, &grants)
        .unwrap_err();
    assert_eq!(
        lock_error.code,
        crate::video::error::VideoErrorCode::ProjectInUse
    );

    let replacement_path = directory.path().join("replacement.mp4");
    fs::write(&replacement_path, b"replacement media").unwrap();
    let canonical_replacement = grants
        .grant_existing_file(owner, GrantCategory::Source, &replacement_path)
        .unwrap();
    let asset = &opened.projection.state.assets[0];
    let content_identity = MediaContentIdentityV1 {
        schema_version: 1,
        algorithm: MediaContentAlgorithm::Sha256,
        digest: "42".repeat(32),
        byte_length: 17,
    };
    let result = service
        .relink(
            owner,
            &opened.projection.project_id,
            asset.id.as_str(),
            AssetLocator {
                relative_path: None,
                absolute_path: Some(canonical_replacement.to_str().unwrap().to_owned()),
            },
            asset.probe.clone(),
            Some(content_identity.clone()),
            &grants,
        )
        .unwrap();

    assert_eq!(result.prior_revision.number, 0);
    assert_eq!(result.new_revision.number, 1);
    assert_eq!(
        result.projection.sources[0].status,
        VideoSourceStatus::Resolved
    );
    assert_eq!(
        result.projection.sources[0].resolved_path.as_deref(),
        canonical_replacement.to_str()
    );
    assert_eq!(
        result.projection.state.assets[0]
            .locator
            .absolute_path
            .as_deref(),
        canonical_replacement.to_str()
    );
    assert_eq!(
        result.projection.state.assets[0].content_identity,
        Some(content_identity.clone())
    );

    let undone = service
        .undo(
            owner,
            &opened.projection.project_id,
            result.new_revision.number,
            "7b000000-0000-4000-8000-000000000001",
            &grants,
        )
        .expect("relink undo must succeed");
    assert_eq!(undone.projection.state.assets[0].content_identity, None);
    let redone = service
        .redo(
            owner,
            &opened.projection.project_id,
            undone.new_revision.number,
            "7b000000-0000-4000-8000-000000000002",
            &grants,
        )
        .expect("relink redo must succeed");
    assert_eq!(
        redone.projection.state.assets[0].content_identity,
        Some(content_identity.clone())
    );
    service
        .close(owner, &opened.projection.project_id)
        .expect("relinked project must close");
    let reopened = service
        .open(owner, &project_path, &grants)
        .expect("relinked project must replay and reopen");
    assert_eq!(
        reopened.projection.state.assets[0].content_identity,
        Some(content_identity)
    );
}
#[test]
fn fixture_state_hashes_are_deterministic() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures/project-v2/valid-minimal.svpvideo");
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    validate_state(&snapshot.state).unwrap();
    assert_eq!(
        state_hash(&snapshot.state).unwrap(),
        state_hash(&snapshot.state).unwrap()
    );
}

#[test]
fn track_mute_serde_defaults_omit_false_and_rejects_caption_targets() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let bytes = fs::read(fixture).unwrap();
    let legacy_json: Value = serde_json::from_slice(&bytes).unwrap();
    let snapshot: VideoProjectSnapshotV2 = serde_json::from_slice(&bytes).unwrap();
    let mut track = snapshot.state.sequences[0].tracks[0].clone();

    assert!(!track.is_locked());
    assert_eq!(track.is_muted(), Ok(false));
    assert_eq!(
        state_hash(&snapshot.state).unwrap(),
        snapshot.revision.state_hash
    );
    assert_eq!(serde_json::to_value(&snapshot).unwrap(), legacy_json);

    assert_eq!(track.is_hidden(), Ok(false));
    assert!(serde_json::to_value(&track)
        .unwrap()
        .get("hidden")
        .is_none());
    assert_eq!(track.set_hidden(true), Ok(false));
    assert_eq!(track.is_hidden(), Ok(true));
    assert_eq!(serde_json::to_value(&track).unwrap()["hidden"], true);
    assert_eq!(track.set_hidden(false), Ok(true));
    assert!(serde_json::to_value(&track)
        .unwrap()
        .get("hidden")
        .is_none());

    assert_eq!(track.set_muted(true), Ok(false));
    assert_eq!(track.is_muted(), Ok(true));
    assert_eq!(serde_json::to_value(&track).unwrap()["muted"], true);
    assert_eq!(track.set_muted(false), Ok(true));
    assert!(serde_json::to_value(&track).unwrap().get("muted").is_none());

    let mut caption = ProjectTrack::Caption {
        id: "75000000-0000-4000-8000-000000000001".to_owned(),
        name: "Captions".to_owned(),
        locked: false,
        hidden: false,
        captions: vec![],
    };
    assert_eq!(caption.is_muted(), Err(TrackMuteError::InvalidTarget));
    assert_eq!(caption.set_muted(true), Err(TrackMuteError::InvalidTarget));
    assert_eq!(caption.is_hidden(), Ok(false));
    assert_eq!(caption.set_hidden(true), Ok(false));
    assert_eq!(caption.is_hidden(), Ok(true));
    assert!(serde_json::to_value(&caption)
        .unwrap()
        .get("muted")
        .is_none());
}

const MIXED_RATE_ASSET_ID: &str = "12000000-0000-4000-8000-000000000005";
const MIXED_RATE_SEQUENCE_ID: &str = "12000000-0000-4000-8000-000000000006";
const MIXED_RATE_TRACK_ID: &str = "12000000-0000-4000-8000-000000000007";
const MIXED_RATE_LEFT_CLIP_ID: &str = "12000000-0000-4000-8000-000000000008";
const MIXED_RATE_RIGHT_CLIP_ID: &str = "12000000-0000-4000-8000-000000000009";
const MIXED_RATE_BASE_HASH: &str =
    "1b6e20320f9bee0a3a2d0d7ce74562b748c2b39b1c4a609fc6c70f13ea97bccd";
const MIXED_RATE_EDITED_HASH: &str =
    "5632b4b19286ccf8f05b237f09181945f78a013f3ded8be72a3e9702dec2f021";

fn mixed_rate_fixture_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures/project-v2/valid-mixed-rate.svpvideo")
}

fn mixed_rate_fixture() -> VideoProjectSnapshotV2 {
    serde_json::from_slice(&fs::read(mixed_rate_fixture_path()).unwrap()).unwrap()
}

fn source_time(value: u64) -> RationalTime {
    RationalTime {
        value,
        rate_numerator: 24_000,
        rate_denominator: 1_001,
    }
}

fn timeline_time(value: u64) -> RationalTime {
    RationalTime {
        value,
        rate_numerator: 30_000,
        rate_denominator: 1_001,
    }
}

fn mixed_rate_commands() -> Vec<ProjectCommand> {
    vec![
        ProjectCommand::InsertClip {
            command_id: "13000000-0000-4000-8000-000000000001".to_owned(),
            sequence_id: MIXED_RATE_SEQUENCE_ID.to_owned(),
            track_id: MIXED_RATE_TRACK_ID.to_owned(),
            index: None,
            clip: ProjectClip {
                id: MIXED_RATE_LEFT_CLIP_ID.to_owned(),
                source: ClipSource::Asset {
                    asset_id: MIXED_RATE_ASSET_ID.to_owned(),
                },
                timeline_start: timeline_time(10),
                source_in: source_time(4),
                source_out: source_time(20),
                transform: ClipTransform::default(),
                gain_milli_decibels: 0,
            },
        },
        ProjectCommand::SplitClip {
            command_id: "13000000-0000-4000-8000-000000000002".to_owned(),
            sequence_id: MIXED_RATE_SEQUENCE_ID.to_owned(),
            track_id: MIXED_RATE_TRACK_ID.to_owned(),
            clip_id: MIXED_RATE_LEFT_CLIP_ID.to_owned(),
            split_at: source_time(12),
            right_clip_id: MIXED_RATE_RIGHT_CLIP_ID.to_owned(),
        },
        ProjectCommand::MoveClip {
            command_id: "13000000-0000-4000-8000-000000000003".to_owned(),
            sequence_id: MIXED_RATE_SEQUENCE_ID.to_owned(),
            track_id: MIXED_RATE_TRACK_ID.to_owned(),
            clip_id: MIXED_RATE_RIGHT_CLIP_ID.to_owned(),
            timeline_start: timeline_time(40),
        },
        ProjectCommand::TrimClip {
            command_id: "13000000-0000-4000-8000-000000000004".to_owned(),
            sequence_id: MIXED_RATE_SEQUENCE_ID.to_owned(),
            track_id: MIXED_RATE_TRACK_ID.to_owned(),
            clip_id: MIXED_RATE_RIGHT_CLIP_ID.to_owned(),
            source_in: source_time(12),
            source_out: source_time(28),
        },
    ]
}

fn mixed_range(start: u64, end: u64) -> AffectedRange {
    AffectedRange {
        sequence_id: MIXED_RATE_SEQUENCE_ID.to_owned(),
        start: timeline_time(start),
        end: timeline_time(end),
    }
}

#[test]
fn mixed_rate_insert_split_move_and_trim_rescale_exact_affected_ranges() {
    let snapshot = mixed_rate_fixture();
    let commands = mixed_rate_commands();
    let applied = apply_group(&snapshot.state, &commands).unwrap();

    let ProjectTrack::Video { clips, .. } = &applied.state.sequences[0].tracks[0] else {
        panic!("expected video track");
    };
    assert_eq!(clips.len(), 2);
    assert_eq!(clips[0].source_in, source_time(4));
    assert_eq!(clips[0].source_out, source_time(12));
    assert_eq!(clips[0].timeline_start, timeline_time(10));
    assert_eq!(clips[1].source_in, source_time(12));
    assert_eq!(clips[1].source_out, source_time(28));
    assert_eq!(clips[1].timeline_start, timeline_time(40));
    assert_eq!(
        applied.affected_ranges,
        vec![
            mixed_range(10, 30),
            mixed_range(10, 30),
            mixed_range(20, 30),
            mixed_range(40, 50),
            mixed_range(40, 50),
            mixed_range(40, 60),
        ]
    );
    assert_eq!(state_hash(&applied.state).unwrap(), MIXED_RATE_EDITED_HASH);

    let repeated = apply_group(&snapshot.state, &commands).unwrap();
    assert_eq!(state_hash(&repeated.state).unwrap(), MIXED_RATE_EDITED_HASH);
    let restored = apply_group(&applied.state, &applied.inverse_commands).unwrap();
    assert_eq!(restored.state, snapshot.state);
    assert_eq!(state_hash(&restored.state).unwrap(), MIXED_RATE_BASE_HASH);
}

#[test]
fn mixed_rate_overlap_validation_uses_timeline_duration() {
    let mut state = mixed_rate_fixture().state;
    let ProjectCommand::InsertClip { clip: first, .. } = mixed_rate_commands().remove(0) else {
        unreachable!();
    };
    let mut second = first.clone();
    second.id = "12000000-0000-4000-8000-000000000099".to_owned();
    second.timeline_start = timeline_time(28);
    second.source_in = source_time(0);
    second.source_out = source_time(8);
    let ProjectTrack::Video { clips, .. } = &mut state.sequences[0].tracks[0] else {
        unreachable!();
    };
    *clips = vec![first, second.clone()];
    assert!(validate_state(&state).is_err());

    second.timeline_start = timeline_time(30);
    let ProjectTrack::Video { clips, .. } = &mut state.sequences[0].tracks[0] else {
        unreachable!();
    };
    clips[1] = second;
    validate_state(&state).unwrap();
}

#[test]
fn mixed_rate_commands_reject_fractional_timeline_frames() {
    let snapshot = mixed_rate_fixture();
    let mut inexact_insert = mixed_rate_commands().remove(0);
    let ProjectCommand::InsertClip { clip, .. } = &mut inexact_insert else {
        unreachable!();
    };
    clip.source_out = source_time(6);
    assert!(apply_group(&snapshot.state, &[inexact_insert]).is_err());

    let inserted = apply_group(&snapshot.state, &[mixed_rate_commands().remove(0)]).unwrap();
    let inexact_split = ProjectCommand::SplitClip {
        command_id: "13000000-0000-4000-8000-000000000010".to_owned(),
        sequence_id: MIXED_RATE_SEQUENCE_ID.to_owned(),
        track_id: MIXED_RATE_TRACK_ID.to_owned(),
        clip_id: MIXED_RATE_LEFT_CLIP_ID.to_owned(),
        split_at: source_time(10),
        right_clip_id: "12000000-0000-4000-8000-000000000010".to_owned(),
    };
    assert!(apply_group(&inserted.state, &[inexact_split]).is_err());
}

#[test]
fn mixed_rate_undo_and_journal_replay_preserve_exact_state_hashes() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("mixed-rate.svpvideo");
    fs::copy(mixed_rate_fixture_path(), &project_path).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service.open("mixed-owner", &project_path, &grants).unwrap();
    assert_eq!(opened.projection.revision.state_hash, MIXED_RATE_BASE_HASH);

    let committed = service
        .execute(
            "mixed-owner",
            CommandGroupRequest {
                group_id: "14000000-0000-4000-8000-000000000001".to_owned(),
                project_id: opened.projection.project_id.clone(),
                base_revision: 0,
                commands: mixed_rate_commands(),
            },
            &grants,
        )
        .unwrap();
    assert_eq!(committed.state_hash, MIXED_RATE_EDITED_HASH);
    let undone = service
        .undo(
            "mixed-owner",
            &opened.projection.project_id,
            1,
            "14000000-0000-4000-8000-000000000002",
            &grants,
        )
        .unwrap();
    assert_eq!(undone.state_hash, MIXED_RATE_BASE_HASH);
    let redone = service
        .redo(
            "mixed-owner",
            &opened.projection.project_id,
            2,
            "14000000-0000-4000-8000-000000000003",
            &grants,
        )
        .unwrap();
    assert_eq!(redone.state_hash, MIXED_RATE_EDITED_HASH);
    drop(service);

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("replay-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.replayed_record_count, 3);
    assert_eq!(reopened.projection.revision.number, 3);
    assert_eq!(
        reopened.projection.revision.state_hash,
        MIXED_RATE_EDITED_HASH
    );
    assert_eq!(
        state_hash(&reopened.projection.state).unwrap(),
        MIXED_RATE_EDITED_HASH
    );
}

#[test]
fn service_split_move_trim_groups_persist_and_recover_exact_history() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("split-move-trim.svpvideo");
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    fs::copy(&fixture_path, &project_path).unwrap();

    let fixture: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(&fixture_path).unwrap()).unwrap();
    let base_state = fixture.state;
    let base_hash = state_hash(&base_state).unwrap();
    let split = ProjectCommand::SplitClip {
        command_id: "15000000-0000-4000-8000-000000000001".to_owned(),
        sequence_id: "10000000-0000-4000-8000-000000000006".to_owned(),
        track_id: "10000000-0000-4000-8000-000000000007".to_owned(),
        clip_id: "10000000-0000-4000-8000-000000000008".to_owned(),
        split_at: RationalTime {
            value: 10,
            rate_numerator: 30,
            rate_denominator: 1,
        },
        right_clip_id: "15000000-0000-4000-8000-000000000002".to_owned(),
    };
    let moved = ProjectCommand::MoveClip {
        command_id: "15000000-0000-4000-8000-000000000003".to_owned(),
        sequence_id: "10000000-0000-4000-8000-000000000006".to_owned(),
        track_id: "10000000-0000-4000-8000-000000000007".to_owned(),
        clip_id: "15000000-0000-4000-8000-000000000002".to_owned(),
        timeline_start: RationalTime {
            value: 40,
            rate_numerator: 30,
            rate_denominator: 1,
        },
    };
    let trimmed = ProjectCommand::TrimClip {
        command_id: "15000000-0000-4000-8000-000000000004".to_owned(),
        sequence_id: "10000000-0000-4000-8000-000000000006".to_owned(),
        track_id: "10000000-0000-4000-8000-000000000007".to_owned(),
        clip_id: "15000000-0000-4000-8000-000000000002".to_owned(),
        source_in: RationalTime {
            value: 12,
            rate_numerator: 30,
            rate_denominator: 1,
        },
        source_out: RationalTime {
            value: 25,
            rate_numerator: 30,
            rate_denominator: 1,
        },
    };

    let split_state = apply_group(&base_state, std::slice::from_ref(&split))
        .unwrap()
        .state;
    let split_hash = state_hash(&split_state).unwrap();
    let moved_state = apply_group(&split_state, std::slice::from_ref(&moved))
        .unwrap()
        .state;
    let moved_hash = state_hash(&moved_state).unwrap();
    let trimmed_state = apply_group(&moved_state, std::slice::from_ref(&trimmed))
        .unwrap()
        .state;
    let trimmed_hash = state_hash(&trimmed_state).unwrap();

    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("persistence-owner", &project_path, &grants)
        .unwrap();
    let project_id = opened.projection.project_id;

    let groups = [
        (
            "15000000-0000-4000-8000-000000000011",
            split,
            "Split clip",
            &split_state,
            &split_hash,
        ),
        (
            "15000000-0000-4000-8000-000000000012",
            moved,
            "Moved clip",
            &moved_state,
            &moved_hash,
        ),
        (
            "15000000-0000-4000-8000-000000000013",
            trimmed,
            "Applied trim",
            &trimmed_state,
            &trimmed_hash,
        ),
    ];
    for (index, (group_id, command, summary, expected_state, expected_hash)) in
        groups.into_iter().enumerate()
    {
        let result = service
            .execute(
                "persistence-owner",
                CommandGroupRequest {
                    group_id: group_id.to_owned(),
                    project_id: project_id.clone(),
                    base_revision: index as u64,
                    commands: vec![command],
                },
                &grants,
            )
            .unwrap();
        assert_eq!(result.prior_revision.number, index as u64);
        assert_eq!(result.new_revision.number, index as u64 + 1);
        assert_eq!(result.projection.state, *expected_state);
        assert_eq!(result.state_hash, *expected_hash);
        assert_eq!(result.new_revision.state_hash, *expected_hash);
        assert_eq!(
            result.projection.last_command.as_ref().unwrap().summary,
            summary
        );
    }

    service.close("persistence-owner", &project_id).unwrap();
    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("recovery-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.projection.revision.number, 3);
    assert_eq!(reopened.projection.state, trimmed_state);
    assert_eq!(reopened.projection.revision.state_hash, trimmed_hash);
    assert_eq!(
        state_hash(&reopened.projection.state).unwrap(),
        trimmed_hash
    );

    let undo_expectations = [
        ("Applied trim", &moved_state, &moved_hash),
        ("Moved clip", &split_state, &split_hash),
        ("Split clip", &base_state, &base_hash),
    ];
    for (index, (originating_summary, expected_state, expected_hash)) in
        undo_expectations.into_iter().enumerate()
    {
        let base_revision = 3 + index as u64;
        let result = reopened_service
            .undo(
                "recovery-owner",
                &project_id,
                base_revision,
                &format!("15000000-0000-4000-8000-00000000002{}", index + 1),
                &grants,
            )
            .unwrap();
        assert_eq!(result.prior_revision.number, base_revision);
        assert_eq!(result.new_revision.number, base_revision + 1);
        assert_eq!(result.projection.state, *expected_state);
        assert_eq!(result.state_hash, *expected_hash);
        assert_eq!(result.new_revision.state_hash, *expected_hash);
        assert_eq!(
            result.projection.last_command.as_ref().unwrap().summary,
            format!("Undid {originating_summary}")
        );
    }

    let redo_expectations = [
        ("Split clip", &split_state, &split_hash),
        ("Moved clip", &moved_state, &moved_hash),
        ("Applied trim", &trimmed_state, &trimmed_hash),
    ];
    for (index, (originating_summary, expected_state, expected_hash)) in
        redo_expectations.into_iter().enumerate()
    {
        let base_revision = 6 + index as u64;
        let result = reopened_service
            .redo(
                "recovery-owner",
                &project_id,
                base_revision,
                &format!("15000000-0000-4000-8000-00000000003{}", index + 1),
                &grants,
            )
            .unwrap();
        assert_eq!(result.prior_revision.number, base_revision);
        assert_eq!(result.new_revision.number, base_revision + 1);
        assert_eq!(result.projection.state, *expected_state);
        assert_eq!(result.state_hash, *expected_hash);
        assert_eq!(result.new_revision.state_hash, *expected_hash);
        assert_eq!(
            result.projection.last_command.as_ref().unwrap().summary,
            format!("Redid {originating_summary}")
        );
    }
}

proptest! {
    #[test]
    fn arbitrary_valid_trim_inverse_round_trips(start in 0_u64..30, length in 1_u64..=30) {
        let end = (start + length).min(30);
        prop_assume!(end > start);
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo");
        let snapshot: VideoProjectSnapshotV2 = serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
        let command = ProjectCommand::TrimClip {
            command_id: "30000000-0000-4000-8000-000000000009".to_owned(),
            sequence_id: "10000000-0000-4000-8000-000000000006".to_owned(),
            track_id: "10000000-0000-4000-8000-000000000007".to_owned(),
            clip_id: "10000000-0000-4000-8000-000000000008".to_owned(),
            source_in: RationalTime { value: start, rate_numerator: 30, rate_denominator: 1 },
            source_out: RationalTime { value: end, rate_numerator: 30, rate_denominator: 1 },
        };
        let applied = apply_group(&snapshot.state, &[command]).unwrap();
        let restored = apply_group(&applied.state, &applied.inverse_commands).unwrap();
        prop_assert_eq!(restored.state, snapshot.state);
    }
}

fn indexed_removal_fixture() -> VideoProjectStateV2 {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    let mut state = snapshot.state;

    let original_asset = state.assets.remove(0);
    let mut spare_assets = Vec::new();
    for suffix in 101..=103 {
        let mut asset = original_asset.clone();
        asset.id = serde_json::from_value(serde_json::Value::String(format!(
            "90000000-0000-4000-8000-{suffix:012}"
        )))
        .unwrap();
        asset.display_name = format!("spare-{suffix}.mp4");
        spare_assets.push(asset);
    }
    state.assets = vec![
        spare_assets[0].clone(),
        original_asset,
        spare_assets[1].clone(),
        spare_assets[2].clone(),
    ];

    let mut original_sequence = state.sequences.remove(0);
    original_sequence.markers = (301..=303)
        .map(|suffix| ProjectMarker {
            id: format!("90000000-0000-4000-8000-{suffix:012}"),
            time: RationalTime {
                value: 5,
                rate_numerator: 30,
                rate_denominator: 1,
            },
            label: format!("Marker {suffix}"),
            color: None,
        })
        .collect();

    let ProjectTrack::Video { clips, .. } = &mut original_sequence.tracks[0] else {
        unreachable!();
    };
    let clip_template = clips[0].clone();
    *clips = (401..=403)
        .enumerate()
        .map(|(index, suffix)| {
            let mut clip = clip_template.clone();
            clip.id = format!("90000000-0000-4000-8000-{suffix:012}");
            clip.timeline_start.value = (index as u64) * 2;
            clip.source_in.value = 0;
            clip.source_out.value = 1;
            clip
        })
        .collect();

    let captions = (601..=603)
        .map(|suffix| ProjectCaption {
            id: format!("90000000-0000-4000-8000-{suffix:012}"),
            start: RationalTime {
                value: 10,
                rate_numerator: 30,
                rate_denominator: 1,
            },
            end: RationalTime {
                value: 12,
                rate_numerator: 30,
                rate_denominator: 1,
            },
            text: format!("Caption {suffix}"),
            language: None,
        })
        .collect();
    original_sequence.tracks.insert(
        1,
        ProjectTrack::Caption {
            id: "90000000-0000-4000-8000-000000000501".to_owned(),
            name: "Captions".to_owned(),
            locked: false,
            hidden: false,
            captions,
        },
    );
    original_sequence.tracks.push(ProjectTrack::Audio {
        id: "90000000-0000-4000-8000-000000000502".to_owned(),
        name: "Audio".to_owned(),
        locked: false,
        muted: false,
        clips: vec![],
    });

    let mut first_sequence = original_sequence.clone();
    first_sequence.id = "90000000-0000-4000-8000-000000000201".to_owned();
    first_sequence.name = "First empty sequence".to_owned();
    first_sequence.tracks.clear();
    first_sequence.markers.clear();
    let mut last_sequence = first_sequence.clone();
    last_sequence.id = "90000000-0000-4000-8000-000000000202".to_owned();
    last_sequence.name = "Last empty sequence".to_owned();
    state.active_sequence_id = Some(last_sequence.id.clone());
    state.sequences = vec![first_sequence, original_sequence, last_sequence];
    validate_state(&state).unwrap();
    state
}

fn removal_command(
    state: &VideoProjectStateV2,
    collection: usize,
    raw_index: usize,
) -> ProjectCommand {
    let sequence = &state.sequences[1];
    let command_id = format!("80000000-0000-4000-8000-{:012}", collection + 1);
    match collection {
        0 => {
            let index = [0, 2, 3][raw_index % 3];
            ProjectCommand::RemoveAsset {
                command_id,
                asset_id: state.assets[index].id.as_str().to_owned(),
            }
        }
        1 => {
            let index = raw_index % state.sequences.len();
            ProjectCommand::RemoveSequence {
                command_id,
                sequence_id: state.sequences[index].id.clone(),
                active_sequence_id: None,
            }
        }
        2 => {
            let index = raw_index % sequence.markers.len();
            ProjectCommand::RemoveMarker {
                command_id,
                sequence_id: sequence.id.clone(),
                marker_id: sequence.markers[index].id.clone(),
            }
        }
        3 => {
            let ProjectTrack::Caption { id, captions, .. } = &sequence.tracks[1] else {
                unreachable!();
            };
            let index = raw_index % captions.len();
            ProjectCommand::RemoveCaption {
                command_id,
                sequence_id: sequence.id.clone(),
                track_id: id.clone(),
                caption_id: captions[index].id.clone(),
            }
        }
        4 => {
            let index = raw_index % sequence.tracks.len();
            ProjectCommand::RemoveTrack {
                command_id,
                sequence_id: sequence.id.clone(),
                track_id: sequence.tracks[index].id().to_owned(),
            }
        }
        5 => {
            let ProjectTrack::Video { id, clips, .. } = &sequence.tracks[0] else {
                unreachable!();
            };
            let index = raw_index % clips.len();
            ProjectCommand::RemoveClip {
                command_id,
                sequence_id: sequence.id.clone(),
                track_id: id.clone(),
                clip_id: clips[index].id.clone(),
            }
        }
        _ => unreachable!(),
    }
}

#[test]
fn removal_inverses_restore_exact_indexes_and_active_sequence() {
    for collection in 0..6 {
        let mut state = indexed_removal_fixture();
        let command = removal_command(&state, collection, 1);
        if let ProjectCommand::RemoveSequence { sequence_id, .. } = &command {
            state.active_sequence_id = Some(sequence_id.clone());
        }
        let applied = apply_group(&state, &[command]).unwrap();
        let encoded_inverses = serde_json::to_value(&applied.inverse_commands).unwrap();
        let inverse = &encoded_inverses[0];
        let expected_index = if collection == 0 { 2 } else { 1 };
        assert_eq!(
            inverse.get("index").and_then(|value| value.as_u64()),
            Some(expected_index)
        );
        if collection == 1 {
            assert_eq!(
                inverse
                    .get("activeSequenceId")
                    .and_then(|value| value.as_str()),
                state.active_sequence_id.as_deref()
            );
        }
        let decoded_inverses: Vec<ProjectCommand> =
            serde_json::from_value(encoded_inverses).unwrap();
        let restored = apply_group(&applied.state, &decoded_inverses).unwrap();
        assert_eq!(restored.state, state, "collection {collection}");
    }
}

#[test]
fn create_sequence_inverse_restores_the_prior_active_sequence() {
    let state = indexed_removal_fixture();
    let prior_active_sequence_id = state.active_sequence_id.clone();
    let mut sequence = state.sequences[0].clone();
    sequence.id = "90000000-0000-4000-8000-000000000299".to_owned();
    sequence.name = "New active sequence".to_owned();
    let applied = apply_group(
        &state,
        &[ProjectCommand::CreateSequence {
            command_id: "80000000-0000-4000-8000-000000000099".to_owned(),
            index: None,
            active_sequence_id: Some(sequence.id.clone()),
            sequence,
        }],
    )
    .unwrap();
    let ProjectCommand::RemoveSequence {
        active_sequence_id, ..
    } = &applied.inverse_commands[0]
    else {
        panic!("create inverse must remove the new sequence");
    };
    assert_eq!(active_sequence_id, &prior_active_sequence_id);
    let restored = apply_group(&applied.state, &applied.inverse_commands).unwrap();
    assert_eq!(restored.state, state);
}

proptest! {
    #[test]
    fn arbitrary_collection_removal_inverse_round_trips(
        collection in 0_usize..6,
        raw_index in any::<usize>(),
        remove_active_sequence in any::<bool>(),
    ) {
        let mut state = indexed_removal_fixture();
        let command = removal_command(&state, collection, raw_index);
        if remove_active_sequence {
            if let ProjectCommand::RemoveSequence { sequence_id, .. } = &command {
                state.active_sequence_id = Some(sequence_id.clone());
            }
        }
        let applied = apply_group(&state, &[command]).unwrap();
        let restored = apply_group(&applied.state, &applied.inverse_commands).unwrap();
        prop_assert_eq!(restored.state, state);
    }
}

const RIPPLE_SEQUENCE_ID: &str = "10000000-0000-4000-8000-000000000006";
const RIPPLE_TRACK_ID: &str = "10000000-0000-4000-8000-000000000007";
const RIPPLE_SELECTED_CLIP_ID: &str = "61000000-0000-4000-8000-000000000002";
const RIPPLE_FIRST_SUCCESSOR_ID: &str = "61000000-0000-4000-8000-000000000100";
const TRACK_MUTE_INITIAL_HASH: &str =
    "aba0fdd4fcee030bc8b15d2ce0f24f25a8d230e328ae7b952a9f49c16c6d2841";
const TRACK_MUTE_MUTED_HASH: &str =
    "10fd961c3d9ded77a9de79aac979fd3f6b2a80f973800012534feadeee1bf5ae";

fn ripple_clip(template: &ProjectClip, id: String, start: u64, duration: u64) -> ProjectClip {
    let mut clip = template.clone();
    clip.id = id;
    clip.timeline_start.value = start;
    clip.source_in.value = 0;
    clip.source_out.value = duration;
    clip
}

fn ripple_fixture(successor_count: usize) -> VideoProjectSnapshotV2 {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let mut snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    let sequence = &mut snapshot.state.sequences[0];
    let ProjectTrack::Video { clips, .. } = &mut sequence.tracks[0] else {
        unreachable!();
    };
    let template = clips[0].clone();
    let mut ripple_clips = vec![
        ripple_clip(
            &template,
            "61000000-0000-4000-8000-000000000001".to_owned(),
            0,
            1,
        ),
        ripple_clip(&template, RIPPLE_SELECTED_CLIP_ID.to_owned(), 10, 2),
    ];
    ripple_clips.extend((0..successor_count).map(|index| {
        ripple_clip(
            &template,
            format!("61000000-0000-4000-8000-{:012}", 100_u64 + index as u64),
            20 + index as u64 * 2,
            1,
        )
    }));
    *clips = ripple_clips;

    let mut unaffected_track = sequence.tracks[0].clone();
    let ProjectTrack::Video {
        id, name, clips, ..
    } = &mut unaffected_track
    else {
        unreachable!();
    };
    *id = "61000000-0000-4000-8000-000000000900".to_owned();
    *name = "Unaffected video".to_owned();
    *clips = vec![ripple_clip(
        &template,
        "61000000-0000-4000-8000-000000000901".to_owned(),
        7,
        3,
    )];
    sequence.tracks.push(unaffected_track);
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    validate_snapshot(&snapshot).unwrap();
    snapshot
}

fn ripple_delete_command(command_id: &str) -> ProjectCommand {
    ProjectCommand::RippleDeleteClip {
        command_id: command_id.to_owned(),
        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
        track_id: RIPPLE_TRACK_ID.to_owned(),
        clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
    }
}

#[test]
fn locked_tracks_reject_every_clip_and_caption_mutation() {
    let mut snapshot = ripple_fixture(1);
    let sequence = &mut snapshot.state.sequences[0];
    let ProjectTrack::Video { clips, .. } = &sequence.tracks[0] else {
        unreachable!();
    };
    let selected_clip = clips[1].clone();
    let timeline_value = |value| RationalTime {
        value,
        rate_numerator: selected_clip.timeline_start.rate_numerator,
        rate_denominator: selected_clip.timeline_start.rate_denominator,
    };
    let source_value = |value| RationalTime {
        value,
        rate_numerator: selected_clip.source_in.rate_numerator,
        rate_denominator: selected_clip.source_in.rate_denominator,
    };
    sequence.tracks[0].set_locked(true);

    let caption_track_id = "71000000-0000-4000-8000-000000000001".to_owned();
    let caption = ProjectCaption {
        id: "71000000-0000-4000-8000-000000000002".to_owned(),
        start: timeline_value(0),
        end: timeline_value(1),
        text: "Locked caption".to_owned(),
        language: None,
    };
    sequence.tracks.push(ProjectTrack::Caption {
        id: caption_track_id.clone(),
        name: "Locked captions".to_owned(),
        locked: true,
        hidden: false,
        captions: vec![caption.clone()],
    });
    let original = snapshot.state.clone();
    let command_id = |suffix: u64| format!("71000000-0000-4000-8000-{suffix:012}");
    let mut inserted_clip = selected_clip.clone();
    inserted_clip.id = "71000000-0000-4000-8000-000000000003".to_owned();
    inserted_clip.timeline_start = timeline_value(100);
    let mut restored_clip = inserted_clip.clone();
    restored_clip.id = "71000000-0000-4000-8000-000000000004".to_owned();
    let mut added_caption = caption.clone();
    added_caption.id = "71000000-0000-4000-8000-000000000005".to_owned();

    let commands = vec![
        ProjectCommand::InsertClip {
            command_id: command_id(100),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            index: None,
            clip: inserted_clip,
        },
        ProjectCommand::RemoveClip {
            command_id: command_id(101),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
        },
        ProjectCommand::RippleDeleteClip {
            command_id: command_id(102),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
        },
        ProjectCommand::RestoreRippleDeletedClip {
            command_id: command_id(103),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            index: 0,
            clip: restored_clip,
        },
        ProjectCommand::SplitClip {
            command_id: command_id(104),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
            split_at: source_value(1),
            right_clip_id: "71000000-0000-4000-8000-000000000006".to_owned(),
        },
        ProjectCommand::MoveClip {
            command_id: command_id(105),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
            timeline_start: timeline_value(12),
        },
        ProjectCommand::TrimClip {
            command_id: command_id(106),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
            source_in: source_value(0),
            source_out: source_value(1),
        },
        ProjectCommand::SetClipTransform {
            command_id: command_id(107),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
            transform: ClipTransform::default(),
        },
        ProjectCommand::SetClipGain {
            command_id: command_id(108),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
            gain_milli_decibels: -1_000,
        },
        ProjectCommand::AddCaption {
            command_id: command_id(109),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: caption_track_id.clone(),
            index: None,
            caption: added_caption,
        },
        ProjectCommand::RemoveCaption {
            command_id: command_id(110),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: caption_track_id,
            caption_id: caption.id,
        },
    ];

    for command in commands {
        let error = apply_group(&snapshot.state, &[command]).unwrap_err();
        assert_eq!(
            error.code,
            crate::video::error::VideoErrorCode::InvalidCommand
        );
        assert_eq!(error.details["category"], "track_locked");
        assert_eq!(snapshot.state, original);
    }
}

#[test]
fn locked_track_does_not_block_mutations_on_an_unlocked_track_and_groups_stay_atomic() {
    let mut snapshot = ripple_fixture(1);
    snapshot.state.sequences[0].tracks[0].set_locked(true);
    let locked_track = snapshot.state.sequences[0].tracks[0].clone();
    let ProjectTrack::Video {
        id: unaffected_track_id,
        clips: unaffected_clips,
        ..
    } = &snapshot.state.sequences[0].tracks[1]
    else {
        unreachable!();
    };
    let unaffected_clip_id = unaffected_clips[0].id.clone();
    let mut moved_start = unaffected_clips[0].timeline_start.clone();
    moved_start.value = 9;
    let move_unaffected = ProjectCommand::MoveClip {
        command_id: "72000000-0000-4000-8000-000000000001".to_owned(),
        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
        track_id: unaffected_track_id.clone(),
        clip_id: unaffected_clip_id.clone(),
        timeline_start: moved_start.clone(),
    };

    let applied = apply_group(&snapshot.state, std::slice::from_ref(&move_unaffected)).unwrap();
    assert_eq!(applied.state.sequences[0].tracks[0], locked_track);
    let ProjectTrack::Video { clips, .. } = &applied.state.sequences[0].tracks[1] else {
        unreachable!();
    };
    assert_eq!(clips[0].timeline_start, moved_start);

    let original = snapshot.state.clone();
    let error = apply_group(
        &snapshot.state,
        &[
            move_unaffected,
            ProjectCommand::RemoveClip {
                command_id: "72000000-0000-4000-8000-000000000002".to_owned(),
                sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                track_id: RIPPLE_TRACK_ID.to_owned(),
                clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
            },
        ],
    )
    .unwrap_err();
    assert_eq!(error.details["category"], "track_locked");
    assert_eq!(snapshot.state, original);
}

#[test]
fn set_track_locked_persists_and_has_exact_undo_redo_hashes_and_labels() {
    let snapshot = ripple_fixture(1);
    let original_hash = snapshot.revision.state_hash.clone();
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("track-lock.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("track-lock-owner", &project_path, &grants)
        .unwrap();
    let project_id = opened.projection.project_id.clone();
    let request = CommandGroupRequest {
        group_id: "73000000-0000-4000-8000-000000000001".to_owned(),
        project_id: project_id.clone(),
        base_revision: 0,
        commands: vec![ProjectCommand::SetTrackLocked {
            command_id: "73000000-0000-4000-8000-000000000002".to_owned(),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            locked: true,
        }],
    };

    let committed = service
        .execute("track-lock-owner", request, &grants)
        .unwrap();
    assert!(committed.projection.state.sequences[0].tracks[0].is_locked());
    assert_eq!(
        committed.projection.last_command.as_ref().unwrap().summary,
        "Locked track"
    );
    assert_ne!(committed.state_hash, original_hash);
    let unlocked = apply_group(
        &committed.projection.state,
        &[ProjectCommand::SetTrackLocked {
            command_id: "73000000-0000-4000-8000-000000000003".to_owned(),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            locked: false,
        }],
    )
    .unwrap();
    assert_eq!(unlocked.summary, "Unlocked track");

    let undone = service
        .undo(
            "track-lock-owner",
            &project_id,
            1,
            "73000000-0000-4000-8000-000000000004",
            &grants,
        )
        .unwrap();
    assert!(!undone.projection.state.sequences[0].tracks[0].is_locked());
    assert_eq!(undone.state_hash, original_hash);
    assert_eq!(
        undone.projection.last_command.as_ref().unwrap().summary,
        "Undid Locked track"
    );

    let redone = service
        .redo(
            "track-lock-owner",
            &project_id,
            2,
            "73000000-0000-4000-8000-000000000005",
            &grants,
        )
        .unwrap();
    assert!(redone.projection.state.sequences[0].tracks[0].is_locked());
    assert_eq!(
        redone.projection.last_command.as_ref().unwrap().summary,
        "Redid Locked track"
    );
    let redone_hash = redone.state_hash;
    service.close("track-lock-owner", &project_id).unwrap();

    let reopened = service
        .open("track-lock-owner", &project_path, &grants)
        .unwrap();
    assert!(reopened.projection.state.sequences[0].tracks[0].is_locked());
    assert_eq!(reopened.projection.revision.state_hash, redone_hash);
}

#[test]
fn set_track_hidden_executes_with_exact_inverse_metadata_and_rejects_audio() {
    let mut snapshot = ripple_fixture(1);
    snapshot.state.sequences[0].tracks[0].set_locked(true);
    let original = snapshot.state.clone();
    let hidden = apply_group(
        &snapshot.state,
        &[ProjectCommand::SetTrackHidden {
            command_id: "73500000-0000-4000-8000-000000000001".to_owned(),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            hidden: true,
        }],
    )
    .unwrap();
    assert_eq!(hidden.summary, "Hid track");
    assert_eq!(hidden.state.sequences[0].tracks[0].is_hidden(), Ok(true));
    assert_eq!(hidden.affected_ranges.len(), 1);
    assert_eq!(hidden.affected_ranges[0].start.value, 0);
    assert_eq!(hidden.affected_ranges[0].end.value, 21);
    assert_eq!(
        hidden.cache_invalidations,
        vec![
            CacheInvalidation::Timeline,
            CacheInvalidation::Preview,
            CacheInvalidation::Captions,
            CacheInvalidation::RenderPlan,
        ]
    );
    assert!(matches!(
        hidden.inverse_commands.as_slice(),
        [ProjectCommand::SetTrackHidden { hidden: false, .. }]
    ));
    let restored = apply_group(&hidden.state, &hidden.inverse_commands).unwrap();
    assert_eq!(restored.summary, "Showed track");
    assert_eq!(restored.state, original);

    let sequence = &mut snapshot.state.sequences[0];
    let ProjectTrack::Video {
        id,
        name,
        locked,
        muted,
        clips,
        ..
    } = sequence.tracks.remove(0)
    else {
        unreachable!();
    };
    sequence.tracks.insert(
        0,
        ProjectTrack::Audio {
            id,
            name,
            locked,
            muted,
            clips,
        },
    );
    let error = apply_group(
        &snapshot.state,
        &[ProjectCommand::SetTrackHidden {
            command_id: "73500000-0000-4000-8000-000000000002".to_owned(),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            hidden: true,
        }],
    )
    .unwrap_err();
    assert_eq!(error.details["category"], "non_visual_track");
}

#[test]
fn set_track_muted_returns_no_affected_range_for_empty_track() {
    let mut snapshot = ripple_fixture(0);
    snapshot.state.sequences[0].tracks[0]
        .clips_mut()
        .unwrap()
        .clear();

    let applied = apply_group(
        &snapshot.state,
        &[ProjectCommand::SetTrackMuted {
            command_id: "74000000-0000-4000-8000-000000000010".to_owned(),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            muted: true,
        }],
    )
    .unwrap();

    assert_eq!(applied.state.sequences[0].tracks[0].is_muted(), Ok(true));
    assert!(applied.affected_ranges.is_empty());
}

#[test]
fn set_track_muted_supports_audio_tracks_and_exact_unmute_summary() {
    let mut snapshot = ripple_fixture(1);
    let sequence = &mut snapshot.state.sequences[0];
    let ProjectTrack::Video {
        id,
        name,
        locked,
        muted,
        clips,
        ..
    } = sequence.tracks.remove(0)
    else {
        unreachable!();
    };
    sequence.tracks.insert(
        0,
        ProjectTrack::Audio {
            id,
            name,
            locked,
            muted,
            clips,
        },
    );
    assert_eq!(
        sequence.tracks[0].is_hidden(),
        Err(TrackVisibilityError::InvalidTarget)
    );
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    validate_snapshot(&snapshot).unwrap();

    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("audio-track-mute.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("audio-track-mute-owner", &project_path, &grants)
        .unwrap();
    let project_id = opened.projection.project_id.clone();
    let expected_range = AffectedRange {
        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
        start: RationalTime {
            value: 0,
            rate_numerator: 30,
            rate_denominator: 1,
        },
        end: RationalTime {
            value: 21,
            rate_numerator: 30,
            rate_denominator: 1,
        },
    };

    let muted = service
        .execute(
            "audio-track-mute-owner",
            CommandGroupRequest {
                group_id: "74000000-0000-4000-8000-000000000011".to_owned(),
                project_id: project_id.clone(),
                base_revision: 0,
                commands: vec![ProjectCommand::SetTrackMuted {
                    command_id: "74000000-0000-4000-8000-000000000012".to_owned(),
                    sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                    track_id: RIPPLE_TRACK_ID.to_owned(),
                    muted: true,
                }],
            },
            &grants,
        )
        .unwrap();
    assert!(matches!(
        &muted.projection.state.sequences[0].tracks[0],
        ProjectTrack::Audio { muted: true, .. }
    ));
    assert_eq!(muted.affected_ranges, vec![expected_range.clone()]);

    let unmuted = service
        .execute(
            "audio-track-mute-owner",
            CommandGroupRequest {
                group_id: "74000000-0000-4000-8000-000000000013".to_owned(),
                project_id,
                base_revision: 1,
                commands: vec![ProjectCommand::SetTrackMuted {
                    command_id: "74000000-0000-4000-8000-000000000014".to_owned(),
                    sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                    track_id: RIPPLE_TRACK_ID.to_owned(),
                    muted: false,
                }],
            },
            &grants,
        )
        .unwrap();
    assert!(matches!(
        &unmuted.projection.state.sequences[0].tracks[0],
        ProjectTrack::Audio { muted: false, .. }
    ));
    assert_eq!(unmuted.affected_ranges, vec![expected_range]);
    assert_eq!(
        unmuted.projection.last_command.as_ref().unwrap().summary,
        "Unmuted track"
    );
}

#[test]
fn set_track_muted_persists_with_exact_undo_redo_hashes_invalidations_and_range() {
    let mut snapshot = ripple_fixture(1);
    snapshot.state.sequences[0].tracks[0].set_locked(true);
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    assert_eq!(snapshot.revision.state_hash, TRACK_MUTE_INITIAL_HASH);
    let mute_command = ProjectCommand::SetTrackMuted {
        command_id: "74000000-0000-4000-8000-000000000001".to_owned(),
        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
        track_id: RIPPLE_TRACK_ID.to_owned(),
        muted: true,
    };
    let expected_muted = apply_group(&snapshot.state, std::slice::from_ref(&mute_command)).unwrap();
    assert_eq!(
        state_hash(&expected_muted.state).unwrap(),
        TRACK_MUTE_MUTED_HASH
    );
    let expected_range = AffectedRange {
        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
        start: RationalTime {
            value: 0,
            rate_numerator: 30,
            rate_denominator: 1,
        },
        end: RationalTime {
            value: 21,
            rate_numerator: 30,
            rate_denominator: 1,
        },
    };
    let expected_invalidations = vec![
        CacheInvalidation::Timeline,
        CacheInvalidation::Preview,
        CacheInvalidation::AudioMix,
        CacheInvalidation::RenderPlan,
    ];
    assert_eq!(expected_muted.affected_ranges, vec![expected_range.clone()]);
    assert_eq!(expected_muted.cache_invalidations, expected_invalidations);

    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("track-mute.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("track-mute-owner", &project_path, &grants)
        .unwrap();
    let project_id = opened.projection.project_id.clone();
    let committed = service
        .execute(
            "track-mute-owner",
            CommandGroupRequest {
                group_id: "74000000-0000-4000-8000-000000000002".to_owned(),
                project_id: project_id.clone(),
                base_revision: 0,
                commands: vec![mute_command],
            },
            &grants,
        )
        .unwrap();

    assert_eq!(committed.new_revision.number, 1);
    assert_eq!(committed.state_hash, TRACK_MUTE_MUTED_HASH);
    assert_eq!(
        committed.projection.state.sequences[0].tracks[0].is_muted(),
        Ok(true)
    );
    assert_eq!(committed.affected_ranges, vec![expected_range]);
    assert_eq!(committed.cache_invalidations, expected_invalidations);
    assert_eq!(
        committed.projection.last_command.as_ref().unwrap().summary,
        "Muted track"
    );

    let undone = service
        .undo(
            "track-mute-owner",
            &project_id,
            1,
            "74000000-0000-4000-8000-000000000003",
            &grants,
        )
        .unwrap();
    assert_eq!(undone.new_revision.number, 2);
    assert_eq!(undone.state_hash, TRACK_MUTE_INITIAL_HASH);
    assert_eq!(
        undone.projection.state.sequences[0].tracks[0].is_muted(),
        Ok(false)
    );

    let redone = service
        .redo(
            "track-mute-owner",
            &project_id,
            2,
            "74000000-0000-4000-8000-000000000004",
            &grants,
        )
        .unwrap();
    assert_eq!(redone.new_revision.number, 3);
    assert_eq!(redone.state_hash, TRACK_MUTE_MUTED_HASH);
    assert_eq!(
        redone.projection.state.sequences[0].tracks[0].is_muted(),
        Ok(true)
    );
    service.close("track-mute-owner", &project_id).unwrap();

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("track-mute-reopen-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.projection.revision.number, 3);
    assert_eq!(
        reopened.projection.revision.state_hash,
        TRACK_MUTE_MUTED_HASH
    );
    assert_eq!(
        reopened.projection.state.sequences[0].tracks[0].is_muted(),
        Ok(true)
    );
    reopened_service
        .close("track-mute-reopen-owner", &project_id)
        .unwrap();
}

#[test]
fn caption_track_mute_rejection_is_atomic_across_service_and_persistence() {
    let mut snapshot = ripple_fixture(1);
    let caption_track_id = "74000000-0000-4000-8000-000000000010".to_owned();
    snapshot.state.sequences[0]
        .tracks
        .push(ProjectTrack::Caption {
            id: caption_track_id.clone(),
            name: "Captions".to_owned(),
            locked: false,
            hidden: false,
            captions: vec![],
        });
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    let original_state = snapshot.state.clone();
    let original_hash = snapshot.revision.state_hash.clone();
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("caption-mute-rejection.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("caption-mute-owner", &project_path, &grants)
        .unwrap();
    let project_id = opened.projection.project_id.clone();

    let error = service
        .execute(
            "caption-mute-owner",
            CommandGroupRequest {
                group_id: "74000000-0000-4000-8000-000000000011".to_owned(),
                project_id: project_id.clone(),
                base_revision: 0,
                commands: vec![
                    ProjectCommand::SetTrackMuted {
                        command_id: "74000000-0000-4000-8000-000000000012".to_owned(),
                        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                        track_id: RIPPLE_TRACK_ID.to_owned(),
                        muted: true,
                    },
                    ProjectCommand::SetTrackMuted {
                        command_id: "74000000-0000-4000-8000-000000000013".to_owned(),
                        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                        track_id: caption_track_id,
                        muted: true,
                    },
                ],
            },
            &grants,
        )
        .unwrap_err();
    assert_eq!(error.details["category"], "non_audio_track");
    service.close("caption-mute-owner", &project_id).unwrap();

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("caption-mute-reopen-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.projection.revision.number, 0);
    assert_eq!(reopened.projection.revision.state_hash, original_hash);
    assert_eq!(reopened.projection.state, original_state);
    assert_eq!(
        reopened.projection.state.sequences[0].tracks[0].is_muted(),
        Ok(false)
    );
    assert_eq!(
        reopened.projection.state.sequences[0].tracks[2].is_muted(),
        Err(TrackMuteError::InvalidTarget)
    );
    reopened_service
        .close("caption-mute-reopen-owner", &project_id)
        .unwrap();
}

#[test]
fn ripple_delete_preserves_gaps_and_leaves_other_tracks_unchanged() {
    let snapshot = ripple_fixture(2);
    let unaffected_track = snapshot.state.sequences[0].tracks[1].clone();
    let applied = apply_group(
        &snapshot.state,
        &[ripple_delete_command(
            "62000000-0000-4000-8000-000000000001",
        )],
    )
    .unwrap();
    let ProjectTrack::Video { clips, .. } = &applied.state.sequences[0].tracks[0] else {
        unreachable!();
    };

    assert_eq!(
        clips
            .iter()
            .map(|clip| (clip.id.as_str(), clip.timeline_start.value))
            .collect::<Vec<_>>(),
        vec![
            ("61000000-0000-4000-8000-000000000001", 0),
            (RIPPLE_FIRST_SUCCESSOR_ID, 18),
            ("61000000-0000-4000-8000-000000000101", 20),
        ]
    );
    assert_eq!(18 - (clips[0].timeline_start.value + 1), 17);
    assert_eq!(
        clips[2].timeline_start.value - clips[1].timeline_start.value,
        2
    );
    assert_eq!(applied.state.sequences[0].tracks[1], unaffected_track);
    assert_eq!(applied.summary, "Ripple deleted clip");
    assert_eq!(
        applied.affected_ranges,
        vec![AffectedRange {
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            start: RationalTime {
                value: 10,
                rate_numerator: 30,
                rate_denominator: 1
            },
            end: RationalTime {
                value: 23,
                rate_numerator: 30,
                rate_denominator: 1
            },
        }]
    );
    assert!(matches!(
        applied.inverse_commands.as_slice(),
        [ProjectCommand::RestoreRippleDeletedClip { index: 1, .. }]
    ));
    let restored = apply_group(&applied.state, &applied.inverse_commands).unwrap();
    assert_eq!(restored.state, snapshot.state);
}

#[test]
fn ripple_delete_uses_exact_rational_timeline_duration() {
    let mut snapshot = mixed_rate_fixture();
    let sequence = &mut snapshot.state.sequences[0];
    let ProjectTrack::Video { clips, .. } = &mut sequence.tracks[0] else {
        unreachable!();
    };
    let make_clip = |id: &str, start: u64, source_in: u64, source_out: u64| ProjectClip {
        id: id.to_owned(),
        source: ClipSource::Asset {
            asset_id: MIXED_RATE_ASSET_ID.to_owned(),
        },
        timeline_start: timeline_time(start),
        source_in: source_time(source_in),
        source_out: source_time(source_out),
        transform: ClipTransform::default(),
        gain_milli_decibels: 0,
    };
    *clips = vec![
        make_clip("63000000-0000-4000-8000-000000000001", 0, 0, 8),
        make_clip(RIPPLE_SELECTED_CLIP_ID, 20, 8, 24),
        make_clip(RIPPLE_FIRST_SUCCESSOR_ID, 55, 24, 32),
    ];
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    validate_snapshot(&snapshot).unwrap();

    let applied = apply_group(
        &snapshot.state,
        &[ProjectCommand::RippleDeleteClip {
            command_id: "63000000-0000-4000-8000-000000000002".to_owned(),
            sequence_id: MIXED_RATE_SEQUENCE_ID.to_owned(),
            track_id: MIXED_RATE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
        }],
    )
    .unwrap();
    let ProjectTrack::Video { clips, .. } = &applied.state.sequences[0].tracks[0] else {
        unreachable!();
    };
    assert_eq!(clips[1].timeline_start, timeline_time(35));
    assert_eq!(
        applied.affected_ranges,
        vec![AffectedRange {
            sequence_id: MIXED_RATE_SEQUENCE_ID.to_owned(),
            start: timeline_time(20),
            end: timeline_time(65),
        }]
    );
    assert_eq!(
        apply_group(&applied.state, &applied.inverse_commands)
            .unwrap()
            .state,
        snapshot.state
    );
}

#[test]
fn ripple_delete_handles_more_than_ninety_nine_successors_with_one_inverse() {
    let snapshot = ripple_fixture(120);
    let applied = apply_group(
        &snapshot.state,
        &[ripple_delete_command(
            "64000000-0000-4000-8000-000000000001",
        )],
    )
    .unwrap();
    let ProjectTrack::Video { clips, .. } = &applied.state.sequences[0].tracks[0] else {
        unreachable!();
    };
    assert_eq!(clips.len(), 121);
    for (index, clip) in clips.iter().skip(1).enumerate() {
        assert_eq!(clip.timeline_start.value, 18 + index as u64 * 2);
    }
    assert_eq!(applied.inverse_commands.len(), 1);
    assert_eq!(applied.affected_ranges.len(), 1);
    assert_eq!(
        apply_group(&applied.state, &applied.inverse_commands)
            .unwrap()
            .state,
        snapshot.state
    );
}

#[test]
fn ripple_delete_failure_is_atomic() {
    let mut snapshot = ripple_fixture(1);
    let ProjectTrack::Video { clips, .. } = &mut snapshot.state.sequences[0].tracks[0] else {
        unreachable!();
    };
    clips.remove(0);
    let original = snapshot.state.clone();
    let commands = vec![
        ProjectCommand::MoveClip {
            command_id: "65000000-0000-4000-8000-000000000001".to_owned(),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_SELECTED_CLIP_ID.to_owned(),
            timeline_start: RationalTime {
                value: 0,
                rate_numerator: 30,
                rate_denominator: 1,
            },
        },
        ProjectCommand::MoveClip {
            command_id: "65000000-0000-4000-8000-000000000002".to_owned(),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: RIPPLE_TRACK_ID.to_owned(),
            clip_id: RIPPLE_FIRST_SUCCESSOR_ID.to_owned(),
            timeline_start: RationalTime {
                value: 1,
                rate_numerator: 30,
                rate_denominator: 1,
            },
        },
        ripple_delete_command("65000000-0000-4000-8000-000000000003"),
    ];

    let error = apply_group(&snapshot.state, &commands).unwrap_err();
    assert_eq!(
        error.code,
        crate::video::error::VideoErrorCode::InvalidCommand
    );
    assert_eq!(snapshot.state, original);
}

#[test]
fn ripple_delete_commit_undo_redo_are_monotonic_and_have_readable_labels() {
    let snapshot = ripple_fixture(2);
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("ripple.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("ripple-owner", &project_path, &grants)
        .unwrap();
    let project_id = opened.projection.project_id.clone();
    let original_state = opened.projection.state.clone();
    let request = CommandGroupRequest {
        group_id: "66000000-0000-4000-8000-000000000001".to_owned(),
        project_id: project_id.clone(),
        base_revision: 0,
        commands: vec![ripple_delete_command(
            "66000000-0000-4000-8000-000000000002",
        )],
    };

    let committed = service.execute("ripple-owner", request, &grants).unwrap();
    assert_eq!(committed.new_revision.number, 1);
    assert_eq!(
        committed.projection.last_command.as_ref().unwrap().summary,
        "Ripple deleted clip"
    );
    assert!(committed.projection.can_undo);
    let committed_state = committed.projection.state.clone();

    let undone = service
        .undo(
            "ripple-owner",
            &project_id,
            1,
            "66000000-0000-4000-8000-000000000003",
            &grants,
        )
        .unwrap();
    assert_eq!(undone.new_revision.number, 2);
    assert_eq!(undone.projection.state, original_state);
    assert_eq!(
        undone.projection.last_command.as_ref().unwrap().summary,
        "Undid Ripple deleted clip"
    );
    assert!(undone.projection.can_redo);

    let redone = service
        .redo(
            "ripple-owner",
            &project_id,
            2,
            "66000000-0000-4000-8000-000000000004",
            &grants,
        )
        .unwrap();
    assert_eq!(redone.new_revision.number, 3);
    assert_eq!(redone.projection.state, committed_state);
    assert_eq!(
        redone.projection.last_command.as_ref().unwrap().summary,
        "Redid Ripple deleted clip"
    );
}

#[test]
fn private_ripple_restore_is_rejected_as_a_forward_commit() {
    let snapshot = ripple_fixture(1);
    let applied = apply_group(
        &snapshot.state,
        &[ripple_delete_command(
            "67000000-0000-4000-8000-000000000001",
        )],
    )
    .unwrap();
    let request = CommandGroupRequest {
        group_id: "67000000-0000-4000-8000-000000000002".to_owned(),
        project_id: snapshot.id.clone(),
        base_revision: 0,
        commands: applied.inverse_commands,
    };
    let error = commit_transition(&snapshot, &request, "2026-08-04T12:00:00Z").unwrap_err();
    assert_eq!(
        error.code,
        crate::video::error::VideoErrorCode::InvalidCommand
    );
}

#[test]
fn trim_command_and_semantic_inverse_round_trip() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    let command = ProjectCommand::TrimClip {
        command_id: "30000000-0000-4000-8000-000000000001".to_owned(),
        sequence_id: "10000000-0000-4000-8000-000000000006".to_owned(),
        track_id: "10000000-0000-4000-8000-000000000007".to_owned(),
        clip_id: "10000000-0000-4000-8000-000000000008".to_owned(),
        source_in: RationalTime {
            value: 5,
            rate_numerator: 30,
            rate_denominator: 1,
        },
        source_out: RationalTime {
            value: 25,
            rate_numerator: 30,
            rate_denominator: 1,
        },
    };
    let applied = apply_group(&snapshot.state, &[command]).unwrap();
    let restored = apply_group(&applied.state, &applied.inverse_commands).unwrap();
    assert_eq!(restored.state, snapshot.state);
    assert_eq!(applied.summary, "Applied trim");
    assert!(applied.cache_invalidations.len() >= 3);
}

#[test]
fn commit_undo_redo_are_monotonic_and_restore_hashes() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    let request = CommandGroupRequest {
        group_id: "40000000-0000-4000-8000-000000000001".to_owned(),
        project_id: snapshot.id.clone(),
        base_revision: 0,
        commands: vec![ProjectCommand::TrimClip {
            command_id: "40000000-0000-4000-8000-000000000002".to_owned(),
            sequence_id: "10000000-0000-4000-8000-000000000006".to_owned(),
            track_id: "10000000-0000-4000-8000-000000000007".to_owned(),
            clip_id: "10000000-0000-4000-8000-000000000008".to_owned(),
            source_in: RationalTime {
                value: 5,
                rate_numerator: 30,
                rate_denominator: 1,
            },
            source_out: RationalTime {
                value: 25,
                rate_numerator: 30,
                rate_denominator: 1,
            },
        }],
    };
    let committed = commit_transition(&snapshot, &request, "2026-07-26T12:01:00Z").unwrap();
    let undone = undo_transition(
        &committed.snapshot,
        1,
        "40000000-0000-4000-8000-000000000003",
        "2026-07-26T12:02:00Z",
    )
    .unwrap();
    let redone = redo_transition(
        &undone.snapshot,
        2,
        "40000000-0000-4000-8000-000000000004",
        "2026-07-26T12:03:00Z",
    )
    .unwrap();
    assert_eq!(
        (
            committed.snapshot.revision.number,
            undone.snapshot.revision.number,
            redone.snapshot.revision.number
        ),
        (1, 2, 3)
    );
    assert_eq!(
        undone.snapshot.revision.state_hash,
        snapshot.revision.state_hash
    );
    assert_eq!(
        redone.snapshot.revision.state_hash,
        committed.snapshot.revision.state_hash
    );
    assert!(redone.snapshot.history.redo_stack.is_empty());
}

#[test]
fn journal_classifies_torn_tail_and_lock_contention() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("test.svpvideo");
    fs::write(&project_path, b"{}").unwrap();
    let snapshot_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures/project-v2/valid-minimal.svpvideo");
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(snapshot_path).unwrap()).unwrap();
    let first_lock = acquire_project_lock(&project_path).unwrap();
    assert!(acquire_project_lock(&project_path).is_err());
    let journal_path = directory.path().join("test.svpvideo.data/journal.ndjson");
    initialize_journal(
        &journal_path,
        &JournalHeader {
            journal_version: 1,
            project_id: snapshot.id.clone(),
            storage_generation_id: snapshot.storage_generation_id.clone(),
            base_revision: snapshot.revision.clone(),
            base_state_hash: snapshot.revision.state_hash.clone(),
            created_at: snapshot.created_at.clone(),
            header_hash: String::new(),
        },
    )
    .unwrap();
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&journal_path)
        .unwrap();
    file.write_all(b"{\"torn\":").unwrap();
    file.flush().unwrap();
    let scanned = scan(&journal_path).unwrap();
    assert_eq!(scanned.tail, TailClassification::Torn);
    assert!(scanned.discarded_tail_bytes > 0);
    drop(first_lock);
    assert!(acquire_project_lock(&project_path).is_ok());
}

#[test]
fn checkpoint_failpoints_preserve_a_complete_old_or_new_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("checkpoint.svpvideo");
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures/project-v2/valid-minimal.svpvideo");
    fs::copy(&fixture_path, &project_path).unwrap();
    let original = read_snapshot(&project_path).unwrap();
    let mut updated = original.clone();
    updated.name = "Updated snapshot".to_owned();
    assert!(checkpoint_with_failpoint(
        &project_path,
        &updated,
        CheckpointFailpoint::AfterTempSyncBeforeReplace
    )
    .is_err());
    assert_eq!(read_snapshot(&project_path).unwrap().name, original.name);
    assert!(
        checkpoint_with_failpoint(&project_path, &updated, CheckpointFailpoint::AfterReplace)
            .is_err()
    );
    assert_eq!(
        read_snapshot(&project_path).unwrap().name,
        "Updated snapshot"
    );
    assert_eq!(
        read_snapshot(
            &directory
                .path()
                .join("checkpoint.svpvideo.data/snapshot.previous.svpvideo")
        )
        .unwrap()
        .name,
        original.name
    );
}

fn initialization_failpoints() -> [ProjectInitializationFailpoint; 4] {
    [
        ProjectInitializationFailpoint::AfterJournal,
        ProjectInitializationFailpoint::Checkpoint(CheckpointFailpoint::BeforeTempSync),
        ProjectInitializationFailpoint::Checkpoint(CheckpointFailpoint::AfterTempSyncBeforeReplace),
        ProjectInitializationFailpoint::Checkpoint(CheckpointFailpoint::AfterReplace),
    ]
}

#[test]
fn service_create_initialization_failures_roll_back_and_retry() {
    for (index, failpoint) in initialization_failpoints().into_iter().enumerate() {
        let directory = tempfile::tempdir().unwrap();
        let project_path = directory
            .path()
            .join(format!("create-retry-{index}.svpvideo"));
        let owner = format!("create-retry-owner-{index}");
        let grants = crate::video::VideoPathGrants::default();
        grants
            .grant_destination(&owner, GrantCategory::Project, &project_path)
            .unwrap();
        let service = VideoProjectService::default();

        let failure = service.create_with_initialization_failpoint(
            &owner,
            &project_path,
            "Retryable project",
            &grants,
            failpoint,
        );
        assert!(failure.is_err(), "failpoint {failpoint:?}");
        assert!(!project_path.exists(), "failpoint {failpoint:?}");
        assert!(
            !journal_path(&project_path).unwrap().exists(),
            "failpoint {failpoint:?}"
        );

        let projection = service
            .create(&owner, &project_path, "Retryable project", &grants)
            .unwrap();
        assert_eq!(projection.name, "Retryable project");
        assert!(scan(&journal_path(&project_path).unwrap()).is_ok());
        service.close(&owner, &projection.project_id).unwrap();
    }
}

#[test]
fn service_v1_migration_initialization_failures_preserve_bytes_and_retry() {
    let source_project =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.svpvideo");
    let source_media =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.mp4");

    for (index, failpoint) in initialization_failpoints().into_iter().enumerate() {
        let directory = tempfile::tempdir().unwrap();
        let project_path = directory
            .path()
            .join(format!("migration-retry-{index}.svpvideo"));
        fs::copy(&source_project, &project_path).unwrap();
        fs::copy(&source_media, directory.path().join("single-clip.mp4")).unwrap();
        let original_project_bytes = fs::read(&project_path).unwrap();

        let sidecar = sidecar_path(&project_path).unwrap();
        fs::create_dir_all(&sidecar).unwrap();
        let sentinel_path = sidecar.join("pre-existing-sidecar-sentinel");
        let sentinel_bytes = b"keep this legitimate sidecar artifact exactly";
        fs::write(&sentinel_path, sentinel_bytes).unwrap();
        let previous_path = sidecar.join("snapshot.previous.svpvideo");
        let previous_bytes = b"pre-existing previous snapshot bytes";
        fs::write(&previous_path, previous_bytes).unwrap();

        let service = VideoProjectService::default();
        let grants = crate::video::VideoPathGrants::default();
        let owner = format!("migration-retry-owner-{index}");
        let failure =
            service.open_with_initialization_failpoint(&owner, &project_path, &grants, failpoint);
        assert!(failure.is_err(), "failpoint {failpoint:?}");
        assert_eq!(
            fs::read(&project_path).unwrap(),
            original_project_bytes,
            "failpoint {failpoint:?}"
        );
        assert_eq!(fs::read(&sentinel_path).unwrap(), sentinel_bytes);
        assert_eq!(fs::read(&previous_path).unwrap(), previous_bytes);
        assert!(
            !journal_path(&project_path).unwrap().exists(),
            "failpoint {failpoint:?}"
        );

        let opened = service.open(&owner, &project_path, &grants).unwrap();
        assert_eq!(opened.recovery.status, RecoveryStatus::MigratedV1);
        assert_eq!(fs::read(&sentinel_path).unwrap(), sentinel_bytes);
        service
            .close(&owner, &opened.projection.project_id)
            .unwrap();
    }
}

#[test]
fn v1_migration_preserves_selected_state_and_resets_history() {
    let fixture_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.svpvideo");
    let migrated = migrate_v1_bytes(&fs::read(fixture_path).unwrap()).unwrap();
    assert_eq!(migrated.schema_version, 2);
    assert_eq!(migrated.state.assets.len(), 1);
    assert_eq!(migrated.state.sequences.len(), 1);
    assert!(migrated.state.sequences[0]
        .tracks
        .iter()
        .all(|track| !track.is_locked()));
    assert!(migrated.state.sequences[0]
        .tracks
        .iter()
        .all(|track| track.is_muted() == Ok(false)));
    let migrated_track_json = serde_json::to_value(&migrated.state.sequences[0].tracks[0]).unwrap();
    assert!(migrated_track_json.get("locked").is_none());
    assert!(migrated_track_json.get("muted").is_none());
    assert!(migrated.history.undo_stack.is_empty());
    assert!(validate_snapshot(&migrated).is_ok());
}

#[test]
fn missing_journal_restarts_record_numbers_from_one() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("missing-journal.svpvideo");
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures/project-v2/valid-minimal.svpvideo");
    fs::copy(fixture_path, &project_path).unwrap();
    let _lock = acquire_project_lock(&project_path).unwrap();
    let mut snapshot = read_snapshot(&project_path).unwrap();
    snapshot.last_applied_record_number = 7;
    snapshot.last_record_hash = "1".repeat(64);
    checkpoint(&project_path, &snapshot).unwrap();

    let recovered = recover(&project_path).unwrap();

    assert_eq!(recovered.report.status, RecoveryStatus::JournalRecreated);
    assert_eq!(recovered.snapshot.last_applied_record_number, 0);
    assert!(scan(&journal_path(&project_path).unwrap())
        .unwrap()
        .records
        .is_empty());
}

#[test]
fn recovery_repairs_a_torn_tail_to_the_exact_snapshot_hash() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("recovery.svpvideo");
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures/project-v2/valid-minimal.svpvideo");
    fs::copy(fixture_path, &project_path).unwrap();
    let _lock = acquire_project_lock(&project_path).unwrap();
    let mut snapshot = read_snapshot(&project_path).unwrap();
    create_journal_for_snapshot(&project_path, &mut snapshot).unwrap();
    checkpoint(&project_path, &snapshot).unwrap();
    let journal_path = directory
        .path()
        .join("recovery.svpvideo.data/journal.ndjson");
    fs::OpenOptions::new()
        .append(true)
        .open(&journal_path)
        .unwrap()
        .write_all(b"{\"partial\":")
        .unwrap();
    let recovered = recover(&project_path).unwrap();
    assert_eq!(
        recovered.snapshot.revision.state_hash,
        snapshot.revision.state_hash
    );
    assert_eq!(
        recovered.report.status,
        super::types::RecoveryStatus::Recovered
    );
    assert_eq!(scan(&journal_path).unwrap().tail, TailClassification::Clean);
}

#[test]
fn service_migration_commit_undo_redo_and_reopen_preserve_exact_state() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("workflow.svpvideo");
    let source_project =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.svpvideo");
    let source_media =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.mp4");
    fs::copy(source_project, &project_path).unwrap();
    fs::copy(source_media, directory.path().join("single-clip.mp4")).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service.open("owner", &project_path, &grants).unwrap();
    assert_eq!(opened.recovery.status, RecoveryStatus::MigratedV1);
    let project_id = opened.projection.project_id.clone();
    let request = CommandGroupRequest {
        group_id: "50000000-0000-4000-8000-000000000001".to_owned(),
        project_id: project_id.clone(),
        base_revision: 0,
        commands: vec![ProjectCommand::TrimClip {
            command_id: "50000000-0000-4000-8000-000000000002".to_owned(),
            sequence_id: "44444444-4444-4444-8444-444444444444".to_owned(),
            track_id: "55555555-5555-4555-8555-555555555555".to_owned(),
            clip_id: "66666666-6666-4666-8666-666666666666".to_owned(),
            source_in: RationalTime {
                value: 10,
                rate_numerator: 30,
                rate_denominator: 1,
            },
            source_out: RationalTime {
                value: 50,
                rate_numerator: 30,
                rate_denominator: 1,
            },
        }],
    };
    let committed = service.execute("owner", request.clone(), &grants).unwrap();
    let duplicate = service.execute("owner", request.clone(), &grants).unwrap();
    assert_eq!(duplicate.state_hash, committed.state_hash);
    service.close("owner", &project_id).unwrap();

    let commit_reopened_service = VideoProjectService::default();
    let commit_reopened = commit_reopened_service
        .open("owner-commit", &project_path, &grants)
        .unwrap();
    let commit_metadata = commit_reopened.projection.last_command.as_ref().unwrap();
    assert_eq!(commit_metadata.operation_id, committed.operation_id);
    assert_eq!(commit_metadata.group_id, request.group_id);
    assert_eq!(commit_metadata.summary, "Applied trim");
    assert_eq!(
        commit_reopened_service
            .inspector("owner-commit", &project_id)
            .unwrap()
            .last_command,
        committed.projection.last_command
    );
    let replayed_commit = commit_reopened_service
        .execute("owner-commit", request.clone(), &grants)
        .unwrap();
    assert_eq!(replayed_commit, committed);

    let undone = commit_reopened_service
        .undo(
            "owner-commit",
            &project_id,
            1,
            "50000000-0000-4000-8000-000000000003",
            &grants,
        )
        .unwrap();
    assert_eq!(undone.new_revision.number, 2);
    commit_reopened_service
        .close("owner-commit", &project_id)
        .unwrap();

    let undo_reopened_service = VideoProjectService::default();
    let undo_reopened = undo_reopened_service
        .open("owner-undo", &project_path, &grants)
        .unwrap();
    let undo_metadata = undo_reopened.projection.last_command.as_ref().unwrap();
    assert_eq!(
        undo_metadata.operation_id,
        "50000000-0000-4000-8000-000000000003"
    );
    assert_eq!(undo_metadata.group_id, request.group_id);
    assert_eq!(undo_metadata.summary, "Undid Applied trim");
    assert_eq!(
        undo_reopened_service
            .inspector("owner-undo", &project_id)
            .unwrap()
            .last_command,
        undone.projection.last_command
    );
    let replayed_undo = undo_reopened_service
        .undo(
            "owner-undo",
            &project_id,
            1,
            "50000000-0000-4000-8000-000000000003",
            &grants,
        )
        .unwrap();
    assert_eq!(replayed_undo, undone);

    let redone = undo_reopened_service
        .redo(
            "owner-undo",
            &project_id,
            2,
            "50000000-0000-4000-8000-000000000004",
            &grants,
        )
        .unwrap();
    assert_eq!(redone.new_revision.number, 3);
    let durable_hash = redone.state_hash.clone();
    println!("workflow durable state hash at revision 3: {durable_hash}");
    undo_reopened_service
        .close("owner-undo", &project_id)
        .unwrap();

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("owner-redo", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.projection.revision.state_hash, durable_hash);
    assert!(reopened.projection.can_undo);
    assert_eq!(reopened.projection.revision.number, 3);
    let redo_metadata = reopened.projection.last_command.as_ref().unwrap();
    assert_eq!(
        redo_metadata.operation_id,
        "50000000-0000-4000-8000-000000000004"
    );
    assert_eq!(redo_metadata.group_id, request.group_id);
    assert_eq!(redo_metadata.summary, "Redid Applied trim");

    let replayed_redo = reopened_service
        .redo(
            "owner-redo",
            &project_id,
            2,
            "50000000-0000-4000-8000-000000000004",
            &grants,
        )
        .unwrap();
    assert_eq!(replayed_redo, redone);
    let inspector = reopened_service
        .inspector("owner-redo", &project_id)
        .unwrap();
    assert_eq!(inspector.revision.number, 3);
    assert_eq!(inspector.last_command, redone.projection.last_command);

    let mut conflicting_group = request;
    conflicting_group.base_revision = 3;
    let conflict = reopened_service
        .execute("owner-redo", conflicting_group, &grants)
        .unwrap_err();
    assert_eq!(
        conflict.code,
        crate::video::error::VideoErrorCode::DuplicateConflict
    );
    let conflict = reopened_service
        .redo(
            "owner-redo",
            &project_id,
            1,
            "50000000-0000-4000-8000-000000000003",
            &grants,
        )
        .unwrap_err();
    assert_eq!(
        conflict.code,
        crate::video::error::VideoErrorCode::DuplicateConflict
    );
}

#[test]
fn journal_replay_restores_exact_command_result_without_clean_close() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("replay-idempotency.svpvideo");
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.svpvideo"),
        &project_path,
    )
    .unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.mp4"),
        directory.path().join("single-clip.mp4"),
    )
    .unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let (project_id, request, acknowledged) = {
        let service = VideoProjectService::default();
        let opened = service.open("crash-owner", &project_path, &grants).unwrap();
        let project_id = opened.projection.project_id;
        let request = CommandGroupRequest {
            group_id: "51000000-0000-4000-8000-000000000001".to_owned(),
            project_id: project_id.clone(),
            base_revision: 0,
            commands: vec![ProjectCommand::TrimClip {
                command_id: "51000000-0000-4000-8000-000000000002".to_owned(),
                sequence_id: "44444444-4444-4444-8444-444444444444".to_owned(),
                track_id: "55555555-5555-4555-8555-555555555555".to_owned(),
                clip_id: "66666666-6666-4666-8666-666666666666".to_owned(),
                source_in: RationalTime {
                    value: 4,
                    rate_numerator: 30,
                    rate_denominator: 1,
                },
                source_out: RationalTime {
                    value: 55,
                    rate_numerator: 30,
                    rate_denominator: 1,
                },
            }],
        };
        let acknowledged = service
            .execute("crash-owner", request.clone(), &grants)
            .unwrap();
        (project_id, request, acknowledged)
    };

    let records = scan(
        &directory
            .path()
            .join("replay-idempotency.svpvideo.data/journal.ndjson"),
    )
    .unwrap()
    .records;
    assert_eq!(records.len(), 1);
    assert!(records[0].payload_hash.is_some());
    assert_eq!(
        records[0].idempotency_result.as_deref(),
        Some(&acknowledged)
    );

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("replay-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 1);
    let retried = reopened_service
        .execute("replay-owner", request, &grants)
        .unwrap();
    assert_eq!(retried, acknowledged);
    assert_eq!(
        reopened_service
            .inspector("replay-owner", &project_id)
            .unwrap()
            .revision
            .number,
        1
    );
}

#[test]
fn generated_10k_record_journal_scans_correctly_and_meets_release_budget() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("performance.svpvideo");
    fs::write(&project_path, b"{}").unwrap();
    let snapshot_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures/project-v2/valid-minimal.svpvideo");
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(snapshot_path).unwrap()).unwrap();
    let _lock = acquire_project_lock(&project_path).unwrap();
    let journal_path = directory
        .path()
        .join("performance.svpvideo.data/journal.ndjson");
    let header = initialize_journal(
        &journal_path,
        &JournalHeader {
            journal_version: 1,
            project_id: snapshot.id.clone(),
            storage_generation_id: snapshot.storage_generation_id.clone(),
            base_revision: snapshot.revision.clone(),
            base_state_hash: snapshot.revision.state_hash.clone(),
            created_at: snapshot.created_at.clone(),
            header_hash: String::new(),
        },
    )
    .unwrap();
    let mut previous_hash = header.header_hash;
    let mut bytes = Vec::new();
    for number in 1..=10_000_u64 {
        let history = ProjectHistoryEntryV2 {
            group_id: snapshot.id.clone(),
            summary: "Performance fixture".to_owned(),
            forward_commands: vec![],
            inverse_commands: vec![],
            affected_ranges: vec![],
            cache_invalidations: vec![],
        };
        let record = with_record_hash(&JournalRecord {
            kind: JournalRecordKind::Commit,
            record_number: number,
            operation_id: snapshot.revision.operation_id.clone(),
            group_id: snapshot.id.clone(),
            committed_at: snapshot.updated_at.clone(),
            base_revision: snapshot.revision.clone(),
            resulting_revision: snapshot.revision.clone(),
            commands: vec![],
            history_group: history,
            summary: "Performance fixture".to_owned(),
            affected_ranges: vec![],
            cache_invalidations: vec![],
            previous_state_hash: snapshot.revision.state_hash.clone(),
            resulting_state_hash: snapshot.revision.state_hash.clone(),
            payload_hash: None,
            idempotency_result: None,
            previous_record_hash: previous_hash,
            record_hash: String::new(),
        })
        .unwrap();
        previous_hash = record.record_hash.clone();
        bytes.extend(canonical_bytes(&record).unwrap());
        bytes.push(b'\n');
    }
    fs::OpenOptions::new()
        .append(true)
        .open(&journal_path)
        .unwrap()
        .write_all(&bytes)
        .unwrap();
    let started = Instant::now();
    let scanned = scan(&journal_path).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(scanned.records.len(), 10_000);
    println!("10k journal scan: {elapsed:?}");
    #[cfg(not(debug_assertions))]
    {
        let budget = Duration::from_secs(2);
        assert!(
            elapsed < budget,
            "release 10k journal scan took {elapsed:?} with budget {budget:?}"
        );
    }
}

#[test]
fn durable_command_acknowledgement_p95_meets_budget() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("ack-performance.svpvideo");
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.svpvideo"),
        &project_path,
    )
    .unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.mp4"),
        directory.path().join("single-clip.mp4"),
    )
    .unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service.open("perf-owner", &project_path, &grants).unwrap();
    let mut revision = opened.projection.revision.number;
    let mut timings = Vec::new();
    for index in 0..100 {
        let inset = if index % 2 == 0 { 1 } else { 0 };
        let request = CommandGroupRequest {
            group_id: uuid::Uuid::new_v4().hyphenated().to_string(),
            project_id: opened.projection.project_id.clone(),
            base_revision: revision,
            commands: vec![ProjectCommand::TrimClip {
                command_id: uuid::Uuid::new_v4().hyphenated().to_string(),
                sequence_id: "44444444-4444-4444-8444-444444444444".to_owned(),
                track_id: "55555555-5555-4555-8555-555555555555".to_owned(),
                clip_id: "66666666-6666-4666-8666-666666666666".to_owned(),
                source_in: RationalTime {
                    value: inset,
                    rate_numerator: 30,
                    rate_denominator: 1,
                },
                source_out: RationalTime {
                    value: 60 - inset,
                    rate_numerator: 30,
                    rate_denominator: 1,
                },
            }],
        };
        let started = Instant::now();
        let result = service.execute("perf-owner", request, &grants).unwrap();
        timings.push(started.elapsed());
        revision = result.new_revision.number;
    }
    timings.sort();
    let p95 = timings[94];
    println!("durable command acknowledgement p95: {p95:?}");
    let budget = if cfg!(debug_assertions) {
        Duration::from_millis(300)
    } else {
        Duration::from_millis(100)
    };
    assert!(
        p95 < budget,
        "durable command p95 was {p95:?} with budget {budget:?}"
    );
}

#[test]
fn grouped_commands_roll_back_when_a_later_precondition_fails() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    let commands = [ProjectCommand::RemoveMarker {
        command_id: "30000000-0000-4000-8000-000000000002".to_owned(),
        sequence_id: "10000000-0000-4000-8000-000000000006".to_owned(),
        marker_id: "30000000-0000-4000-8000-000000000003".to_owned(),
    }];
    assert!(apply_group(&snapshot.state, &commands).is_err());
    assert_eq!(snapshot.state.sequences[0].markers.len(), 0);
}
