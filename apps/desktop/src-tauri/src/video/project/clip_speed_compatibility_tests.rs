use std::{fs, path::Path};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    clip_timing::{normalize_speed, ClipSpeed},
    commands::apply_group,
    hash::{canonical_bytes, canonical_hash, state_hash},
    integrity::{validate_snapshot, validate_state},
    migration::migrate_v1_bytes,
    types::{ProjectClip, ProjectCommand, ProjectTrack, VideoProjectSnapshotV2},
};

fn fixture_json(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures")
        .join(name);
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn fixture() -> VideoProjectSnapshotV2 {
    serde_json::from_value(fixture_json("project-v2/valid-relative-source.svpvideo")).unwrap()
}

fn first_clip(snapshot: &mut VideoProjectSnapshotV2) -> &mut ProjectClip {
    let ProjectTrack::Video { clips, .. } = &mut snapshot.state.sequences[0].tracks[0] else {
        panic!("Expected video fixture");
    };
    &mut clips[0]
}

#[test]
fn legacy_omitted_speed_keeps_snapshot_bytes_and_state_hashes() {
    for name in ["valid-minimal", "valid-mixed-rate", "valid-relative-source"] {
        let original = fixture_json(&format!("project-v2/{name}.svpvideo"));
        let snapshot: VideoProjectSnapshotV2 = serde_json::from_value(original.clone()).unwrap();
        validate_snapshot(&snapshot).unwrap();
        assert_eq!(serde_json::to_value(&snapshot).unwrap(), original);
        assert_eq!(
            canonical_bytes(&snapshot).unwrap(),
            canonical_bytes(&original).unwrap()
        );
        assert_eq!(
            state_hash(&snapshot.state).unwrap(),
            snapshot.revision.state_hash
        );
        assert!(!String::from_utf8(canonical_bytes(&snapshot).unwrap())
            .unwrap()
            .contains("\"speed\""));
    }
}

#[test]
fn normal_speed_restoration_omits_field_and_restores_legacy_hash() {
    let original = fixture();
    let mut changed = original.clone();
    first_clip(&mut changed).speed = Some(ClipSpeed {
        numerator: 3,
        denominator: 2,
    });
    assert_ne!(
        state_hash(&changed.state).unwrap(),
        original.revision.state_hash
    );
    // Exercise the edit normalization primitive; SetClipSpeed is not implemented yet.
    first_clip(&mut changed).speed = normalize_speed(ClipSpeed::default()).unwrap();
    assert_eq!(changed, original);
    assert_eq!(
        state_hash(&changed.state).unwrap(),
        original.revision.state_hash
    );
    assert_eq!(
        canonical_bytes(&changed).unwrap(),
        canonical_bytes(&original).unwrap()
    );
    validate_snapshot(&changed).unwrap();
}

#[test]
fn reading_explicit_normal_speed_does_not_rewrite_its_representation() {
    let mut snapshot = fixture();
    first_clip(&mut snapshot).speed = Some(ClipSpeed::default());
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    let bytes = canonical_bytes(&snapshot).unwrap();
    let decoded: VideoProjectSnapshotV2 = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(decoded, snapshot);
    assert_eq!(canonical_bytes(&decoded).unwrap(), bytes);
    validate_snapshot(&decoded).unwrap();
}

#[test]
fn nonnormal_speed_round_trips_and_native_admission_requires_exact_duration() {
    for speed in [
        ClipSpeed {
            numerator: 1,
            denominator: 2,
        },
        ClipSpeed {
            numerator: 51,
            denominator: 100,
        },
        ClipSpeed {
            numerator: 3,
            denominator: 2,
        },
        ClipSpeed {
            numerator: 2,
            denominator: 1,
        },
    ] {
        let mut snapshot = fixture();
        let before = first_clip(&mut snapshot).clone();
        first_clip(&mut snapshot).speed = Some(speed);
        snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
        let bytes = canonical_bytes(&snapshot).unwrap();
        let mut decoded: VideoProjectSnapshotV2 = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded, snapshot);
        assert_eq!(canonical_bytes(&decoded).unwrap(), bytes);
        assert_eq!(
            state_hash(&decoded.state).unwrap(),
            snapshot.revision.state_hash
        );
        let clip = first_clip(&mut decoded);
        assert_eq!(clip.source_in, before.source_in);
        assert_eq!(clip.source_out, before.source_out);
        assert_eq!(clip.timeline_start, before.timeline_start);
        if speed.numerator == 51 {
            assert!(validate_snapshot(&decoded).is_err());
        } else {
            validate_snapshot(&decoded).unwrap();
        }
    }
}

#[test]
fn invalid_serialized_speeds_are_rejected_at_the_clip_boundary() {
    #[derive(Deserialize)]
    struct InvalidFixture {
        name: String,
        speed: Value,
    }
    let cases: Vec<InvalidFixture> =
        serde_json::from_value(fixture_json("clip-speed-invalid.json")).unwrap();
    let mut snapshot = fixture();
    let original = serde_json::to_value(first_clip(&mut snapshot)).unwrap();
    for case in cases {
        let mut value = original.clone();
        value["speed"] = case.speed;
        assert!(
            serde_json::from_value::<ProjectClip>(value).is_err(),
            "{}",
            case.name
        );
    }
    // Typed native callers cannot bypass the domain validator either.
    first_clip(&mut snapshot).speed = Some(ClipSpeed {
        numerator: 2,
        denominator: 2,
    });
    assert!(validate_state(&snapshot.state).is_err());
}

#[test]
fn v1_migration_keeps_speed_omitted_and_original_timing() {
    let original = fixture_json("clip-speed-legacy-v1.json");
    let mut migrated = migrate_v1_bytes(&serde_json::to_vec(&original).unwrap()).unwrap();
    let clip = first_clip(&mut migrated);
    assert_eq!(clip.speed, None);
    let legacy_clip = &original["revisions"][0]["state"]["sequence"]["videoTracks"][0]["clips"][0];
    let wire = serde_json::to_value(clip).unwrap();
    for field in ["sourceIn", "sourceOut", "timelineStart"] {
        assert_eq!(wire[field], legacy_clip[field]);
    }
    assert!(wire.get("speed").is_none());
    validate_snapshot(&migrated).unwrap();
    assert_eq!(
        state_hash(&migrated.state).unwrap(),
        migrated.revision.state_hash
    );
    let decoded: VideoProjectSnapshotV2 =
        serde_json::from_slice(&canonical_bytes(&migrated).unwrap()).unwrap();
    assert_eq!(decoded, migrated);
    let mut invalid = original;
    invalid["revisions"][0]["state"]["sequence"]["videoTracks"][0]["clips"][0]["speed"] =
        json!({"numerator":3,"denominator":2});
    assert!(migrate_v1_bytes(&serde_json::to_vec(&invalid).unwrap()).is_err());
}

#[test]
fn inserted_speed_clip_uses_retimed_duration_without_mutating_the_base() {
    let mut snapshot = fixture();
    let mut clip = first_clip(&mut snapshot).clone();
    clip.id = "10000000-0000-4000-8000-000000000009".into();
    clip.timeline_start.value = 30;
    clip.speed = Some(ClipSpeed {
        numerator: 3,
        denominator: 2,
    });
    let before = canonical_hash(&snapshot).unwrap();
    let command = ProjectCommand::InsertClip {
        command_id: "10000000-0000-4000-8000-000000000010".into(),
        sequence_id: snapshot.state.sequences[0].id.clone(),
        track_id: snapshot.state.sequences[0].tracks[0].id().to_owned(),
        index: None,
        clip,
    };
    let applied = apply_group(&snapshot.state, &[command]).unwrap();
    assert!(applied
        .affected_ranges
        .iter()
        .any(|range| range.start.value == 30 && range.end.value == 50));
    assert_eq!(
        apply_group(&applied.state, &applied.inverse_commands)
            .unwrap()
            .state,
        snapshot.state
    );
    assert_eq!(canonical_hash(&snapshot).unwrap(), before);
}
