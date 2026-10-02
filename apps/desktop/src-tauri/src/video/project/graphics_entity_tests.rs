use std::{fs, path::Path};

use serde_json::{json, Value};

use super::{
    graphics::{migrate_graphics_clip, valid_graphics_clip_shape, GraphicsClip},
    hash::{canonical_bytes, state_hash},
    integrity::validate_snapshot,
    migration::migrate_v1_bytes,
    snapshot::read_snapshot,
    types::{ProjectTrack, VideoProjectSnapshotV2},
};
use crate::video::error::VideoErrorCode;

/// A named mutation applied to a JSON value under test.
type JsonMutation = (&'static str, Box<dyn Fn(&mut Value)>);

fn fixture_path(name: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/video-contracts/fixtures")
        .join(name)
}

fn fixture_json(name: &str) -> Value {
    serde_json::from_slice(&fs::read(fixture_path(name)).unwrap()).unwrap()
}

fn graphics_clip_json() -> Value {
    fixture_json("project-v2/valid-graphics.svpvideo")["state"]["sequences"][0]["tracks"][1]
        ["graphicsClips"][0]
        .clone()
}

#[test]
fn pre_graphics_and_graphics_v2_fixtures_round_trip_byte_identically() {
    for name in [
        "valid-minimal",
        "valid-mixed-rate",
        "valid-relative-source",
        "valid-graphics",
    ] {
        let original = fixture_json(&format!("project-v2/{name}.svpvideo"));
        let snapshot: VideoProjectSnapshotV2 = serde_json::from_value(original.clone()).unwrap();
        validate_snapshot(&snapshot).unwrap();
        assert_eq!(serde_json::to_value(&snapshot).unwrap(), original, "{name}");
        assert_eq!(
            canonical_bytes(&snapshot).unwrap(),
            canonical_bytes(&original).unwrap(),
            "{name}"
        );
        assert_eq!(
            state_hash(&snapshot.state).unwrap(),
            snapshot.revision.state_hash,
            "{name}"
        );
    }
}

#[test]
fn v1_fixtures_still_migrate_without_graphics_tracks() {
    for name in ["valid-minimal", "valid-padded-nonblank", "valid-null-audio"] {
        let bytes = fs::read(fixture_path(&format!("project-v1/{name}.svpvideo"))).unwrap();
        let snapshot = migrate_v1_bytes(&bytes).unwrap();
        assert!(snapshot
            .state
            .sequences
            .iter()
            .flat_map(|sequence| &sequence.tracks)
            .all(|track| !matches!(track, ProjectTrack::Graphics { .. })));
    }
}

#[test]
fn graphics_fixture_loads_every_layer_kind() {
    let snapshot: VideoProjectSnapshotV2 =
        serde_json::from_value(fixture_json("project-v2/valid-graphics.svpvideo")).unwrap();
    let clips = snapshot.state.sequences[0].tracks[1]
        .graphics_clips()
        .expect("graphics track");
    let kinds: Vec<_> = clips[0]
        .layers
        .iter()
        .map(|layer| serde_json::to_value(layer).unwrap()["kind"].clone())
        .collect();
    assert_eq!(kinds, [json!("rect"), json!("text"), json!("image")]);
}

#[test]
fn migrate_graphics_clip_accepts_version_one_unchanged() {
    let value = graphics_clip_json();
    let clip = migrate_graphics_clip(&value).unwrap();
    assert_eq!(serde_json::to_value(&clip).unwrap(), value);
}

#[test]
fn migrate_graphics_clip_rejects_future_versions_as_unsupported_schema() {
    for version in [2, 7] {
        let mut value = graphics_clip_json();
        value["graphicsVersion"] = json!(version);
        let error = migrate_graphics_clip(&value).unwrap_err();
        assert_eq!(error.code, VideoErrorCode::UnsupportedSchema, "{version}");
    }
}

#[test]
fn migrate_graphics_clip_rejects_malformed_versions_as_invalid_project() {
    for version in [json!(null), json!(0), json!("1"), json!(1.5)] {
        let mut value = graphics_clip_json();
        value["graphicsVersion"] = version.clone();
        let error = migrate_graphics_clip(&value).unwrap_err();
        assert_eq!(error.code, VideoErrorCode::InvalidProject, "{version}");
    }
}

#[test]
fn reading_a_future_graphics_project_fails_with_unsupported_schema() {
    let error =
        read_snapshot(&fixture_path("project-v2/graphics-future-version.svpvideo")).unwrap_err();
    assert_eq!(error.code, VideoErrorCode::UnsupportedSchema);
}

#[test]
fn graphics_clip_bounds_match_the_typescript_schema() {
    let cases: Vec<JsonMutation> = vec![
        (
            "zero duration",
            Box::new(|clip| clip["duration"]["value"] = json!(0)),
        ),
        (
            "duration over the limit",
            Box::new(|clip| clip["duration"]["value"] = json!(36_001)),
        ),
        (
            "mixed rates",
            Box::new(|clip| clip["duration"]["rateNumerator"] = json!(25)),
        ),
        (
            "65 layers",
            Box::new(|clip| {
                let layer = clip["layers"][0].clone();
                clip["layers"] = Value::Array(vec![layer; 65]);
            }),
        ),
        (
            "unordered keyframes",
            Box::new(|clip| clip["layers"][0]["x"][1]["timeMicroseconds"] = json!(0)),
        ),
        (
            "empty track",
            Box::new(|clip| clip["layers"][0]["scale"] = json!([])),
        ),
        (
            "opacity above one",
            Box::new(|clip| clip["layers"][2]["opacity"][0]["value"] = json!(1.5)),
        ),
        (
            "bad fill",
            Box::new(|clip| clip["layers"][0]["fill"] = json!("red")),
        ),
        (
            "corner radius too big",
            Box::new(|clip| clip["layers"][0]["cornerRadius"] = json!(41)),
        ),
        (
            "control characters",
            Box::new(|clip| {
                clip["layers"][1]["text"] = json!("a\u{7}");
                clip["layers"][1].as_object_mut().unwrap().remove("units");
            }),
        ),
        (
            "unit count mismatch",
            Box::new(|clip| clip["layers"][1]["text"] = json!("Hello big graphics")),
        ),
        (
            "spring bounce out of range",
            Box::new(|clip| {
                clip["layers"][1]["units"]["offsetY"][0][0]["easing"]["bounce"] = json!(2)
            }),
        ),
        (
            "zero steps",
            Box::new(|clip| clip["layers"][0]["opacity"][0]["easing"]["count"] = json!(0)),
        ),
    ];
    for (name, mutate) in cases {
        let mut value = graphics_clip_json();
        mutate(&mut value);
        let parsed = serde_json::from_value::<GraphicsClip>(value);
        assert!(
            parsed.is_err() || !valid_graphics_clip_shape(&parsed.unwrap()),
            "{name} must be rejected"
        );
    }
}

#[test]
fn graphics_clip_rejects_unknown_fields_and_string_easing() {
    for mutate in [
        Box::new(|clip: &mut Value| clip["extra"] = json!(1)) as Box<dyn Fn(&mut Value)>,
        Box::new(|clip: &mut Value| clip["layers"][0]["x"][0]["easing"] = json!("snappy")),
        Box::new(|clip: &mut Value| {
            clip["layers"][0]["x"][0]["easing"] = json!({ "kind": "linear", "extra": true })
        }),
    ] {
        let mut value = graphics_clip_json();
        mutate(&mut value);
        assert!(serde_json::from_value::<GraphicsClip>(value).is_err());
    }
}
