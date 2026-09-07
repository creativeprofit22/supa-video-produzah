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
        with_record_hash, TailClassification, MAX_JOURNAL_LINE_BYTES,
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
        MAX_COMMAND_GROUP_BYTES,
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
        active_caption_artifact: None,
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
            active_caption_artifact: None,
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
const TRACK_VISIBILITY_INITIAL_HASH: &str =
    "39dab5d17c0cf4c45f1aacb4c0659d36861c9d2cebc98ac08e8769a48afa2c9c";
const TRACK_VISIBILITY_HIDDEN_HASH: &str =
    "02e539620c34f39008f66725282fa5de6f4011235f203c588d863f3b0499ce15";

fn clip_opacity_fixture() -> VideoProjectSnapshotV2 {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let mut snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    snapshot.state.sequences[0].tracks[0].clips_mut().unwrap()[0].transform = ClipTransform {
        position_x_permille: -321,
        position_y_permille: 654,
        scale_x_permille: 875,
        scale_y_permille: 1_125,
        rotation_milli_degrees: -45_000,
        opacity_permille: 1_000,
    };
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    validate_snapshot(&snapshot).unwrap();
    snapshot
}

fn projected_clip_transform(state: &VideoProjectStateV2) -> &ClipTransform {
    let sequence = state
        .sequences
        .iter()
        .find(|sequence| sequence.id == RIPPLE_SEQUENCE_ID)
        .unwrap();
    let track = sequence
        .tracks
        .iter()
        .find(|track| track.id() == RIPPLE_TRACK_ID)
        .unwrap();
    &track
        .clips()
        .unwrap()
        .iter()
        .find(|clip| clip.id == "10000000-0000-4000-8000-000000000008")
        .unwrap()
        .transform
}

fn set_clip_opacity_command(command_id: &str, opacity_permille: u16) -> ProjectCommand {
    ProjectCommand::SetClipOpacity {
        command_id: command_id.to_owned(),
        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
        track_id: RIPPLE_TRACK_ID.to_owned(),
        clip_id: "10000000-0000-4000-8000-000000000008".to_owned(),
        opacity_permille,
    }
}

fn set_clip_transform_command(command_id: &str, transform: ClipTransform) -> ProjectCommand {
    ProjectCommand::SetClipTransform {
        command_id: command_id.to_owned(),
        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
        track_id: RIPPLE_TRACK_ID.to_owned(),
        clip_id: "10000000-0000-4000-8000-000000000008".to_owned(),
        transform,
    }
}

fn replacement_clip_transform() -> ClipTransform {
    ClipTransform {
        position_x_permille: 125_000,
        position_y_permille: -250_000,
        scale_x_permille: 1_500,
        scale_y_permille: 750,
        rotation_milli_degrees: 45_000,
        opacity_permille: 1_000,
    }
}

#[test]
fn set_clip_transform_replaces_atomically_and_preserves_clip_siblings() {
    let snapshot = clip_opacity_fixture();
    let original_clip = snapshot.state.sequences[0].tracks[0].clips().unwrap()[0].clone();
    let replacement = replacement_clip_transform();
    let applied = apply_group(
        &snapshot.state,
        &[set_clip_transform_command(
            "69000000-0000-4000-8000-000000000001",
            replacement.clone(),
        )],
    )
    .unwrap();
    let updated_clip = &applied.state.sequences[0].tracks[0].clips().unwrap()[0];

    assert_eq!(updated_clip.transform, replacement);
    assert_eq!(updated_clip.source_in, original_clip.source_in);
    assert_eq!(updated_clip.source_out, original_clip.source_out);
    assert_eq!(updated_clip.timeline_start, original_clip.timeline_start);
    assert_eq!(
        updated_clip.gain_milli_decibels,
        original_clip.gain_milli_decibels
    );
    assert_eq!(applied.summary, "Updated clip transform");
    assert_eq!(
        applied.cache_invalidations,
        vec![CacheInvalidation::Preview, CacheInvalidation::RenderPlan]
    );
    assert!(matches!(
        applied.inverse_commands.as_slice(),
        [ProjectCommand::SetClipTransform { transform, .. }] if transform == &original_clip.transform
    ));
    let restored = apply_group(&applied.state, &applied.inverse_commands).unwrap();
    assert_eq!(restored.state, snapshot.state);
}

#[test]
fn set_clip_transform_rejects_invalid_locked_and_non_video_targets() {
    let snapshot = clip_opacity_fixture();
    let invalid_transforms = [
        ClipTransform {
            position_x_permille: -1_000_001,
            ..replacement_clip_transform()
        },
        ClipTransform {
            position_y_permille: 1_000_001,
            ..replacement_clip_transform()
        },
        ClipTransform {
            scale_x_permille: 0,
            ..replacement_clip_transform()
        },
        ClipTransform {
            scale_y_permille: 1_000_001,
            ..replacement_clip_transform()
        },
        ClipTransform {
            rotation_milli_degrees: 360_000_001,
            ..replacement_clip_transform()
        },
        ClipTransform {
            opacity_permille: 1_001,
            ..replacement_clip_transform()
        },
    ];
    for (index, transform) in invalid_transforms.into_iter().enumerate() {
        let error = apply_group(
            &snapshot.state,
            &[set_clip_transform_command(
                &format!("69000000-0000-4000-8000-{index:012}"),
                transform,
            )],
        )
        .unwrap_err();
        assert_eq!(error.details["category"], "clip_transform");
        assert_eq!(snapshot.state, clip_opacity_fixture().state);
    }

    let mut locked_state = snapshot.state.clone();
    locked_state.sequences[0].tracks[0].set_locked(true);
    let locked_error = apply_group(
        &locked_state,
        &[set_clip_transform_command(
            "69000000-0000-4000-8000-000000000010",
            replacement_clip_transform(),
        )],
    )
    .unwrap_err();
    assert_eq!(locked_error.details["category"], "track_locked");

    let mut audio_state = snapshot.state.clone();
    let video_track = audio_state.sequences[0].tracks.remove(0);
    let ProjectTrack::Video {
        id,
        name,
        locked,
        muted,
        clips,
        ..
    } = video_track
    else {
        unreachable!();
    };
    audio_state.sequences[0].tracks.push(ProjectTrack::Audio {
        id,
        name,
        locked,
        muted,
        clips,
    });
    let non_video_error = apply_group(
        &audio_state,
        &[set_clip_transform_command(
            "69000000-0000-4000-8000-000000000011",
            replacement_clip_transform(),
        )],
    )
    .unwrap_err();
    assert_eq!(non_video_error.details["category"], "non_video_track");
}

#[test]
fn clip_transform_service_projection_has_deterministic_undo_redo_hashes() {
    let snapshot = clip_opacity_fixture();
    let initial_transform = projected_clip_transform(&snapshot.state).clone();
    let initial_hash = snapshot.revision.state_hash.clone();
    let replacement = replacement_clip_transform();
    let mut expected_state = snapshot.state.clone();
    expected_state.sequences[0].tracks[0].clips_mut().unwrap()[0].transform = replacement.clone();
    let expected_hash = state_hash(&expected_state).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("clip-transform-history.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("clip-transform-history-owner", &project_path, &grants)
        .unwrap();
    let project_id = opened.projection.project_id.clone();

    let committed = service
        .execute(
            "clip-transform-history-owner",
            CommandGroupRequest {
                group_id: "69000000-0000-4000-8000-000000000020".to_owned(),
                project_id: project_id.clone(),
                base_revision: 0,
                commands: vec![set_clip_transform_command(
                    "69000000-0000-4000-8000-000000000021",
                    replacement.clone(),
                )],
            },
            &grants,
        )
        .unwrap();
    assert_eq!(committed.state_hash, expected_hash);
    assert_eq!(
        projected_clip_transform(&committed.projection.state),
        &replacement
    );

    let undone = service
        .undo(
            "clip-transform-history-owner",
            &project_id,
            1,
            "69000000-0000-4000-8000-000000000022",
            &grants,
        )
        .unwrap();
    assert_eq!(undone.state_hash, initial_hash);
    assert_eq!(
        projected_clip_transform(&undone.projection.state),
        &initial_transform
    );

    let redone = service
        .redo(
            "clip-transform-history-owner",
            &project_id,
            2,
            "69000000-0000-4000-8000-000000000023",
            &grants,
        )
        .unwrap();
    assert_eq!(redone.state_hash, expected_hash);
    assert_eq!(
        projected_clip_transform(&redone.projection.state),
        &replacement
    );
}

#[test]
fn clip_transform_journal_recovers_projection_after_unclean_reopen() {
    let snapshot = clip_opacity_fixture();
    let replacement = replacement_clip_transform();
    let mut expected_state = snapshot.state.clone();
    expected_state.sequences[0].tracks[0].clips_mut().unwrap()[0].transform = replacement.clone();
    let expected_hash = state_hash(&expected_state).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("clip-transform-recovery.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();

    let project_id = {
        let service = VideoProjectService::default();
        let opened = service
            .open("clip-transform-crash-owner", &project_path, &grants)
            .unwrap();
        let project_id = opened.projection.project_id.clone();
        let committed = service
            .execute(
                "clip-transform-crash-owner",
                CommandGroupRequest {
                    group_id: "69000000-0000-4000-8000-000000000030".to_owned(),
                    project_id: project_id.clone(),
                    base_revision: 0,
                    commands: vec![set_clip_transform_command(
                        "69000000-0000-4000-8000-000000000031",
                        replacement.clone(),
                    )],
                },
                &grants,
            )
            .unwrap();
        assert_eq!(committed.state_hash, expected_hash);
        project_id
    };

    assert_eq!(read_snapshot(&project_path).unwrap().revision.number, 0);
    let reopened = VideoProjectService::default()
        .open("clip-transform-recovery-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 1);
    assert_eq!(reopened.projection.project_id, project_id);
    assert_eq!(reopened.projection.revision.number, 1);
    assert_eq!(reopened.projection.revision.state_hash, expected_hash);
    assert_eq!(reopened.projection.state, expected_state);
    assert_eq!(
        projected_clip_transform(&reopened.projection.state),
        &replacement
    );
    assert!(reopened.projection.can_undo);
}

#[test]
fn set_clip_opacity_deserializes_with_u16_typing() {
    let command: ProjectCommand = serde_json::from_value(serde_json::json!({
        "type": "SetClipOpacity",
        "commandId": "68000000-0000-4000-8000-000000000001",
        "sequenceId": RIPPLE_SEQUENCE_ID,
        "trackId": RIPPLE_TRACK_ID,
        "clipId": "10000000-0000-4000-8000-000000000008",
        "opacityPermille": 1_000,
    }))
    .unwrap();
    assert!(matches!(
        command,
        ProjectCommand::SetClipOpacity {
            opacity_permille: 1_000,
            ..
        }
    ));

    let oversized = serde_json::json!({
        "type": "SetClipOpacity",
        "commandId": "68000000-0000-4000-8000-000000000002",
        "sequenceId": RIPPLE_SEQUENCE_ID,
        "trackId": RIPPLE_TRACK_ID,
        "clipId": "10000000-0000-4000-8000-000000000008",
        "opacityPermille": 65_536,
    });
    assert!(serde_json::from_value::<ProjectCommand>(oversized).is_err());
}

#[test]
fn set_clip_opacity_mutates_only_opacity_and_reports_executor_metadata() {
    let snapshot = clip_opacity_fixture();
    let original_clip = snapshot.state.sequences[0].tracks[0].clips().unwrap()[0].clone();
    let applied = apply_group(
        &snapshot.state,
        &[set_clip_opacity_command(
            "68000000-0000-4000-8000-000000000003",
            0,
        )],
    )
    .unwrap();
    let updated_clip = &applied.state.sequences[0].tracks[0].clips().unwrap()[0];
    let mut expected_clip = original_clip.clone();
    expected_clip.transform.opacity_permille = 0;

    assert_eq!(updated_clip, &expected_clip);
    assert_eq!(applied.summary, "Updated clip opacity");
    assert_eq!(
        applied.cache_invalidations,
        vec![CacheInvalidation::Preview, CacheInvalidation::RenderPlan]
    );
    assert_eq!(
        applied.affected_ranges,
        vec![AffectedRange {
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            start: RationalTime {
                value: 0,
                rate_numerator: 30,
                rate_denominator: 1,
            },
            end: RationalTime {
                value: 30,
                rate_numerator: 30,
                rate_denominator: 1,
            },
        }]
    );
    assert!(matches!(
        applied.inverse_commands.as_slice(),
        [ProjectCommand::SetClipOpacity {
            sequence_id,
            track_id,
            clip_id,
            opacity_permille: 1_000,
            ..
        }] if sequence_id == RIPPLE_SEQUENCE_ID
            && track_id == RIPPLE_TRACK_ID
            && clip_id == "10000000-0000-4000-8000-000000000008"
    ));

    let restored = apply_group(&applied.state, &applied.inverse_commands).unwrap();
    assert_eq!(restored.state, snapshot.state);
    let upper_boundary = apply_group(
        &applied.state,
        &[set_clip_opacity_command(
            "68000000-0000-4000-8000-000000000004",
            1_000,
        )],
    )
    .unwrap();
    assert_eq!(upper_boundary.state, snapshot.state);
}

#[test]
fn set_clip_opacity_rejects_range_locked_and_non_video_targets() {
    let snapshot = clip_opacity_fixture();
    let range_error = apply_group(
        &snapshot.state,
        &[set_clip_opacity_command(
            "68000000-0000-4000-8000-000000000005",
            1_001,
        )],
    )
    .unwrap_err();
    assert_eq!(range_error.details["category"], "opacity_permille");

    let mut locked_state = snapshot.state.clone();
    locked_state.sequences[0].tracks[0].set_locked(true);
    let locked_error = apply_group(
        &locked_state,
        &[set_clip_opacity_command(
            "68000000-0000-4000-8000-000000000006",
            500,
        )],
    )
    .unwrap_err();
    assert_eq!(locked_error.details["category"], "track_locked");

    let mut audio_state = snapshot.state.clone();
    let video_track = audio_state.sequences[0].tracks.remove(0);
    let ProjectTrack::Video {
        id,
        name,
        locked,
        muted,
        clips,
        ..
    } = video_track
    else {
        unreachable!();
    };
    audio_state.sequences[0].tracks.push(ProjectTrack::Audio {
        id,
        name,
        locked,
        muted,
        clips,
    });
    let non_video_error = apply_group(
        &audio_state,
        &[set_clip_opacity_command(
            "68000000-0000-4000-8000-000000000007",
            500,
        )],
    )
    .unwrap_err();
    assert_eq!(non_video_error.details["category"], "non_video_track");
}

#[test]
fn clip_opacity_service_projection_preserves_siblings_and_undo_redo_hashes() {
    let snapshot = clip_opacity_fixture();
    let initial_transform = projected_clip_transform(&snapshot.state).clone();
    let initial_hash = snapshot.revision.state_hash.clone();
    let command = set_clip_opacity_command("68000000-0000-4000-8000-000000000020", 425);
    let mut expected_state = snapshot.state.clone();
    expected_state.sequences[0].tracks[0].clips_mut().unwrap()[0]
        .transform
        .opacity_permille = 425;
    let expected_transform = projected_clip_transform(&expected_state).clone();
    let expected_hash = state_hash(&expected_state).unwrap();
    assert_eq!(expected_transform.opacity_permille, 425);

    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("clip-opacity-history.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("clip-opacity-history-owner", &project_path, &grants)
        .unwrap();
    let project_id = opened.projection.project_id.clone();

    let committed = service
        .execute(
            "clip-opacity-history-owner",
            CommandGroupRequest {
                group_id: "68000000-0000-4000-8000-000000000021".to_owned(),
                project_id: project_id.clone(),
                base_revision: 0,
                commands: vec![command],
            },
            &grants,
        )
        .unwrap();
    assert_eq!(committed.new_revision.number, 1);
    assert_eq!(committed.state_hash, expected_hash);
    assert_eq!(committed.new_revision.state_hash, expected_hash);
    assert_eq!(
        state_hash(&committed.projection.state).unwrap(),
        expected_hash
    );
    assert_eq!(
        projected_clip_transform(&committed.projection.state),
        &expected_transform
    );

    let undone = service
        .undo(
            "clip-opacity-history-owner",
            &project_id,
            1,
            "68000000-0000-4000-8000-000000000022",
            &grants,
        )
        .unwrap();
    assert_eq!(undone.new_revision.number, 2);
    assert_eq!(undone.state_hash, initial_hash);
    assert_eq!(undone.new_revision.state_hash, initial_hash);
    assert_eq!(state_hash(&undone.projection.state).unwrap(), initial_hash);
    assert_eq!(
        projected_clip_transform(&undone.projection.state),
        &initial_transform
    );

    let redone = service
        .redo(
            "clip-opacity-history-owner",
            &project_id,
            2,
            "68000000-0000-4000-8000-000000000023",
            &grants,
        )
        .unwrap();
    assert_eq!(redone.new_revision.number, 3);
    assert_eq!(redone.state_hash, expected_hash);
    assert_eq!(redone.new_revision.state_hash, expected_hash);
    assert_eq!(state_hash(&redone.projection.state).unwrap(), expected_hash);
    assert_eq!(
        projected_clip_transform(&redone.projection.state),
        &expected_transform
    );
}

#[test]
fn clip_opacity_journal_recovers_projection_after_unclean_reopen() {
    let snapshot = clip_opacity_fixture();
    let command = set_clip_opacity_command("68000000-0000-4000-8000-000000000030", 0);
    let mut expected_state = snapshot.state.clone();
    expected_state.sequences[0].tracks[0].clips_mut().unwrap()[0]
        .transform
        .opacity_permille = 0;
    let expected_transform = projected_clip_transform(&expected_state).clone();
    let expected_hash = state_hash(&expected_state).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("clip-opacity-recovery.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();

    let project_id = {
        let service = VideoProjectService::default();
        let opened = service
            .open("clip-opacity-crash-owner", &project_path, &grants)
            .unwrap();
        let project_id = opened.projection.project_id.clone();
        let committed = service
            .execute(
                "clip-opacity-crash-owner",
                CommandGroupRequest {
                    group_id: "68000000-0000-4000-8000-000000000031".to_owned(),
                    project_id: project_id.clone(),
                    base_revision: 0,
                    commands: vec![command],
                },
                &grants,
            )
            .unwrap();
        assert_eq!(committed.state_hash, expected_hash);
        assert_eq!(
            projected_clip_transform(&committed.projection.state),
            &expected_transform
        );
        project_id
    };

    assert_eq!(read_snapshot(&project_path).unwrap().revision.number, 0);
    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("clip-opacity-recovery-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 1);
    assert_eq!(reopened.projection.project_id, project_id);
    assert_eq!(reopened.projection.revision.number, 1);
    assert_eq!(reopened.projection.revision.state_hash, expected_hash);
    assert_eq!(
        state_hash(&reopened.projection.state).unwrap(),
        expected_hash
    );
    assert_eq!(reopened.projection.state, expected_state);
    assert_eq!(
        projected_clip_transform(&reopened.projection.state),
        &expected_transform
    );
    assert!(reopened.projection.can_undo);
}

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
        active_caption_artifact: None,
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
fn caption_track_visibility_uses_its_full_range_when_locked() {
    let mut snapshot = ripple_fixture(1);
    let caption_track_id = "73500000-0000-4000-8000-000000000010".to_owned();
    let time = |value| RationalTime {
        value,
        rate_numerator: 30,
        rate_denominator: 1,
    };
    snapshot.state.sequences[0]
        .tracks
        .push(ProjectTrack::Caption {
            id: caption_track_id.clone(),
            name: "Locked captions".to_owned(),
            locked: true,
            hidden: false,
            active_caption_artifact: None,
            captions: vec![
                ProjectCaption {
                    id: "73500000-0000-4000-8000-000000000011".to_owned(),
                    start: time(12),
                    end: time(17),
                    text: "Later".to_owned(),
                    language: None,
                },
                ProjectCaption {
                    id: "73500000-0000-4000-8000-000000000012".to_owned(),
                    start: time(2),
                    end: time(4),
                    text: "Earlier".to_owned(),
                    language: Some("en".to_owned()),
                },
            ],
        });

    let applied = apply_group(
        &snapshot.state,
        &[ProjectCommand::SetTrackHidden {
            command_id: "73500000-0000-4000-8000-000000000013".to_owned(),
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            track_id: caption_track_id,
            hidden: true,
        }],
    )
    .unwrap();

    assert_eq!(applied.summary, "Hid track");
    assert_eq!(
        applied.cache_invalidations,
        vec![
            CacheInvalidation::Timeline,
            CacheInvalidation::Preview,
            CacheInvalidation::Captions,
            CacheInvalidation::RenderPlan,
        ]
    );
    assert_eq!(
        applied.affected_ranges,
        vec![AffectedRange {
            sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
            start: time(2),
            end: time(17),
        }]
    );
    assert_eq!(applied.state.sequences[0].tracks[2].is_hidden(), Ok(true));
    assert!(applied.state.sequences[0].tracks[2].is_locked());
}

#[test]
fn empty_visual_tracks_have_no_visibility_affected_ranges() {
    let mut snapshot = ripple_fixture(0);
    snapshot.state.sequences[0].tracks[0]
        .clips_mut()
        .unwrap()
        .clear();
    let caption_track_id = "73500000-0000-4000-8000-000000000020".to_owned();
    snapshot.state.sequences[0]
        .tracks
        .push(ProjectTrack::Caption {
            id: caption_track_id.clone(),
            name: "Empty captions".to_owned(),
            locked: false,
            hidden: false,
            captions: vec![],
            active_caption_artifact: None,
        });

    for (index, track_id) in [RIPPLE_TRACK_ID.to_owned(), caption_track_id]
        .into_iter()
        .enumerate()
    {
        let applied = apply_group(
            &snapshot.state,
            &[ProjectCommand::SetTrackHidden {
                command_id: format!("73500000-0000-4000-8000-{:012}", 21_u64 + index as u64),
                sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                track_id,
                hidden: true,
            }],
        )
        .unwrap();
        assert!(applied.affected_ranges.is_empty());
        assert_eq!(applied.summary, "Hid track");
    }
}

#[test]
fn same_value_visibility_and_hidden_state_hashing_are_deterministic() {
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
    assert_eq!(
        state_hash(&snapshot.state).unwrap(),
        TRACK_VISIBILITY_INITIAL_HASH
    );

    let visibility = |command_id: &str, hidden| ProjectCommand::SetTrackHidden {
        command_id: command_id.to_owned(),
        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
        track_id: RIPPLE_TRACK_ID.to_owned(),
        hidden,
    };
    let same_visible = apply_group(
        &snapshot.state,
        &[visibility("73500000-0000-4000-8000-000000000029", false)],
    )
    .unwrap();
    let first = apply_group(
        &snapshot.state,
        &[visibility("73500000-0000-4000-8000-000000000030", true)],
    )
    .unwrap();
    let independent = apply_group(
        &snapshot.state,
        &[visibility("73500000-0000-4000-8000-000000000030", true)],
    )
    .unwrap();
    let same_hidden = apply_group(
        &first.state,
        &[visibility("73500000-0000-4000-8000-000000000032", true)],
    )
    .unwrap();

    assert_eq!(same_visible.state, snapshot.state);
    assert_eq!(
        state_hash(&same_visible.state).unwrap(),
        TRACK_VISIBILITY_INITIAL_HASH
    );
    assert!(matches!(
        same_visible.inverse_commands.as_slice(),
        [ProjectCommand::SetTrackHidden { hidden: false, .. }]
    ));
    assert_eq!(first.state, independent.state);
    assert_eq!(first.inverse_commands, independent.inverse_commands);
    assert_eq!(first.summary, independent.summary);
    assert_eq!(first.affected_ranges, independent.affected_ranges);
    assert_eq!(first.cache_invalidations, independent.cache_invalidations);
    assert_eq!(
        state_hash(&first.state).unwrap(),
        TRACK_VISIBILITY_HIDDEN_HASH
    );
    assert_eq!(
        state_hash(&independent.state).unwrap(),
        TRACK_VISIBILITY_HIDDEN_HASH
    );
    assert_eq!(same_hidden.state, first.state);
    assert_eq!(
        state_hash(&same_hidden.state).unwrap(),
        TRACK_VISIBILITY_HIDDEN_HASH
    );
    assert!(matches!(
        same_hidden.inverse_commands.as_slice(),
        [ProjectCommand::SetTrackHidden { hidden: true, .. }]
    ));
    let same_hidden_inverse =
        apply_group(&same_hidden.state, &same_hidden.inverse_commands).unwrap();
    assert_eq!(
        state_hash(&same_hidden_inverse.state).unwrap(),
        TRACK_VISIBILITY_HIDDEN_HASH
    );
}

#[test]
fn audio_visibility_rejection_is_atomic_across_service_and_persistence() {
    let mut snapshot = ripple_fixture(1);
    let sequence = &mut snapshot.state.sequences[0];
    let visual_track_id = sequence.tracks[1].id().to_owned();
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
    let audio_track_id = id.clone();
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
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    validate_snapshot(&snapshot).unwrap();
    let original_state = snapshot.state.clone();
    let original_hash = snapshot.revision.state_hash.clone();

    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("audio-visibility-rejection.svpvideo");
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("audio-visibility-owner", &project_path, &grants)
        .unwrap();
    let project_id = opened.projection.project_id.clone();

    let error = service
        .execute(
            "audio-visibility-owner",
            CommandGroupRequest {
                group_id: "73500000-0000-4000-8000-000000000040".to_owned(),
                project_id: project_id.clone(),
                base_revision: 0,
                commands: vec![
                    ProjectCommand::SetTrackHidden {
                        command_id: "73500000-0000-4000-8000-000000000041".to_owned(),
                        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                        track_id: visual_track_id,
                        hidden: true,
                    },
                    ProjectCommand::SetTrackHidden {
                        command_id: "73500000-0000-4000-8000-000000000042".to_owned(),
                        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                        track_id: audio_track_id,
                        hidden: true,
                    },
                ],
            },
            &grants,
        )
        .unwrap_err();
    assert_eq!(error.details["category"], "non_visual_track");
    assert_eq!(
        service
            .inspector("audio-visibility-owner", &project_id)
            .unwrap()
            .revision
            .number,
        0
    );
    service
        .close("audio-visibility-owner", &project_id)
        .unwrap();

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("audio-visibility-reopen-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.projection.revision.number, 0);
    assert_eq!(reopened.projection.revision.state_hash, original_hash);
    assert_eq!(reopened.projection.state, original_state);
}

#[test]
fn visibility_save_reopen_and_undo_redo_preserve_exact_hashes_and_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("track-visibility.svpvideo");
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    fs::copy(fixture_path, &project_path).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let opened = service
        .open("visibility-owner", &project_path, &grants)
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
            value: 30,
            rate_numerator: 30,
            rate_denominator: 1,
        },
    };
    let expected_invalidations = vec![
        CacheInvalidation::Timeline,
        CacheInvalidation::Preview,
        CacheInvalidation::Captions,
        CacheInvalidation::RenderPlan,
    ];

    let committed = service
        .execute(
            "visibility-owner",
            CommandGroupRequest {
                group_id: "73500000-0000-4000-8000-000000000050".to_owned(),
                project_id: project_id.clone(),
                base_revision: 0,
                commands: vec![ProjectCommand::SetTrackHidden {
                    command_id: "73500000-0000-4000-8000-000000000051".to_owned(),
                    sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                    track_id: RIPPLE_TRACK_ID.to_owned(),
                    hidden: true,
                }],
            },
            &grants,
        )
        .unwrap();
    assert_eq!(committed.state_hash, TRACK_VISIBILITY_HIDDEN_HASH);
    assert_eq!(committed.affected_ranges, vec![expected_range.clone()]);
    assert_eq!(committed.cache_invalidations, expected_invalidations);
    assert_eq!(
        committed.projection.last_command.as_ref().unwrap().summary,
        "Hid track"
    );

    let undone = service
        .undo(
            "visibility-owner",
            &project_id,
            1,
            "73500000-0000-4000-8000-000000000052",
            &grants,
        )
        .unwrap();
    assert_eq!(undone.state_hash, TRACK_VISIBILITY_INITIAL_HASH);
    assert_eq!(undone.affected_ranges, vec![expected_range.clone()]);
    assert_eq!(
        undone.cache_invalidations,
        vec![
            CacheInvalidation::Timeline,
            CacheInvalidation::Preview,
            CacheInvalidation::Captions,
            CacheInvalidation::RenderPlan,
        ]
    );
    assert_eq!(
        undone.projection.last_command.as_ref().unwrap().summary,
        "Undid Hid track"
    );

    let redone = service
        .redo(
            "visibility-owner",
            &project_id,
            2,
            "73500000-0000-4000-8000-000000000053",
            &grants,
        )
        .unwrap();
    assert_eq!(redone.state_hash, TRACK_VISIBILITY_HIDDEN_HASH);
    assert_eq!(redone.affected_ranges, vec![expected_range]);
    assert_eq!(
        redone.cache_invalidations,
        vec![
            CacheInvalidation::Timeline,
            CacheInvalidation::Preview,
            CacheInvalidation::Captions,
            CacheInvalidation::RenderPlan,
        ]
    );
    assert_eq!(
        redone.projection.last_command.as_ref().unwrap().summary,
        "Redid Hid track"
    );
    service.close("visibility-owner", &project_id).unwrap();

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("visibility-reopen-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.projection.revision.number, 3);
    assert_eq!(
        reopened.projection.revision.state_hash,
        TRACK_VISIBILITY_HIDDEN_HASH
    );
    assert_eq!(
        state_hash(&reopened.projection.state).unwrap(),
        TRACK_VISIBILITY_HIDDEN_HASH
    );
    assert_eq!(
        reopened.projection.state.sequences[0].tracks[0].is_hidden(),
        Ok(true)
    );
}

#[test]
fn visibility_journal_recovers_exact_state_without_clean_close() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("visibility-recovery.svpvideo");
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    fs::copy(fixture_path, &project_path).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let project_id = {
        let service = VideoProjectService::default();
        let opened = service
            .open("visibility-recovery-owner", &project_path, &grants)
            .unwrap();
        let project_id = opened.projection.project_id.clone();
        let committed = service
            .execute(
                "visibility-recovery-owner",
                CommandGroupRequest {
                    group_id: "73500000-0000-4000-8000-000000000060".to_owned(),
                    project_id: project_id.clone(),
                    base_revision: 0,
                    commands: vec![ProjectCommand::SetTrackHidden {
                        command_id: "73500000-0000-4000-8000-000000000061".to_owned(),
                        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                        track_id: RIPPLE_TRACK_ID.to_owned(),
                        hidden: true,
                    }],
                },
                &grants,
            )
            .unwrap();
        assert_eq!(committed.state_hash, TRACK_VISIBILITY_HIDDEN_HASH);
        project_id
    };

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("visibility-recovery-reopen-owner", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 1);
    assert_eq!(reopened.projection.project_id, project_id);
    assert_eq!(reopened.projection.revision.number, 1);
    assert_eq!(
        reopened.projection.revision.state_hash,
        TRACK_VISIBILITY_HIDDEN_HASH
    );
    assert_eq!(
        reopened.projection.last_command.as_ref().unwrap().summary,
        "Hid track"
    );
    assert_eq!(
        reopened.projection.state.sequences[0].tracks[0].is_hidden(),
        Ok(true)
    );

    let retried = reopened_service
        .execute(
            "visibility-recovery-reopen-owner",
            CommandGroupRequest {
                group_id: "73500000-0000-4000-8000-000000000060".to_owned(),
                project_id,
                base_revision: 0,
                commands: vec![ProjectCommand::SetTrackHidden {
                    command_id: "73500000-0000-4000-8000-000000000061".to_owned(),
                    sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                    track_id: RIPPLE_TRACK_ID.to_owned(),
                    hidden: true,
                }],
            },
            &grants,
        )
        .unwrap();
    assert_eq!(retried.projection.revision.number, 1);
    assert_eq!(retried.state_hash, TRACK_VISIBILITY_HIDDEN_HASH);
    assert_eq!(retried.affected_ranges.len(), 1);
    assert_eq!(
        retried.cache_invalidations,
        vec![
            CacheInvalidation::Timeline,
            CacheInvalidation::Preview,
            CacheInvalidation::Captions,
            CacheInvalidation::RenderPlan,
        ]
    );
    assert_eq!(
        retried.projection.last_command.as_ref().unwrap().summary,
        "Hid track"
    );
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
            active_caption_artifact: None,
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
fn transcript_edit_group_applies_undoes_and_rejects_stale_revision() {
    const ORIGINAL_CLIP_ID: &str = "10000000-0000-4000-8000-000000000008";
    const MIDDLE_CLIP_ID: &str = "76000000-0000-4000-8000-000000000003";
    const TAIL_CLIP_ID: &str = "76000000-0000-4000-8000-000000000005";

    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("transcript-edit.svpvideo");
    fs::copy(fixture, &project_path).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    let owner = "transcript-edit-owner";
    let opened = service.open(owner, &project_path, &grants).unwrap();
    let project_id = opened.projection.project_id.clone();
    let original_state = opened.projection.state.clone();
    let original_hash = opened.projection.revision.state_hash.clone();
    let source_time = |value| RationalTime {
        value,
        rate_numerator: 30,
        rate_denominator: 1,
    };

    let committed = service
        .execute(
            owner,
            CommandGroupRequest {
                group_id: "76000000-0000-4000-8000-000000000001".to_owned(),
                project_id: project_id.clone(),
                base_revision: 0,
                commands: vec![
                    ProjectCommand::SplitClip {
                        command_id: "76000000-0000-4000-8000-000000000002".to_owned(),
                        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                        track_id: RIPPLE_TRACK_ID.to_owned(),
                        clip_id: ORIGINAL_CLIP_ID.to_owned(),
                        split_at: source_time(10),
                        right_clip_id: MIDDLE_CLIP_ID.to_owned(),
                    },
                    ProjectCommand::SplitClip {
                        command_id: "76000000-0000-4000-8000-000000000004".to_owned(),
                        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                        track_id: RIPPLE_TRACK_ID.to_owned(),
                        clip_id: MIDDLE_CLIP_ID.to_owned(),
                        split_at: source_time(20),
                        right_clip_id: TAIL_CLIP_ID.to_owned(),
                    },
                    ProjectCommand::RippleDeleteClip {
                        command_id: "76000000-0000-4000-8000-000000000006".to_owned(),
                        sequence_id: RIPPLE_SEQUENCE_ID.to_owned(),
                        track_id: RIPPLE_TRACK_ID.to_owned(),
                        clip_id: MIDDLE_CLIP_ID.to_owned(),
                    },
                ],
            },
            &grants,
        )
        .unwrap();

    assert_eq!(committed.new_revision.number, 1);
    let clips = committed.projection.state.sequences[0].tracks[0]
        .clips()
        .unwrap();
    assert_eq!(
        clips
            .iter()
            .map(|clip| (
                clip.id.as_str(),
                clip.source_in.value,
                clip.source_out.value,
                clip.timeline_start.value,
            ))
            .collect::<Vec<_>>(),
        vec![(ORIGINAL_CLIP_ID, 0, 10, 0), (TAIL_CLIP_ID, 20, 30, 10)]
    );
    let first_timeline_end =
        clips[0].timeline_start.value + (clips[0].source_out.value - clips[0].source_in.value);
    assert_eq!(first_timeline_end, clips[1].timeline_start.value);

    let stale_error = service
        .execute(
            owner,
            CommandGroupRequest {
                group_id: "76000000-0000-4000-8000-000000000007".to_owned(),
                project_id: project_id.clone(),
                base_revision: 0,
                commands: vec![set_clip_opacity_command(
                    "76000000-0000-4000-8000-000000000008",
                    500,
                )],
            },
            &grants,
        )
        .unwrap_err();
    assert_eq!(
        stale_error.code,
        crate::video::error::VideoErrorCode::StaleRevision
    );
    assert_eq!(stale_error.details["category"], "base_revision");

    let undone = service
        .undo(
            owner,
            &project_id,
            committed.new_revision.number,
            "76000000-0000-4000-8000-000000000009",
            &grants,
        )
        .unwrap();
    assert_eq!(undone.projection.state, original_state);
    assert_eq!(undone.state_hash, original_hash);
    assert_eq!(undone.projection.revision.state_hash, original_hash);
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
fn v1_migration_preserves_track_defaults_and_resets_history() {
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
    assert!(migrated.state.sequences[0]
        .tracks
        .iter()
        .all(|track| track.is_hidden() == Ok(false)));
    let migrated_track_json = serde_json::to_value(&migrated.state.sequences[0].tracks[0]).unwrap();
    assert!(migrated_track_json.get("locked").is_none());
    assert!(migrated_track_json.get("muted").is_none());
    assert!(migrated_track_json.get("hidden").is_none());
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

const CAPTION_PROJECT_ID: &str = "11111111-1111-4111-8111-111111111111";
const CAPTION_SEQUENCE_ID: &str = "33333333-3333-4333-8333-333333333333";
const CAPTION_TRACK_ID: &str = "44444444-4444-4444-8444-444444444444";
const TRIM_CAPTION_SOURCE_TRACK_ID: &str = "10000000-0000-4000-8000-000000000007";
const TRIM_CAPTION_CLIP_ID: &str = "10000000-0000-4000-8000-000000000008";

fn caption_artifact_fixture() -> crate::video::caption::CaptionArtifactV1 {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-media/fixtures/caption-artifact-v1.json");
    crate::video::caption::parse_caption_artifact(&fs::read(path).unwrap()).unwrap()
}

fn caption_project_fixture() -> VideoProjectSnapshotV2 {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures/project-v2/valid-minimal.svpvideo");
    let mut snapshot: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    snapshot.id = CAPTION_PROJECT_ID.to_owned();
    snapshot
        .state
        .sequences
        .push(super::types::VideoSequenceV2 {
            id: CAPTION_SEQUENCE_ID.to_owned(),
            name: "Caption sequence".to_owned(),
            rate: crate::video::types::RationalRate {
                numerator: 24,
                denominator: 1,
            },
            width: 1_920,
            height: 1_080,
            audio_sample_rate: 48_000,
            tracks: vec![ProjectTrack::Caption {
                id: CAPTION_TRACK_ID.to_owned(),
                name: "Captions".to_owned(),
                locked: false,
                hidden: false,
                captions: vec![ProjectCaption {
                    id: "88888888-8888-4888-8888-888888888888".to_owned(),
                    start: RationalTime {
                        value: 0,
                        rate_numerator: 24,
                        rate_denominator: 1,
                    },
                    end: RationalTime {
                        value: 30,
                        rate_numerator: 24,
                        rate_denominator: 1,
                    },
                    text: "Legacy caption remains independent".to_owned(),
                    language: Some("en".to_owned()),
                }],
                active_caption_artifact: None,
            }],
            markers: vec![],
        });
    snapshot.state.active_sequence_id = Some(CAPTION_SEQUENCE_ID.to_owned());
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    snapshot
}

fn trim_caption_project_fixture() -> VideoProjectSnapshotV2 {
    let mut snapshot = caption_project_fixture();
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo",
    );
    let mut source: VideoProjectSnapshotV2 =
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    snapshot.state.assets.append(&mut source.state.assets);
    let mut source_track = source.state.sequences[0].tracks.remove(0);
    let ProjectTrack::Video { clips, .. } = &mut source_track else {
        panic!("source fixture video track")
    };
    clips[0].timeline_start = RationalTime {
        value: 0,
        rate_numerator: 24,
        rate_denominator: 1,
    };
    snapshot.state.sequences[0].tracks.push(source_track);
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    validate_snapshot(&snapshot).unwrap();
    snapshot
}

fn trim_caption_clip(state: &VideoProjectStateV2) -> &ProjectClip {
    let ProjectTrack::Video { clips, .. } = &state.sequences[0].tracks[1] else {
        panic!("trim caption video track")
    };
    &clips[0]
}

fn caption_artifact_for(
    snapshot: &VideoProjectSnapshotV2,
    variant: &str,
) -> crate::video::caption::CaptionArtifactV1 {
    let mut artifact = caption_artifact_fixture();
    artifact.track_link.project_id = snapshot.id.clone();
    artifact.track_link.project_revision = snapshot.revision.clone();
    artifact.track_link.sequence_id = CAPTION_SEQUENCE_ID.to_owned();
    artifact.track_link.caption_track_id = CAPTION_TRACK_ID.to_owned();
    if variant == "B" {
        artifact.language = "en-US".to_owned();
    }
    artifact
}

fn large_caption_artifact_for(
    snapshot: &VideoProjectSnapshotV2,
    cue_count: u64,
) -> crate::video::caption::CaptionArtifactV1 {
    let mut artifact = caption_artifact_for(snapshot, "A");
    let template = artifact.cues[0].clone();
    artifact.cues = (0..cue_count)
        .map(|index| {
            let mut cue = template.clone();
            cue.cue_id = format!("caption-{index:06}");
            cue.start.value = index * 24;
            cue.end.value = (index + 1) * 24;
            cue.lines = vec!["Boundary caption".to_owned()];
            cue.source_links[0].source_start_us = index * 1_000_000;
            cue.source_links[0].source_end_us = (index + 1) * 1_000_000;
            cue.source_links[0].transcript_word_ids = vec![format!("word-{index:06}")];
            cue
        })
        .collect();
    artifact
}

fn active_caption_artifact(
    state: &VideoProjectStateV2,
) -> Option<&crate::video::caption::CaptionArtifactV1> {
    let ProjectTrack::Caption {
        active_caption_artifact,
        ..
    } = &state.sequences[0].tracks[0]
    else {
        panic!("caption track")
    };
    active_caption_artifact.as_ref()
}

fn caption_request(
    snapshot: &VideoProjectSnapshotV2,
    group_id: &str,
    artifact: crate::video::caption::CaptionArtifactV1,
) -> CommandGroupRequest {
    CommandGroupRequest {
        group_id: group_id.to_owned(),
        project_id: snapshot.id.clone(),
        base_revision: snapshot.revision.number,
        commands: vec![ProjectCommand::ApplyCaptionArtifact {
            command_id: group_id.to_owned(),
            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
            track_id: CAPTION_TRACK_ID.to_owned(),
            artifact,
        }],
    }
}

#[test]
fn caption_artifact_optional_fields_require_omission_instead_of_null() {
    let snapshot = caption_project_fixture();
    let track_json = serde_json::to_value(&snapshot.state.sequences[0].tracks[0]).unwrap();
    assert!(track_json.get("activeCaptionArtifact").is_none());

    let omitted_track: ProjectTrack = serde_json::from_value(track_json.clone()).unwrap();
    let ProjectTrack::Caption {
        active_caption_artifact,
        ..
    } = &omitted_track
    else {
        unreachable!();
    };
    assert_eq!(active_caption_artifact, &None);
    assert!(serde_json::to_value(&omitted_track)
        .unwrap()
        .get("activeCaptionArtifact")
        .is_none());

    let mut null_track = track_json;
    null_track["activeCaptionArtifact"] = Value::Null;
    assert!(serde_json::from_value::<ProjectTrack>(null_track).is_err());

    let command_json = serde_json::json!({
        "type": "RestoreActiveCaptionArtifact",
        "commandId": "80000000-0000-4000-8000-000000000001",
        "sequenceId": CAPTION_SEQUENCE_ID,
        "trackId": CAPTION_TRACK_ID,
    });
    let omitted_command: ProjectCommand = serde_json::from_value(command_json.clone()).unwrap();
    let ProjectCommand::RestoreActiveCaptionArtifact { artifact, .. } = &omitted_command else {
        unreachable!();
    };
    assert_eq!(artifact, &None);
    assert!(serde_json::to_value(&omitted_command)
        .unwrap()
        .get("artifact")
        .is_none());

    let mut null_command = command_json;
    null_command["artifact"] = Value::Null;
    assert!(serde_json::from_value::<ProjectCommand>(null_command).is_err());
}

#[test]
fn caption_artifact_install_replace_undo_redo_is_exact_and_deterministic() {
    let initial = caption_project_fixture();
    let legacy = initial.state.sequences[0].tracks[0].clone();
    let artifact_a = caption_artifact_for(&initial, "A");
    let install = commit_transition(
        &initial,
        &caption_request(
            &initial,
            "81000000-0000-4000-8000-000000000001",
            artifact_a.clone(),
        ),
        "2026-08-08T00:00:01Z",
    )
    .unwrap();
    assert_eq!(
        active_caption_artifact(&install.snapshot.state),
        Some(&artifact_a)
    );
    assert_eq!(install.applied.summary, "Apply caption artifact");
    assert!(install.applied.affected_ranges.is_empty());
    assert_eq!(
        install.applied.cache_invalidations,
        vec![CacheInvalidation::Captions, CacheInvalidation::RenderPlan]
    );
    let ProjectTrack::Caption {
        captions: before, ..
    } = &legacy
    else {
        unreachable!()
    };
    let ProjectTrack::Caption {
        captions: after, ..
    } = &install.snapshot.state.sequences[0].tracks[0]
    else {
        unreachable!()
    };
    assert_eq!(after, before);
    let artifact_b = caption_artifact_for(&install.snapshot, "B");
    assert_eq!(
        artifact_b.track_link.project_revision,
        install.snapshot.revision
    );
    let replace = commit_transition(
        &install.snapshot,
        &caption_request(
            &install.snapshot,
            "81000000-0000-4000-8000-000000000002",
            artifact_b.clone(),
        ),
        "2026-08-08T00:00:02Z",
    )
    .unwrap();
    assert_eq!(
        active_caption_artifact(&replace.snapshot.state),
        Some(&artifact_b)
    );
    assert_eq!(replace.applied.summary, "Apply caption artifact");
    assert!(replace.applied.affected_ranges.is_empty());
    assert_eq!(
        replace.applied.cache_invalidations,
        vec![CacheInvalidation::Captions, CacheInvalidation::RenderPlan]
    );
    let repeated_replace = commit_transition(
        &install.snapshot,
        &caption_request(
            &install.snapshot,
            "81000000-0000-4000-8000-000000000002",
            artifact_b.clone(),
        ),
        "2026-08-08T00:00:02Z",
    )
    .unwrap();
    assert_eq!(
        repeated_replace.snapshot.revision.state_hash,
        replace.snapshot.revision.state_hash
    );
    let undo = undo_transition(
        &replace.snapshot,
        2,
        "81000000-0000-4000-8000-000000000003",
        "2026-08-08T00:00:03Z",
    )
    .unwrap();
    let redo = redo_transition(
        &undo.snapshot,
        3,
        "81000000-0000-4000-8000-000000000004",
        "2026-08-08T00:00:04Z",
    )
    .unwrap();
    assert_eq!(
        active_caption_artifact(&undo.snapshot.state),
        Some(&artifact_a)
    );
    assert_eq!(undo.history_group.summary, "Apply caption artifact");
    assert_eq!(undo.applied.summary, "Restore active caption artifact");
    assert!(undo.applied.affected_ranges.is_empty());
    assert_eq!(
        undo.applied.cache_invalidations,
        vec![CacheInvalidation::Captions, CacheInvalidation::RenderPlan]
    );
    assert_eq!(
        active_caption_artifact(&redo.snapshot.state),
        Some(&artifact_b)
    );
    assert_eq!(redo.history_group.summary, "Apply caption artifact");
    assert_eq!(redo.applied.summary, "Apply caption artifact");
    assert!(redo.applied.affected_ranges.is_empty());
    assert_eq!(
        redo.applied.cache_invalidations,
        vec![CacheInvalidation::Captions, CacheInvalidation::RenderPlan]
    );
    assert_eq!(
        [
            install.snapshot.revision.number,
            replace.snapshot.revision.number,
            undo.snapshot.revision.number,
            redo.snapshot.revision.number
        ],
        [1, 2, 3, 4]
    );
    assert_eq!(
        undo.snapshot.revision.state_hash,
        install.snapshot.revision.state_hash
    );
    assert_eq!(
        redo.snapshot.revision.state_hash,
        replace.snapshot.revision.state_hash
    );
    assert_eq!(
        state_hash(&replace.snapshot.state).unwrap(),
        replace.snapshot.revision.state_hash
    );
}

#[test]
fn caption_artifact_rejection_matrix_is_atomic() {
    let initial = caption_project_fixture();
    let artifact_a = caption_artifact_for(&initial, "A");
    let installed = commit_transition(
        &initial,
        &caption_request(&initial, "82000000-0000-4000-8000-000000000001", artifact_a),
        "2026-08-08T00:01:00Z",
    )
    .unwrap()
    .snapshot;
    let baseline = (
        installed.revision.clone(),
        installed.revision.state_hash.clone(),
        active_caption_artifact(&installed.state).cloned(),
    );
    let valid_b = caption_artifact_for(&installed, "B");
    let mut cases = Vec::new();
    let mut stale = caption_request(
        &installed,
        "82000000-0000-4000-8000-000000000010",
        valid_b.clone(),
    );
    stale.base_revision -= 1;
    cases.push(("stale base", installed.clone(), stale));
    for mutate in 0_u8..11 {
        let mut artifact = valid_b.clone();
        match mutate {
            0 => artifact.track_link.project_id = "99999999-9999-4999-8999-999999999999".to_owned(),
            1 => artifact.track_link.project_revision.number += 1,
            2 => {
                artifact.track_link.project_revision.id =
                    "99999999-9999-4999-8999-999999999999".to_owned()
            }
            3 => {
                artifact.track_link.project_revision.parent_id =
                    Some("99999999-9999-4999-8999-999999999998".to_owned())
            }
            4 => {
                artifact.track_link.project_revision.committed_at =
                    "2026-08-08T00:00:59Z".to_owned()
            }
            5 => {
                artifact.track_link.project_revision.operation_id =
                    "99999999-9999-4999-8999-999999999997".to_owned()
            }
            6 => artifact.track_link.project_revision.state_hash = "f".repeat(64),
            7 => {
                artifact.track_link.sequence_id = "99999999-9999-4999-8999-999999999996".to_owned()
            }
            8 => {
                artifact.track_link.caption_track_id =
                    "99999999-9999-4999-8999-999999999995".to_owned()
            }
            9 => artifact.timeline_rate.numerator = 25,
            10 => artifact.cues[0].lines.clear(),
            _ => unreachable!(),
        }
        cases.push((
            "artifact metadata/semantic",
            installed.clone(),
            caption_request(
                &installed,
                &format!("82000000-0000-4000-8000-{number:012}", number = 20 + mutate),
                artifact,
            ),
        ));
    }
    for (name, sequence_id, track_id) in [
        (
            "missing target",
            "99999999-9999-4999-8999-999999999996",
            CAPTION_TRACK_ID,
        ),
        (
            "missing track",
            CAPTION_SEQUENCE_ID,
            "99999999-9999-4999-8999-999999999995",
        ),
        (
            "wrong kind",
            CAPTION_SEQUENCE_ID,
            "99999999-9999-4999-8999-999999999994",
        ),
    ] {
        let mut snapshot = installed.clone();
        if name == "wrong kind" {
            snapshot.state.sequences[0]
                .tracks
                .push(ProjectTrack::Video {
                    id: track_id.to_owned(),
                    name: "video".to_owned(),
                    locked: false,
                    muted: false,
                    hidden: false,
                    clips: vec![],
                });
        }
        snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
        let mut artifact = caption_artifact_for(&snapshot, "B");
        artifact.track_link.sequence_id = sequence_id.to_owned();
        artifact.track_link.caption_track_id = track_id.to_owned();
        let mut request =
            caption_request(&snapshot, "82000000-0000-4000-8000-000000000030", artifact);
        let ProjectCommand::ApplyCaptionArtifact {
            sequence_id: command_sequence,
            track_id: command_track,
            ..
        } = &mut request.commands[0]
        else {
            unreachable!()
        };
        *command_sequence = sequence_id.to_owned();
        *command_track = track_id.to_owned();
        cases.push((name, snapshot, request));
    }
    let mut locked = installed.clone();
    locked.state.sequences[0].tracks[0].set_locked(true);
    locked.revision.state_hash = state_hash(&locked.state).unwrap();
    let locked_artifact = caption_artifact_for(&locked, "B");
    cases.push((
        "locked",
        locked.clone(),
        caption_request(
            &locked,
            "82000000-0000-4000-8000-000000000031",
            locked_artifact,
        ),
    ));
    for (name, snapshot, request) in cases {
        let before = (
            snapshot.revision.clone(),
            snapshot.revision.state_hash.clone(),
            active_caption_artifact(&snapshot.state).cloned(),
        );
        assert!(
            commit_transition(&snapshot, &request, "2026-08-08T00:01:01Z").is_err(),
            "{name}"
        );
        assert_eq!(
            (
                snapshot.revision.clone(),
                snapshot.revision.state_hash.clone(),
                active_caption_artifact(&snapshot.state).cloned()
            ),
            before,
            "{name}"
        );
    }
    assert_eq!(
        (
            installed.revision.clone(),
            installed.revision.state_hash.clone(),
            active_caption_artifact(&installed.state).cloned()
        ),
        baseline
    );
}

#[test]
fn caption_artifact_checkpoint_and_journal_recovery_preserve_provenance_and_history() {
    for (name, clean_close) in [("checkpoint", true), ("journal-crash", false)] {
        let directory = tempfile::tempdir().unwrap();
        let project_path = directory.path().join(format!("{name}.svpvideo"));
        let initial = caption_project_fixture();
        fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
        let grants = crate::video::VideoPathGrants::default();
        let (artifact_a, artifact_b, hash_b, project_id) = {
            let service = VideoProjectService::default();
            let opened = service.open(name, &project_path, &grants).unwrap();
            let project_id = opened.projection.project_id;
            let artifact_a = caption_artifact_for(&initial, "A");
            let a = service
                .execute(
                    name,
                    caption_request(
                        &initial,
                        "83000000-0000-4000-8000-000000000001",
                        artifact_a.clone(),
                    ),
                    &grants,
                )
                .unwrap();
            let mut after_a = initial.clone();
            after_a.revision = a.new_revision;
            after_a.state = a.projection.state;
            let artifact_b = caption_artifact_for(&after_a, "B");
            let b = service
                .execute(
                    name,
                    caption_request(
                        &after_a,
                        "83000000-0000-4000-8000-000000000002",
                        artifact_b.clone(),
                    ),
                    &grants,
                )
                .unwrap();
            if clean_close {
                service.close(name, &project_id).unwrap();
            }
            (artifact_a, artifact_b, b.state_hash, project_id)
        };
        let service = VideoProjectService::default();
        let owner = format!("{name}-reopen");
        let reopened = service.open(&owner, &project_path, &grants).unwrap();
        assert_eq!(
            (
                reopened.projection.revision.number,
                &reopened.projection.revision.state_hash
            ),
            (2, &hash_b)
        );
        assert_eq!(
            active_caption_artifact(&reopened.projection.state),
            Some(&artifact_b)
        );
        assert!(reopened.projection.can_undo);
        if !clean_close {
            assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
            assert_eq!(reopened.recovery.replayed_record_count, 2);
        }
        let undone = service
            .undo(
                &owner,
                &project_id,
                2,
                "83000000-0000-4000-8000-000000000003",
                &grants,
            )
            .unwrap();
        assert_eq!(
            active_caption_artifact(&undone.projection.state),
            Some(&artifact_a)
        );
        assert!(undone.projection.can_redo);
        let redone = service
            .redo(
                &owner,
                &project_id,
                3,
                "83000000-0000-4000-8000-000000000004",
                &grants,
            )
            .unwrap();
        assert_eq!(redone.state_hash, hash_b);
        assert_eq!(
            active_caption_artifact(&redone.projection.state),
            Some(&artifact_b)
        );
    }
}

#[test]
fn move_clip_caption_lifecycle_is_atomic_across_history_recovery_and_checkpoint() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("move-caption-lifecycle.svpvideo");
    let initial = trim_caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let owner = "move-caption-owner";
    let journal = journal_path(&project_path).unwrap();

    let (artifact_a, artifact_b, forward_commands, moved_state, moved_hash) = {
        let service = VideoProjectService::default();
        service.open(owner, &project_path, &grants).unwrap();

        let artifact_a = caption_artifact_for(&initial, "A");
        let installed = service
            .execute(
                owner,
                caption_request(
                    &initial,
                    "89200000-0000-4000-8000-000000000001",
                    artifact_a.clone(),
                ),
                &grants,
            )
            .unwrap();
        let state_after_install = installed.projection.state.clone();
        let hash_after_install = installed.state_hash.clone();
        let mut after_install = initial.clone();
        after_install.revision = installed.new_revision.clone();
        after_install.state = state_after_install.clone();
        let mut artifact_b = caption_artifact_for(&after_install, "B");
        for cue in &mut artifact_b.cues {
            cue.start.value += 12;
            cue.end.value += 12;
        }
        let forward_commands = vec![
            ProjectCommand::MoveClip {
                command_id: "89200000-0000-4000-8000-000000000002".to_owned(),
                sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
                clip_id: TRIM_CAPTION_CLIP_ID.to_owned(),
                timeline_start: RationalTime {
                    value: 12,
                    rate_numerator: 24,
                    rate_denominator: 1,
                },
            },
            ProjectCommand::ApplyCaptionArtifact {
                command_id: "89200000-0000-4000-8000-000000000003".to_owned(),
                sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                track_id: CAPTION_TRACK_ID.to_owned(),
                artifact: artifact_b.clone(),
            },
        ];
        let moved = service
            .execute(
                owner,
                CommandGroupRequest {
                    group_id: "89200000-0000-4000-8000-000000000004".to_owned(),
                    project_id: initial.id.clone(),
                    base_revision: 1,
                    commands: forward_commands.clone(),
                },
                &grants,
            )
            .unwrap();
        assert_eq!(
            (moved.prior_revision.number, moved.new_revision.number),
            (1, 2)
        );
        assert_eq!(
            trim_caption_clip(&moved.projection.state)
                .timeline_start
                .value,
            12
        );
        assert_eq!(
            active_caption_artifact(&moved.projection.state),
            Some(&artifact_b)
        );

        let records = scan(&journal).unwrap().records;
        assert_eq!(records.len(), 2);
        assert_eq!(records[1].kind, JournalRecordKind::Commit);
        assert_eq!(records[1].history_group.forward_commands, forward_commands);
        assert_eq!(records[1].history_group.inverse_commands.len(), 2);
        assert!(matches!(
            records[1].history_group.inverse_commands[0],
            ProjectCommand::RestoreActiveCaptionArtifact { .. }
        ));
        assert!(matches!(
            records[1].history_group.inverse_commands[1],
            ProjectCommand::MoveClip { .. }
        ));

        let moved_state = moved.projection.state.clone();
        let moved_hash = moved.state_hash.clone();
        let undone = service
            .undo(
                owner,
                &initial.id,
                2,
                "89200000-0000-4000-8000-000000000005",
                &grants,
            )
            .unwrap();
        assert_eq!(undone.new_revision.number, 3);
        assert_eq!(undone.projection.state, state_after_install);
        assert_eq!(undone.state_hash, hash_after_install);
        assert_eq!(
            trim_caption_clip(&undone.projection.state)
                .timeline_start
                .value,
            0
        );
        assert_eq!(
            active_caption_artifact(&undone.projection.state),
            Some(&artifact_a)
        );

        let redone = service
            .redo(
                owner,
                &initial.id,
                3,
                "89200000-0000-4000-8000-000000000006",
                &grants,
            )
            .unwrap();
        assert_eq!(redone.new_revision.number, 4);
        assert_eq!(redone.projection.state, moved_state);
        assert_eq!(redone.state_hash, moved_hash);
        assert_eq!(
            active_caption_artifact(&redone.projection.state),
            Some(&artifact_b)
        );
        assert_eq!(scan(&journal).unwrap().records.len(), 4);

        (
            artifact_a,
            artifact_b,
            forward_commands,
            moved_state,
            moved_hash,
        )
    };

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("move-caption-reopen", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 4);
    assert_eq!(reopened.projection.revision.number, 4);
    assert_eq!(reopened.projection.revision.state_hash, moved_hash);
    assert_eq!(reopened.projection.state, moved_state);
    assert_eq!(
        trim_caption_clip(&reopened.projection.state)
            .timeline_start
            .value,
        12
    );
    assert_eq!(
        active_caption_artifact(&reopened.projection.state),
        Some(&artifact_b)
    );
    assert_ne!(
        active_caption_artifact(&reopened.projection.state),
        Some(&artifact_a)
    );
    assert!(reopened.projection.can_undo);
    assert!(!reopened.projection.can_redo);
    reopened_service
        .close("move-caption-reopen", &initial.id)
        .unwrap();

    let checkpointed = read_snapshot(&project_path).unwrap();
    assert_eq!(checkpointed.state, moved_state);
    assert_eq!(checkpointed.revision.state_hash, moved_hash);
    assert_eq!(checkpointed.history.undo_stack.len(), 2);
    assert!(checkpointed.history.redo_stack.is_empty());
    assert_eq!(
        checkpointed.history.undo_stack[1].forward_commands,
        forward_commands
    );
}

#[test]
fn ripple_delete_caption_lifecycle_is_atomic_across_history_recovery_and_checkpoint() {
    const SECOND_CAPTION_TRACK_ID: &str = "89300000-0000-4000-8000-000000000001";
    const TARGET_CLIP_ID: &str = "89300000-0000-4000-8000-000000000002";
    const SAME_SOURCE_SUFFIX_ID: &str = "89300000-0000-4000-8000-000000000003";
    const OTHER_SOURCE_SUFFIX_ID: &str = "89300000-0000-4000-8000-000000000004";
    const OTHER_ASSET_ID: &str = "89300000-0000-4000-8000-000000000005";

    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("ripple-caption-lifecycle.svpvideo");
    let mut initial = trim_caption_project_fixture();
    let mut other_asset = initial.state.assets[0].clone();
    other_asset.id = serde_json::from_value(Value::String(OTHER_ASSET_ID.to_owned())).unwrap();
    initial.state.assets.push(other_asset);

    let template = trim_caption_clip(&initial.state).clone();
    let clip = |id: &str, asset_id: &str, timeline_start: u64, source_in: u64| {
        let mut clip = template.clone();
        clip.id = id.to_owned();
        clip.source = ClipSource::Asset {
            asset_id: asset_id.to_owned(),
        };
        clip.timeline_start.value = timeline_start;
        clip.source_in.value = source_in;
        clip.source_out.value = source_in + 5;
        clip
    };
    let original_asset_id = match &template.source {
        ClipSource::Asset { asset_id } => asset_id.clone(),
        ClipSource::Sequence { .. } => panic!("caption fixture asset clip"),
    };
    let ProjectTrack::Video { clips, .. } = &mut initial.state.sequences[0].tracks[1] else {
        panic!("caption fixture video track")
    };
    *clips = vec![
        clip(TRIM_CAPTION_CLIP_ID, &original_asset_id, 0, 0),
        clip(TARGET_CLIP_ID, &original_asset_id, 10, 5),
        clip(SAME_SOURCE_SUFFIX_ID, &original_asset_id, 20, 10),
        clip(OTHER_SOURCE_SUFFIX_ID, OTHER_ASSET_ID, 30, 0),
    ];

    let mut artifact_a_before = caption_artifact_for(&initial, "A");
    artifact_a_before.track_link.caption_track_id = CAPTION_TRACK_ID.to_owned();
    let mut artifact_b_before = caption_artifact_for(&initial, "B");
    artifact_b_before.track_link.caption_track_id = SECOND_CAPTION_TRACK_ID.to_owned();
    let ProjectTrack::Caption {
        active_caption_artifact: primary_active,
        ..
    } = &mut initial.state.sequences[0].tracks[0]
    else {
        panic!("primary caption track")
    };
    *primary_active = Some(artifact_a_before.clone());
    let mut second_caption_track = initial.state.sequences[0].tracks[0].clone();
    let ProjectTrack::Caption {
        id,
        name,
        captions,
        active_caption_artifact: secondary_active,
        ..
    } = &mut second_caption_track
    else {
        unreachable!()
    };
    *id = SECOND_CAPTION_TRACK_ID.to_owned();
    *name = "Secondary captions".to_owned();
    for caption in captions {
        caption.id = "89300000-0000-4000-8000-000000000006".to_owned();
    }
    *secondary_active = Some(artifact_b_before.clone());
    initial.state.sequences[0].tracks.push(second_caption_track);
    initial.revision.state_hash = state_hash(&initial.state).unwrap();
    artifact_a_before.track_link.project_revision = initial.revision.clone();
    artifact_b_before.track_link.project_revision = initial.revision.clone();
    if let ProjectTrack::Caption {
        active_caption_artifact,
        ..
    } = &mut initial.state.sequences[0].tracks[0]
    {
        *active_caption_artifact = Some(artifact_a_before.clone());
    }
    if let ProjectTrack::Caption {
        active_caption_artifact,
        ..
    } = &mut initial.state.sequences[0].tracks[2]
    {
        *active_caption_artifact = Some(artifact_b_before.clone());
    }
    initial.revision.state_hash = state_hash(&initial.state).unwrap();
    validate_snapshot(&initial).unwrap();
    let pre_group_state = initial.state.clone();
    let pre_group_hash = initial.revision.state_hash.clone();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();

    let mut artifact_a_after = artifact_a_before.clone();
    let mut artifact_b_after = artifact_b_before.clone();
    for artifact in [&mut artifact_a_after, &mut artifact_b_after] {
        artifact.track_link.project_revision = initial.revision.clone();
        artifact.cues[0].end.value -= 4;
        artifact.cues[1].start.value -= 4;
        artifact.cues[1].end.value -= 4;
    }
    artifact_a_after.language = "en-GB".to_owned();
    artifact_b_after.language = "fr-FR".to_owned();
    let forward_commands = vec![
        ProjectCommand::RippleDeleteClip {
            command_id: "89300000-0000-4000-8000-000000000010".to_owned(),
            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
            track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
            clip_id: TARGET_CLIP_ID.to_owned(),
        },
        ProjectCommand::ApplyCaptionArtifact {
            command_id: "89300000-0000-4000-8000-000000000011".to_owned(),
            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
            track_id: CAPTION_TRACK_ID.to_owned(),
            artifact: artifact_a_after.clone(),
        },
        ProjectCommand::ApplyCaptionArtifact {
            command_id: "89300000-0000-4000-8000-000000000012".to_owned(),
            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
            track_id: SECOND_CAPTION_TRACK_ID.to_owned(),
            artifact: artifact_b_after.clone(),
        },
    ];
    let grants = crate::video::VideoPathGrants::default();
    let owner = "ripple-caption-owner";
    let journal = journal_path(&project_path).unwrap();

    let (post_group_state, post_group_hash, project_id) = {
        let service = VideoProjectService::default();
        let opened = service.open(owner, &project_path, &grants).unwrap();
        let project_id = opened.projection.project_id;
        let committed = service
            .execute(
                owner,
                CommandGroupRequest {
                    group_id: "89300000-0000-4000-8000-000000000013".to_owned(),
                    project_id: project_id.clone(),
                    base_revision: 0,
                    commands: forward_commands.clone(),
                },
                &grants,
            )
            .unwrap();
        assert_eq!(
            (
                committed.prior_revision.number,
                committed.new_revision.number
            ),
            (0, 1),
            "the ordered group advances exactly one revision"
        );
        let records = scan(&journal).unwrap().records;
        assert_eq!(records.len(), 1, "the ordered group writes one commit");
        assert_eq!(records[0].kind, JournalRecordKind::Commit);
        assert_eq!(records[0].history_group.forward_commands, forward_commands);
        assert!(matches!(
            records[0].history_group.inverse_commands.as_slice(),
            [
                ProjectCommand::RestoreActiveCaptionArtifact { track_id: second, .. },
                ProjectCommand::RestoreActiveCaptionArtifact { track_id: first, .. },
                ProjectCommand::RestoreRippleDeletedClip { clip, .. }
            ] if second == SECOND_CAPTION_TRACK_ID
                && first == CAPTION_TRACK_ID
                && clip.id == TARGET_CLIP_ID
        ));

        let clips = committed.projection.state.sequences[0].tracks[1]
            .clips()
            .unwrap();
        assert_eq!(
            clips
                .iter()
                .map(|clip| (clip.id.as_str(), clip.timeline_start.value))
                .collect::<Vec<_>>(),
            vec![
                (TRIM_CAPTION_CLIP_ID, 0),
                (SAME_SOURCE_SUFFIX_ID, 16),
                (OTHER_SOURCE_SUFFIX_ID, 26),
            ]
        );
        assert!(clips.iter().all(|clip| clip.id != TARGET_CLIP_ID));
        assert!(matches!(
            &clips[2].source,
            ClipSource::Asset { asset_id } if asset_id == OTHER_ASSET_ID
        ));
        let active_artifact = |track_id: &str| {
            committed.projection.state.sequences[0]
                .tracks
                .iter()
                .find(|track| track.id() == track_id)
                .and_then(|track| match track {
                    ProjectTrack::Caption {
                        active_caption_artifact,
                        ..
                    } => active_caption_artifact.as_ref(),
                    _ => None,
                })
        };
        assert_eq!(active_artifact(CAPTION_TRACK_ID), Some(&artifact_a_after));
        assert_eq!(
            active_artifact(SECOND_CAPTION_TRACK_ID),
            Some(&artifact_b_after)
        );

        let post_group_state = committed.projection.state.clone();
        let post_group_hash = committed.state_hash.clone();
        let undone = service
            .undo(
                owner,
                &project_id,
                1,
                "89300000-0000-4000-8000-000000000014",
                &grants,
            )
            .unwrap();
        assert_eq!(undone.projection.state, pre_group_state);
        assert_eq!(undone.state_hash, pre_group_hash);
        assert_eq!(
            active_caption_artifact(&undone.projection.state),
            Some(&artifact_a_before)
        );
        let ProjectTrack::Caption {
            active_caption_artifact,
            ..
        } = &undone.projection.state.sequences[0].tracks[2]
        else {
            panic!("secondary caption track")
        };
        assert_eq!(active_caption_artifact.as_ref(), Some(&artifact_b_before));

        let redone = service
            .redo(
                owner,
                &project_id,
                2,
                "89300000-0000-4000-8000-000000000015",
                &grants,
            )
            .unwrap();
        assert_eq!(redone.projection.state, post_group_state);
        assert_eq!(redone.state_hash, post_group_hash);

        let inspector_before = service.inspector(owner, &project_id).unwrap();
        let journal_before = fs::read(&journal).unwrap();
        let mut invalid_artifact = artifact_b_after.clone();
        invalid_artifact.track_link.project_revision = redone.new_revision.clone();
        invalid_artifact.track_link.caption_track_id = CAPTION_TRACK_ID.to_owned();
        invalid_artifact.cues[0].lines.clear();
        let rejected = service
            .execute(
                owner,
                CommandGroupRequest {
                    group_id: "89300000-0000-4000-8000-000000000016".to_owned(),
                    project_id: project_id.clone(),
                    base_revision: 3,
                    commands: vec![
                        ProjectCommand::MoveClip {
                            command_id: "89300000-0000-4000-8000-000000000017".to_owned(),
                            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                            track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
                            clip_id: SAME_SOURCE_SUFFIX_ID.to_owned(),
                            timeline_start: RationalTime {
                                value: 17,
                                rate_numerator: 24,
                                rate_denominator: 1,
                            },
                        },
                        ProjectCommand::ApplyCaptionArtifact {
                            command_id: "89300000-0000-4000-8000-000000000018".to_owned(),
                            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                            track_id: CAPTION_TRACK_ID.to_owned(),
                            artifact: invalid_artifact,
                        },
                    ],
                },
                &grants,
            )
            .unwrap_err();
        assert_eq!(
            rejected.code,
            crate::video::error::VideoErrorCode::InvalidCommand
        );
        assert_eq!(
            service.inspector(owner, &project_id).unwrap(),
            inspector_before
        );
        assert_eq!(fs::read(&journal).unwrap(), journal_before);

        (post_group_state, post_group_hash, project_id)
    };

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("ripple-caption-reopen", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 3);
    assert_eq!(reopened.projection.revision.number, 3);
    assert_eq!(reopened.projection.state, post_group_state);
    assert_eq!(reopened.projection.revision.state_hash, post_group_hash);
    reopened_service
        .close("ripple-caption-reopen", &project_id)
        .unwrap();

    let checkpointed = read_snapshot(&project_path).unwrap();
    assert_eq!(checkpointed.state, post_group_state);
    assert_eq!(checkpointed.revision.state_hash, post_group_hash);
    assert_eq!(checkpointed.history.undo_stack.len(), 1);
    assert!(checkpointed.history.redo_stack.is_empty());
    assert_eq!(
        checkpointed.history.undo_stack[0].forward_commands,
        forward_commands
    );
}

#[test]
fn trim_clip_caption_lifecycle_is_atomic_across_history_and_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("trim-caption-lifecycle.svpvideo");
    let initial = trim_caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let owner = "trim-caption-owner";
    let journal = journal_path(&project_path).unwrap();

    let (artifact_a, artifact_b, combined_commands, state_after_group, hash_after_group) = {
        let service = VideoProjectService::default();
        service.open(owner, &project_path, &grants).unwrap();

        let artifact_a = caption_artifact_for(&initial, "A");
        let installed = service
            .execute(
                owner,
                caption_request(
                    &initial,
                    "89000000-0000-4000-8000-000000000001",
                    artifact_a.clone(),
                ),
                &grants,
            )
            .unwrap();
        assert_eq!(installed.new_revision.number, 1);
        assert_eq!(
            active_caption_artifact(&installed.projection.state),
            Some(&artifact_a)
        );
        let state_after_a = installed.projection.state.clone();
        let hash_after_a = installed.state_hash.clone();
        let mut after_a = initial.clone();
        after_a.revision = installed.new_revision.clone();
        after_a.state = state_after_a.clone();
        let artifact_b = caption_artifact_for(&after_a, "B");
        let combined_commands = vec![
            ProjectCommand::TrimClip {
                command_id: "89000000-0000-4000-8000-000000000002".to_owned(),
                sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
                clip_id: TRIM_CAPTION_CLIP_ID.to_owned(),
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
            },
            ProjectCommand::ApplyCaptionArtifact {
                command_id: "89000000-0000-4000-8000-000000000003".to_owned(),
                sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                track_id: CAPTION_TRACK_ID.to_owned(),
                artifact: artifact_b.clone(),
            },
        ];
        let combined = service
            .execute(
                owner,
                CommandGroupRequest {
                    group_id: "89000000-0000-4000-8000-000000000004".to_owned(),
                    project_id: initial.id.clone(),
                    base_revision: 1,
                    commands: combined_commands.clone(),
                },
                &grants,
            )
            .unwrap();
        assert_eq!(
            (combined.prior_revision.number, combined.new_revision.number),
            (1, 2)
        );
        assert_eq!(
            trim_caption_clip(&combined.projection.state)
                .source_in
                .value,
            5
        );
        assert_eq!(
            trim_caption_clip(&combined.projection.state)
                .source_out
                .value,
            25
        );
        assert_eq!(
            active_caption_artifact(&combined.projection.state),
            Some(&artifact_b)
        );

        let committed_records = scan(&journal).unwrap().records;
        assert_eq!(committed_records.len(), 2);
        let combined_record = &committed_records[1];
        assert_eq!(combined_record.kind, JournalRecordKind::Commit);
        assert_eq!(
            combined_record.history_group.forward_commands,
            combined_commands
        );
        assert_eq!(combined_record.history_group.inverse_commands.len(), 2);
        assert!(matches!(
            combined_record.history_group.inverse_commands[0],
            ProjectCommand::RestoreActiveCaptionArtifact { .. }
        ));
        assert!(matches!(
            combined_record.history_group.inverse_commands[1],
            ProjectCommand::TrimClip { .. }
        ));

        let state_after_group = combined.projection.state.clone();
        let hash_after_group = combined.state_hash.clone();
        let undone = service
            .undo(
                owner,
                &initial.id,
                2,
                "89000000-0000-4000-8000-000000000005",
                &grants,
            )
            .unwrap();
        assert_eq!(undone.new_revision.number, 3);
        assert_eq!(undone.projection.state, state_after_a);
        assert_eq!(undone.state_hash, hash_after_a);
        assert_eq!(
            active_caption_artifact(&undone.projection.state),
            Some(&artifact_a)
        );
        assert_eq!(
            trim_caption_clip(&undone.projection.state).source_in.value,
            0
        );
        assert_eq!(
            trim_caption_clip(&undone.projection.state).source_out.value,
            30
        );

        let redone = service
            .redo(
                owner,
                &initial.id,
                3,
                "89000000-0000-4000-8000-000000000006",
                &grants,
            )
            .unwrap();
        assert_eq!(redone.new_revision.number, 4);
        assert_eq!(redone.projection.state, state_after_group);
        assert_eq!(redone.state_hash, hash_after_group);
        assert_eq!(
            active_caption_artifact(&redone.projection.state),
            Some(&artifact_b)
        );

        let records_before_rejection = scan(&journal).unwrap().records;
        assert_eq!(records_before_rejection.len(), 4);
        let inspector_before_rejection = service.inspector(owner, &initial.id).unwrap();
        let rejected = service
            .execute(
                owner,
                CommandGroupRequest {
                    group_id: "89000000-0000-4000-8000-000000000007".to_owned(),
                    project_id: initial.id.clone(),
                    base_revision: 4,
                    commands: vec![
                        ProjectCommand::TrimClip {
                            command_id: "89000000-0000-4000-8000-000000000008".to_owned(),
                            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                            track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
                            clip_id: TRIM_CAPTION_CLIP_ID.to_owned(),
                            source_in: RationalTime {
                                value: 6,
                                rate_numerator: 30,
                                rate_denominator: 1,
                            },
                            source_out: RationalTime {
                                value: 24,
                                rate_numerator: 30,
                                rate_denominator: 1,
                            },
                        },
                        ProjectCommand::ApplyCaptionArtifact {
                            command_id: "89000000-0000-4000-8000-000000000009".to_owned(),
                            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                            track_id: CAPTION_TRACK_ID.to_owned(),
                            artifact: artifact_b.clone(),
                        },
                    ],
                },
                &grants,
            )
            .unwrap_err();
        assert_eq!(
            rejected.code,
            crate::video::error::VideoErrorCode::InvalidCommand
        );
        assert_eq!(
            service.inspector(owner, &initial.id).unwrap(),
            inspector_before_rejection
        );
        assert_eq!(scan(&journal).unwrap().records, records_before_rejection);

        (
            artifact_a,
            artifact_b,
            combined_commands,
            state_after_group,
            hash_after_group,
        )
    };

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("trim-caption-reopen", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 4);
    assert_eq!(reopened.projection.revision.number, 4);
    assert_eq!(reopened.projection.revision.state_hash, hash_after_group);
    assert_eq!(reopened.projection.state, state_after_group);
    assert_eq!(
        trim_caption_clip(&reopened.projection.state)
            .source_in
            .value,
        5
    );
    assert_eq!(
        trim_caption_clip(&reopened.projection.state)
            .source_out
            .value,
        25
    );
    assert_eq!(
        active_caption_artifact(&reopened.projection.state),
        Some(&artifact_b)
    );
    assert_ne!(
        active_caption_artifact(&reopened.projection.state),
        Some(&artifact_a)
    );
    assert_eq!(
        artifact_b.track_link.project_revision.number, 1,
        "corrected artifact provenance remains linked to the combined group's base revision"
    );
    assert!(reopened.projection.can_undo);
    assert!(!reopened.projection.can_redo);
    reopened_service
        .close("trim-caption-reopen", &initial.id)
        .unwrap();

    let checkpointed = read_snapshot(&project_path).unwrap();
    assert_eq!(checkpointed.state, state_after_group);
    assert_eq!(checkpointed.revision.state_hash, hash_after_group);
    assert_eq!(checkpointed.history.undo_stack.len(), 2);
    assert!(checkpointed.history.redo_stack.is_empty());
    assert_eq!(
        checkpointed.history.undo_stack[1].forward_commands,
        combined_commands
    );
}

#[test]
fn split_clip_caption_lifecycle_preserves_artifact_across_history_and_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("split-caption-lifecycle.svpvideo");
    let initial = trim_caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let owner = "split-caption-owner";
    let right_clip_id = "89100000-0000-4000-8000-000000000001";

    let (artifact, split_state, split_hash, project_id) = {
        let service = VideoProjectService::default();
        let opened = service.open(owner, &project_path, &grants).unwrap();
        let project_id = opened.projection.project_id;
        let artifact = caption_artifact_for(&initial, "A");
        let installed = service
            .execute(
                owner,
                caption_request(
                    &initial,
                    "89100000-0000-4000-8000-000000000002",
                    artifact.clone(),
                ),
                &grants,
            )
            .unwrap();
        let split = service
            .execute(
                owner,
                CommandGroupRequest {
                    group_id: "89100000-0000-4000-8000-000000000003".to_owned(),
                    project_id: initial.id.clone(),
                    base_revision: 1,
                    commands: vec![ProjectCommand::SplitClip {
                        command_id: "89100000-0000-4000-8000-000000000004".to_owned(),
                        sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                        track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
                        clip_id: TRIM_CAPTION_CLIP_ID.to_owned(),
                        split_at: RationalTime {
                            value: 15,
                            rate_numerator: 30,
                            rate_denominator: 1,
                        },
                        right_clip_id: right_clip_id.to_owned(),
                    }],
                },
                &grants,
            )
            .unwrap();
        assert_eq!(
            (split.prior_revision.number, split.new_revision.number),
            (1, 2)
        );
        assert_eq!(
            active_caption_artifact(&split.projection.state),
            Some(&artifact)
        );
        let ProjectTrack::Video { clips, .. } = &split.projection.state.sequences[0].tracks[1]
        else {
            panic!("split caption video track")
        };
        assert_eq!(clips.len(), 2);
        assert_eq!(
            (clips[0].source_out.value, clips[1].source_in.value),
            (15, 15)
        );

        let split_state = split.projection.state.clone();
        let split_hash = split.state_hash.clone();
        let undone = service
            .undo(
                owner,
                &initial.id,
                2,
                "89100000-0000-4000-8000-000000000005",
                &grants,
            )
            .unwrap();
        assert_eq!(undone.projection.state, installed.projection.state);
        assert_eq!(
            active_caption_artifact(&undone.projection.state),
            Some(&artifact)
        );
        let redone = service
            .redo(
                owner,
                &initial.id,
                3,
                "89100000-0000-4000-8000-000000000006",
                &grants,
            )
            .unwrap();
        assert_eq!(redone.projection.state, split_state);
        assert_eq!(redone.state_hash, split_hash);
        assert_eq!(
            active_caption_artifact(&redone.projection.state),
            Some(&artifact)
        );
        (artifact, split_state, split_hash, project_id)
    };

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("split-caption-reopen", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 4);
    assert_eq!(reopened.projection.state, split_state);
    assert_eq!(reopened.projection.revision.state_hash, split_hash);
    assert_eq!(
        active_caption_artifact(&reopened.projection.state),
        Some(&artifact)
    );
    reopened_service
        .close("split-caption-reopen", &project_id)
        .unwrap();
    let checkpointed = read_snapshot(&project_path).unwrap();
    assert_eq!(checkpointed.state, split_state);
    assert_eq!(
        active_caption_artifact(&checkpointed.state),
        Some(&artifact)
    );
}

#[test]
fn transcript_edit_caption_lifecycle_is_atomic_across_history_and_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory
        .path()
        .join("transcript-edit-caption-lifecycle.svpvideo");
    let initial = trim_caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    let grants = crate::video::VideoPathGrants::default();
    let owner = "transcript-edit-caption-owner";
    let removable_clip_id = "89200000-0000-4000-8000-000000000001";
    let suffix_clip_id = "89200000-0000-4000-8000-000000000002";
    let journal = journal_path(&project_path).unwrap();

    let (artifact_b, edited_state, edited_hash, forward_commands, project_id) = {
        let service = VideoProjectService::default();
        let opened = service.open(owner, &project_path, &grants).unwrap();
        let project_id = opened.projection.project_id;
        let artifact_a = caption_artifact_for(&initial, "A");
        let installed = service
            .execute(
                owner,
                caption_request(
                    &initial,
                    "89200000-0000-4000-8000-000000000003",
                    artifact_a.clone(),
                ),
                &grants,
            )
            .unwrap();
        let mut installed_snapshot = initial.clone();
        installed_snapshot.revision = installed.new_revision.clone();
        installed_snapshot.state = installed.projection.state.clone();
        let artifact_b = caption_artifact_for(&installed_snapshot, "B");
        let forward_commands = vec![
            ProjectCommand::SplitClip {
                command_id: "89200000-0000-4000-8000-000000000004".to_owned(),
                sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
                clip_id: TRIM_CAPTION_CLIP_ID.to_owned(),
                split_at: RationalTime {
                    value: 5,
                    rate_numerator: 30,
                    rate_denominator: 1,
                },
                right_clip_id: removable_clip_id.to_owned(),
            },
            ProjectCommand::SplitClip {
                command_id: "89200000-0000-4000-8000-000000000005".to_owned(),
                sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
                clip_id: removable_clip_id.to_owned(),
                split_at: RationalTime {
                    value: 20,
                    rate_numerator: 30,
                    rate_denominator: 1,
                },
                right_clip_id: suffix_clip_id.to_owned(),
            },
            ProjectCommand::RippleDeleteClip {
                command_id: "89200000-0000-4000-8000-000000000006".to_owned(),
                sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
                clip_id: removable_clip_id.to_owned(),
            },
            ProjectCommand::ApplyCaptionArtifact {
                command_id: "89200000-0000-4000-8000-000000000007".to_owned(),
                sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                track_id: CAPTION_TRACK_ID.to_owned(),
                artifact: artifact_b.clone(),
            },
        ];
        let edited = service
            .execute(
                owner,
                CommandGroupRequest {
                    group_id: "89200000-0000-4000-8000-000000000008".to_owned(),
                    project_id: initial.id.clone(),
                    base_revision: 1,
                    commands: forward_commands.clone(),
                },
                &grants,
            )
            .unwrap();
        assert_eq!(
            (edited.prior_revision.number, edited.new_revision.number),
            (1, 2)
        );
        assert_eq!(
            active_caption_artifact(&edited.projection.state),
            Some(&artifact_b)
        );
        let ProjectTrack::Video { clips, .. } = &edited.projection.state.sequences[0].tracks[1]
        else {
            panic!("transcript edit video track")
        };
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0].id, TRIM_CAPTION_CLIP_ID);
        assert_eq!(clips[0].source_out.value, 5);
        assert_eq!(clips[1].id, suffix_clip_id);
        assert_eq!(clips[1].source_in.value, 20);
        assert_eq!(clips[1].timeline_start.value, 4);

        let records = scan(&journal).unwrap().records;
        assert_eq!(
            records.len(),
            2,
            "install and combined edit are one commit each"
        );
        assert_eq!(records[1].history_group.forward_commands, forward_commands);
        assert!(matches!(
            records[1].history_group.inverse_commands[0],
            ProjectCommand::RestoreActiveCaptionArtifact { .. }
        ));
        assert!(matches!(
            records[1].history_group.inverse_commands[1],
            ProjectCommand::RestoreRippleDeletedClip { .. }
        ));

        let edited_state = edited.projection.state.clone();
        let edited_hash = edited.state_hash.clone();
        let undone = service
            .undo(
                owner,
                &initial.id,
                2,
                "89200000-0000-4000-8000-000000000009",
                &grants,
            )
            .unwrap();
        assert_eq!(undone.projection.state, installed.projection.state);
        assert_eq!(undone.state_hash, installed.state_hash);
        assert_eq!(
            active_caption_artifact(&undone.projection.state),
            Some(&artifact_a)
        );
        let redone = service
            .redo(
                owner,
                &initial.id,
                3,
                "89200000-0000-4000-8000-000000000010",
                &grants,
            )
            .unwrap();
        assert_eq!(redone.projection.state, edited_state);
        assert_eq!(redone.state_hash, edited_hash);
        assert_eq!(
            active_caption_artifact(&redone.projection.state),
            Some(&artifact_b)
        );

        let inspector_before = service.inspector(owner, &initial.id).unwrap();
        let journal_before = fs::read(&journal).unwrap();
        let revision_before = redone.projection.revision.clone();
        let mut stale_artifact = artifact_b.clone();
        stale_artifact.language = "fr-FR".to_owned();
        let rejected = service
            .execute(
                owner,
                CommandGroupRequest {
                    group_id: "89200000-0000-4000-8000-000000000011".to_owned(),
                    project_id: initial.id.clone(),
                    base_revision: 4,
                    commands: vec![
                        ProjectCommand::SplitClip {
                            command_id: "89200000-0000-4000-8000-000000000012".to_owned(),
                            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                            track_id: TRIM_CAPTION_SOURCE_TRACK_ID.to_owned(),
                            clip_id: TRIM_CAPTION_CLIP_ID.to_owned(),
                            split_at: RationalTime {
                                value: 2,
                                rate_numerator: 30,
                                rate_denominator: 1,
                            },
                            right_clip_id: "89200000-0000-4000-8000-000000000013".to_owned(),
                        },
                        ProjectCommand::ApplyCaptionArtifact {
                            command_id: "89200000-0000-4000-8000-000000000014".to_owned(),
                            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
                            track_id: CAPTION_TRACK_ID.to_owned(),
                            artifact: stale_artifact,
                        },
                    ],
                },
                &grants,
            )
            .unwrap_err();
        assert_eq!(
            rejected.code,
            crate::video::error::VideoErrorCode::InvalidCommand
        );
        assert_eq!(
            service.inspector(owner, &initial.id).unwrap(),
            inspector_before
        );
        assert_eq!(fs::read(&journal).unwrap(), journal_before);
        assert_eq!(
            service.inspector(owner, &initial.id).unwrap().revision,
            revision_before
        );
        (
            artifact_b,
            edited_state,
            edited_hash,
            forward_commands,
            project_id,
        )
    };

    let reopened_service = VideoProjectService::default();
    let reopened = reopened_service
        .open("transcript-edit-caption-reopen", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 4);
    assert_eq!(reopened.projection.state, edited_state);
    assert_eq!(reopened.projection.revision.state_hash, edited_hash);
    assert_eq!(
        active_caption_artifact(&reopened.projection.state),
        Some(&artifact_b)
    );
    assert_eq!(
        scan(&journal).unwrap().records[1]
            .history_group
            .forward_commands,
        forward_commands
    );
    reopened_service
        .close("transcript-edit-caption-reopen", &project_id)
        .unwrap();
    let checkpointed = read_snapshot(&project_path).unwrap();
    assert_eq!(checkpointed.state, edited_state);
    assert_eq!(checkpointed.revision.state_hash, edited_hash);
    assert_eq!(
        active_caption_artifact(&checkpointed.state),
        Some(&artifact_b)
    );
}

#[test]
fn large_caption_artifact_crossing_legacy_record_limit_persists_reopens_and_undoes() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("large-caption.svpvideo");
    let initial = caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    let artifact = large_caption_artifact_for(&initial, 1_100);
    let request = caption_request(
        &initial,
        "87000000-0000-4000-8000-000000000001",
        artifact.clone(),
    );
    assert!(canonical_bytes(&request).unwrap().len() < MAX_COMMAND_GROUP_BYTES);
    let grants = crate::video::VideoPathGrants::default();

    let acknowledged = {
        let service = VideoProjectService::default();
        service
            .open("large-caption-owner", &project_path, &grants)
            .unwrap();
        let acknowledged = service
            .execute("large-caption-owner", request.clone(), &grants)
            .unwrap();
        assert_eq!(
            active_caption_artifact(&acknowledged.projection.state),
            Some(&artifact)
        );

        let records = scan(&journal_path(&project_path).unwrap()).unwrap().records;
        assert_eq!(records.len(), 1);
        assert!(records[0].commands.is_empty());
        assert!(canonical_bytes(&records[0]).unwrap().len() <= MAX_JOURNAL_LINE_BYTES);
        let mut legacy_expanded = records[0].clone();
        legacy_expanded.commands = legacy_expanded.history_group.forward_commands.clone();
        let legacy_expanded = with_record_hash(&legacy_expanded).unwrap();
        assert!(
            canonical_bytes(&legacy_expanded).unwrap().len() > MAX_JOURNAL_LINE_BYTES,
            "fixture must reproduce the former amplified journal-line failure"
        );
        acknowledged
    };

    let service = VideoProjectService::default();
    let reopened = service
        .open("large-caption-reopen", &project_path, &grants)
        .unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert_eq!(reopened.recovery.replayed_record_count, 1);
    assert_eq!(
        active_caption_artifact(&reopened.projection.state),
        Some(&artifact)
    );
    assert_eq!(
        service
            .execute("large-caption-reopen", request, &grants)
            .unwrap(),
        acknowledged
    );
    let undone = service
        .undo(
            "large-caption-reopen",
            &initial.id,
            1,
            "87000000-0000-4000-8000-000000000002",
            &grants,
        )
        .unwrap();
    assert_eq!(active_caption_artifact(&undone.projection.state), None);
}

#[test]
fn oversized_prospective_caption_record_is_rejected_before_append_or_session_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("oversized-caption-record.svpvideo");
    let initial = caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    let request = caption_request(
        &initial,
        "87000000-0000-4000-8000-000000000010",
        large_caption_artifact_for(&initial, 1_800),
    );
    assert!(canonical_bytes(&request).unwrap().len() < MAX_COMMAND_GROUP_BYTES);
    let grants = crate::video::VideoPathGrants::default();
    let service = VideoProjectService::default();
    service
        .open("oversized-caption-owner", &project_path, &grants)
        .unwrap();
    let journal = journal_path(&project_path).unwrap();
    let journal_before = fs::read(&journal).unwrap();

    let error = service
        .execute("oversized-caption-owner", request, &grants)
        .unwrap_err();
    assert_eq!(
        error.code,
        crate::video::error::VideoErrorCode::StorageLimit
    );
    assert_eq!(error.details["category"], "journal_record_bytes");
    let inspector = service
        .inspector("oversized-caption-owner", &initial.id)
        .unwrap();
    assert_eq!(inspector.revision, initial.revision);
    assert!(inspector.last_command.is_none());
    assert_eq!(fs::read(&journal).unwrap(), journal_before);
    service
        .close("oversized-caption-owner", &initial.id)
        .unwrap();
    assert_eq!(
        active_caption_artifact(&read_snapshot(&project_path).unwrap().state),
        None
    );
}

#[test]
fn tampered_caption_artifact_journal_fails_closed_without_repair() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("tampered-caption-journal.svpvideo");
    let mut initial = caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    fs::create_dir_all(sidecar_path(&project_path).unwrap()).unwrap();
    let header = create_journal_for_snapshot(&project_path, &mut initial).unwrap();

    let request = caption_request(
        &initial,
        "85000000-0000-4000-8000-000000000001",
        caption_artifact_for(&initial, "A"),
    );
    let transition = commit_transition(&initial, &request, "2026-08-08T00:04:00Z").unwrap();
    let mut commands = request.commands;
    let ProjectCommand::ApplyCaptionArtifact { artifact, .. } = &mut commands[0] else {
        unreachable!()
    };
    artifact.cues[0].lines.clear();
    let record = with_record_hash(&JournalRecord {
        kind: JournalRecordKind::Commit,
        record_number: 1,
        operation_id: transition.operation_id.clone(),
        group_id: transition.group_id.clone(),
        committed_at: transition.snapshot.updated_at.clone(),
        base_revision: transition.prior_revision.clone(),
        resulting_revision: transition.snapshot.revision.clone(),
        commands,
        history_group: transition.history_group.clone(),
        summary: transition.history_group.summary.clone(),
        affected_ranges: transition.applied.affected_ranges.clone(),
        cache_invalidations: transition.applied.cache_invalidations.clone(),
        previous_state_hash: transition.prior_revision.state_hash.clone(),
        resulting_state_hash: transition.snapshot.revision.state_hash.clone(),
        payload_hash: None,
        idempotency_result: None,
        previous_record_hash: header.header_hash,
        record_hash: String::new(),
    })
    .unwrap();
    let journal = journal_path(&project_path).unwrap();
    let mut record_bytes = canonical_bytes(&record).unwrap();
    record_bytes.push(b'\n');
    fs::OpenOptions::new()
        .append(true)
        .open(&journal)
        .unwrap()
        .write_all(&record_bytes)
        .unwrap();
    let scanned = scan(&journal).unwrap();
    assert_eq!(scanned.tail, TailClassification::Clean);
    assert_eq!(scanned.records, vec![record]);
    let journal_before = fs::read(&journal).unwrap();

    let service = VideoProjectService::default();
    for owner in ["tampered-journal-owner-a", "tampered-journal-owner-b"] {
        let error = service
            .open(
                owner,
                &project_path,
                &crate::video::VideoPathGrants::default(),
            )
            .unwrap_err();
        assert_eq!(
            error.code,
            crate::video::error::VideoErrorCode::InvalidProject
        );
        assert_eq!(error.details["category"], "record_replay");
        let close_error = service.close(owner, &initial.id).unwrap_err();
        assert_eq!(
            close_error.code,
            crate::video::error::VideoErrorCode::InvalidProject
        );
        assert_eq!(close_error.details["category"], "unknown_session");
    }
    assert_eq!(fs::read(&journal).unwrap(), journal_before);
    assert_eq!(
        read_snapshot(&project_path).unwrap().revision,
        initial.revision
    );
}

fn caption_journal_record_value(
    initial: &VideoProjectSnapshotV2,
    previous_record_hash: String,
) -> Value {
    let request = caption_request(
        initial,
        "87000000-0000-4000-8000-000000000001",
        caption_artifact_for(initial, "A"),
    );
    let transition = commit_transition(initial, &request, "2026-08-08T00:06:00Z").unwrap();
    serde_json::to_value(JournalRecord {
        kind: JournalRecordKind::Commit,
        record_number: 1,
        operation_id: transition.operation_id.clone(),
        group_id: transition.group_id.clone(),
        committed_at: transition.snapshot.updated_at.clone(),
        base_revision: transition.prior_revision.clone(),
        resulting_revision: transition.snapshot.revision.clone(),
        commands: request.commands,
        history_group: transition.history_group.clone(),
        summary: transition.history_group.summary.clone(),
        affected_ranges: transition.applied.affected_ranges.clone(),
        cache_invalidations: transition.applied.cache_invalidations.clone(),
        previous_state_hash: transition.prior_revision.state_hash.clone(),
        resulting_state_hash: transition.snapshot.revision.state_hash.clone(),
        payload_hash: None,
        idempotency_result: None,
        previous_record_hash,
        record_hash: String::new(),
    })
    .unwrap()
}

fn set_record_value_hash(record: &mut Value) {
    record["recordHash"] = Value::String(String::new());
    record["recordHash"] = Value::String(canonical_hash(record).unwrap());
}

fn append_journal_value(journal: &Path, value: &Value) {
    let mut bytes = canonical_bytes(value).unwrap();
    bytes.push(b'\n');
    fs::OpenOptions::new()
        .append(true)
        .open(journal)
        .unwrap()
        .write_all(&bytes)
        .unwrap();
}

#[test]
fn hash_consistent_caption_command_schema_failures_fail_closed_without_repair_or_session() {
    for case in [
        "unknown-field",
        "wrong-type",
        "explicit-null",
        "unknown-command-type",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let project_path = directory
            .path()
            .join(format!("caption-schema-{case}.svpvideo"));
        let mut initial = caption_project_fixture();
        fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
        fs::create_dir_all(sidecar_path(&project_path).unwrap()).unwrap();
        let header = create_journal_for_snapshot(&project_path, &mut initial).unwrap();
        let mut record = caption_journal_record_value(&initial, header.header_hash);
        match case {
            "unknown-field" => {
                record
                    .pointer_mut("/commands/0/artifact")
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .insert("unexpectedField".to_owned(), Value::Bool(true));
            }
            "wrong-type" => {
                *record.pointer_mut("/commands/0/artifact/language").unwrap() = Value::from(7);
            }
            "explicit-null" => {
                *record.pointer_mut("/commands/0/type").unwrap() =
                    Value::String("RestoreActiveCaptionArtifact".to_owned());
                *record.pointer_mut("/commands/0/artifact").unwrap() = Value::Null;
            }
            "unknown-command-type" => {
                *record.pointer_mut("/commands/0/type").unwrap() =
                    Value::String("UnknownCaptionArtifactCommand".to_owned());
            }
            _ => unreachable!(),
        }
        set_record_value_hash(&mut record);
        assert!(
            serde_json::from_value::<JournalRecord>(record.clone()).is_err(),
            "{case}"
        );
        let journal = journal_path(&project_path).unwrap();
        append_journal_value(&journal, &record);
        let journal_before = fs::read(&journal).unwrap();

        let scan_error = scan(&journal).unwrap_err();
        assert_eq!(
            scan_error.code,
            crate::video::error::VideoErrorCode::InvalidProject,
            "{case}"
        );
        assert_eq!(scan_error.details["category"], "record_schema", "{case}");

        let service = VideoProjectService::default();
        for owner_suffix in ["a", "b"] {
            let owner = format!("caption-schema-{case}-{owner_suffix}");
            let error = service
                .open(
                    &owner,
                    &project_path,
                    &crate::video::VideoPathGrants::default(),
                )
                .unwrap_err();
            assert_eq!(
                error.code,
                crate::video::error::VideoErrorCode::InvalidProject,
                "{case}"
            );
            assert_eq!(error.details["category"], "record_schema", "{case}");
            let close_error = service.close(&owner, &initial.id).unwrap_err();
            assert_eq!(close_error.details["category"], "unknown_session", "{case}");
            drop(acquire_project_lock(&project_path).unwrap());
        }
        assert_eq!(fs::read(&journal).unwrap(), journal_before, "{case}");
        assert_eq!(
            read_snapshot(&project_path).unwrap().revision,
            initial.revision,
            "{case}"
        );
    }
}

#[test]
fn stale_hash_caption_schema_failure_remains_a_repairable_corrupt_tail() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("caption-schema-stale-hash.svpvideo");
    let mut initial = caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    fs::create_dir_all(sidecar_path(&project_path).unwrap()).unwrap();
    let header = create_journal_for_snapshot(&project_path, &mut initial).unwrap();
    let mut record = caption_journal_record_value(&initial, header.header_hash);
    set_record_value_hash(&mut record);
    record
        .pointer_mut("/commands/0/artifact")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .insert("unexpectedField".to_owned(), Value::Bool(true));
    let journal = journal_path(&project_path).unwrap();
    append_journal_value(&journal, &record);

    let scanned = scan(&journal).unwrap();
    assert_eq!(scanned.tail, TailClassification::Corrupt);
    assert!(scanned.records.is_empty());
    assert!(scanned.discarded_tail_bytes > 0);
}

#[test]
fn tampered_non_caption_journal_fails_closed_without_repair_or_session() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("tampered-command-journal.svpvideo");
    let mut initial = caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    fs::create_dir_all(sidecar_path(&project_path).unwrap()).unwrap();
    let header = create_journal_for_snapshot(&project_path, &mut initial).unwrap();

    let request = CommandGroupRequest {
        group_id: "86000000-0000-4000-8000-000000000001".to_owned(),
        project_id: initial.id.clone(),
        base_revision: initial.revision.number,
        commands: vec![ProjectCommand::SetTrackHidden {
            command_id: "86000000-0000-4000-8000-000000000002".to_owned(),
            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
            track_id: CAPTION_TRACK_ID.to_owned(),
            hidden: true,
        }],
    };
    let transition = commit_transition(&initial, &request, "2026-08-08T00:05:00Z").unwrap();
    let mut commands = request.commands;
    let ProjectCommand::SetTrackHidden { sequence_id, .. } = &mut commands[0] else {
        unreachable!()
    };
    *sequence_id = "86000000-0000-4000-8000-000000000099".to_owned();
    let record = with_record_hash(&JournalRecord {
        kind: JournalRecordKind::Commit,
        record_number: 1,
        operation_id: transition.operation_id.clone(),
        group_id: transition.group_id.clone(),
        committed_at: transition.snapshot.updated_at.clone(),
        base_revision: transition.prior_revision.clone(),
        resulting_revision: transition.snapshot.revision.clone(),
        commands,
        history_group: transition.history_group.clone(),
        summary: transition.history_group.summary.clone(),
        affected_ranges: transition.applied.affected_ranges.clone(),
        cache_invalidations: transition.applied.cache_invalidations.clone(),
        previous_state_hash: transition.prior_revision.state_hash.clone(),
        resulting_state_hash: transition.snapshot.revision.state_hash.clone(),
        payload_hash: None,
        idempotency_result: None,
        previous_record_hash: header.header_hash,
        record_hash: String::new(),
    })
    .unwrap();
    let journal = journal_path(&project_path).unwrap();
    let mut record_bytes = canonical_bytes(&record).unwrap();
    record_bytes.push(b'\n');
    fs::OpenOptions::new()
        .append(true)
        .open(&journal)
        .unwrap()
        .write_all(&record_bytes)
        .unwrap();
    let scanned = scan(&journal).unwrap();
    assert_eq!(scanned.tail, TailClassification::Clean);
    assert_eq!(scanned.records, vec![record]);
    let journal_before = fs::read(&journal).unwrap();

    let owner = "tampered-command-owner";
    let service = VideoProjectService::default();
    let error = service
        .open(
            owner,
            &project_path,
            &crate::video::VideoPathGrants::default(),
        )
        .unwrap_err();
    assert_eq!(
        error.code,
        crate::video::error::VideoErrorCode::InvalidProject
    );
    assert_eq!(error.details["category"], "record_replay");
    let close_error = service.close(owner, &initial.id).unwrap_err();
    assert_eq!(
        close_error.code,
        crate::video::error::VideoErrorCode::InvalidProject
    );
    assert_eq!(close_error.details["category"], "unknown_session");
    assert_eq!(fs::read(&journal).unwrap(), journal_before);
    assert_eq!(
        read_snapshot(&project_path).unwrap().revision,
        initial.revision
    );
}

#[test]
fn tampered_affected_range_journal_fails_closed_without_repair_or_session() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("tampered-range-journal.svpvideo");
    let mut initial = caption_project_fixture();
    fs::write(&project_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    fs::create_dir_all(sidecar_path(&project_path).unwrap()).unwrap();
    let header = create_journal_for_snapshot(&project_path, &mut initial).unwrap();
    let request = CommandGroupRequest {
        group_id: "86000000-0000-4000-8000-000000000001".to_owned(),
        project_id: initial.id.clone(),
        base_revision: initial.revision.number,
        commands: vec![ProjectCommand::SetTrackHidden {
            command_id: "86000000-0000-4000-8000-000000000002".to_owned(),
            sequence_id: CAPTION_SEQUENCE_ID.to_owned(),
            track_id: CAPTION_TRACK_ID.to_owned(),
            hidden: true,
        }],
    };
    let transition = commit_transition(&initial, &request, "2026-08-08T00:05:00Z").unwrap();
    let mut ranges = transition.applied.affected_ranges.clone();
    assert!(!ranges.is_empty());
    assert_eq!(ranges[0].start.rate_numerator, ranges[0].end.rate_numerator);
    assert_eq!(
        ranges[0].start.rate_denominator,
        ranges[0].end.rate_denominator
    );
    ranges[0].end.rate_numerator *= 2;
    let record = with_record_hash(&JournalRecord {
        kind: JournalRecordKind::Commit,
        record_number: 1,
        operation_id: transition.operation_id.clone(),
        group_id: transition.group_id.clone(),
        committed_at: transition.snapshot.updated_at.clone(),
        base_revision: transition.prior_revision.clone(),
        resulting_revision: transition.snapshot.revision.clone(),
        commands: request.commands,
        history_group: transition.history_group.clone(),
        summary: transition.history_group.summary.clone(),
        affected_ranges: ranges,
        cache_invalidations: transition.applied.cache_invalidations.clone(),
        previous_state_hash: transition.prior_revision.state_hash.clone(),
        resulting_state_hash: transition.snapshot.revision.state_hash.clone(),
        payload_hash: None,
        idempotency_result: None,
        previous_record_hash: header.header_hash,
        record_hash: String::new(),
    })
    .unwrap();
    let journal = journal_path(&project_path).unwrap();
    let mut record_bytes = canonical_bytes(&record).unwrap();
    record_bytes.push(b'\n');
    fs::OpenOptions::new()
        .append(true)
        .open(&journal)
        .unwrap()
        .write_all(&record_bytes)
        .unwrap();
    let scanned = scan(&journal).unwrap();
    assert_eq!(scanned.tail, TailClassification::Clean);
    assert_eq!(scanned.records, vec![record]);
    let journal_before = fs::read(&journal).unwrap();
    let project_before = fs::read(&project_path).unwrap();
    let owner = "tampered-range-owner";
    let service = VideoProjectService::default();
    let error = service
        .open(
            owner,
            &project_path,
            &crate::video::VideoPathGrants::default(),
        )
        .unwrap_err();
    assert_eq!(
        error.code,
        crate::video::error::VideoErrorCode::InvalidProject
    );
    assert_eq!(error.details["category"], "record_replay");
    let close_error = service.close(owner, &initial.id).unwrap_err();
    assert_eq!(close_error.details["category"], "unknown_session");
    assert_eq!(fs::read(&journal).unwrap(), journal_before);
    assert_eq!(fs::read(&project_path).unwrap(), project_before);
}

#[test]
fn tampered_caption_artifact_snapshot_fails_closed() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("tampered-caption.svpvideo");
    let initial = caption_project_fixture();
    let artifact = caption_artifact_for(&initial, "A");
    let mut snapshot = commit_transition(
        &initial,
        &caption_request(&initial, "84000000-0000-4000-8000-000000000001", artifact),
        "2026-08-08T00:03:00Z",
    )
    .unwrap()
    .snapshot;
    let ProjectTrack::Caption {
        active_caption_artifact: Some(artifact),
        ..
    } = &mut snapshot.state.sequences[0].tracks[0]
    else {
        unreachable!()
    };
    artifact.cues[0].lines.clear();
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    fs::write(&project_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let error = VideoProjectService::default()
        .open(
            "tampered-owner",
            &project_path,
            &crate::video::VideoPathGrants::default(),
        )
        .unwrap_err();
    assert_eq!(
        error.code,
        crate::video::error::VideoErrorCode::InvalidProject
    );
}
