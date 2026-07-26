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
        AffectedRange, ClipSource, ClipTransform, CommandGroupRequest, JournalHeader,
        JournalRecord, JournalRecordKind, ProjectCaption, ProjectClip, ProjectCommand,
        ProjectHistoryEntryV2, ProjectMarker, ProjectTrack, RecoveryStatus, VideoProjectSnapshotV2,
        VideoProjectStateV2,
    },
};
use crate::video::{
    grants::GrantCategory,
    project_io::VideoSourceStatus,
    types::{AssetLocator, RationalTime},
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
            captions,
        },
    );
    original_sequence.tracks.push(ProjectTrack::Audio {
        id: "90000000-0000-4000-8000-000000000502".to_owned(),
        name: "Audio".to_owned(),
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
fn generated_10k_record_journal_scans_below_reopen_budget() {
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
    let budget = if cfg!(debug_assertions) {
        Duration::from_secs(5)
    } else {
        Duration::from_secs(2)
    };
    assert!(
        elapsed < budget,
        "10k journal scan took {elapsed:?} with budget {budget:?}"
    );
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
