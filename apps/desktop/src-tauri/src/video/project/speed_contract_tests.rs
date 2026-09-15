use std::{fs, path::Path};

use serde_json::{json, Value};

use super::{
    clip_timing::project_clip_timeline_duration,
    commands::apply_group,
    hash::canonical_hash,
    integrity::validate_state,
    types::{ProjectCommand, ProjectTrack, VideoProjectSnapshotV2},
};
use crate::video::types::RenderClipTimingV2;

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
fn snapshot() -> VideoProjectSnapshotV2 {
    serde_json::from_value(fixture("project-v2/valid-relative-source.svpvideo")).unwrap()
}

#[test]
fn set_clip_speed_contract_round_trips_and_executes_only_exact_boundaries() {
    let original = fixture("clip-speed-command.json");
    let base = snapshot();
    let hash = canonical_hash(&base).unwrap();
    for percent in 50_u64..=200 {
        let (mut a, mut b) = (percent, 100);
        while b != 0 {
            (a, b) = (b, a % b);
        }
        let mut value = original.clone();
        value["speed"] = json!({"numerator":percent / a,"denominator":100 / a});
        let command: ProjectCommand = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&command).unwrap(), value);
        let applied = apply_group(&base.state, &[command]);
        assert_eq!(applied.is_ok(), 3000 % percent == 0, "{percent}%");
        if let Ok(applied) = applied {
            let restored = apply_group(&applied.state, &applied.inverse_commands).unwrap();
            assert_eq!(restored.state, base.state);
        }
    }
    assert_eq!(canonical_hash(&base).unwrap(), hash);
}

#[test]
fn set_clip_speed_rejects_shared_invalid_wire_values_and_extra_fields() {
    let original = fixture("clip-speed-command.json");
    for row in fixture("clip-speed-invalid.json").as_array().unwrap() {
        let mut value = original.clone();
        value["speed"] = row["speed"].clone();
        assert!(
            serde_json::from_value::<ProjectCommand>(value).is_err(),
            "{}",
            row["name"]
        );
    }
    let mut missing = original.clone();
    missing.as_object_mut().unwrap().remove("speed");
    assert!(serde_json::from_value::<ProjectCommand>(missing).is_err());
    let mut extra = original;
    extra["sourceIn"] = json!({"value":0,"rateNumerator":30,"rateDenominator":1});
    assert!(serde_json::from_value::<ProjectCommand>(extra).is_err());
}

#[test]
fn shared_fixtures_bind_native_clip_duration_and_render_metadata() {
    let mut base = snapshot();
    let ProjectTrack::Video { clips, .. } = &mut base.state.sequences[0].tracks[0] else {
        panic!("video fixture");
    };
    for row in fixture("clip-speed-timing.json").as_array().unwrap() {
        let mut clip = clips[0].clone();
        clip.source_in = serde_json::from_value(row["sourceIn"].clone()).unwrap();
        clip.source_out = serde_json::from_value(row["sourceOut"].clone()).unwrap();
        clip.timeline_start.rate_numerator = row["sequenceRate"]["numerator"].as_u64().unwrap();
        clip.timeline_start.rate_denominator = row["sequenceRate"]["denominator"].as_u64().unwrap();
        clip.speed = row
            .get("speed")
            .map(|speed| serde_json::from_value(speed.clone()).unwrap());
        let expected = row["expected"].as_u64();
        assert_eq!(
            project_clip_timeline_duration(&clip).ok(),
            expected,
            "{}",
            row["name"]
        );
        let value = json!({
            "sourceIn": row["sourceIn"], "sourceOut": row["sourceOut"],
            "speed": row.get("speed").cloned().unwrap_or(json!({"numerator":1,"denominator":1})),
            "outputDuration": {"value":expected.unwrap_or(1), "rateNumerator":clip.timeline_start.rate_numerator,"rateDenominator":clip.timeline_start.rate_denominator}
        });
        let decoded = serde_json::from_value::<RenderClipTimingV2>(value.clone());
        assert_eq!(decoded.is_ok(), expected.is_some(), "{}", row["name"]);
        if let Some(frames) = expected {
            assert_eq!(serde_json::to_value(decoded.unwrap()).unwrap(), value);
            let mut tampered = value;
            tampered["outputDuration"]["value"] = json!(frames + 1);
            assert!(serde_json::from_value::<RenderClipTimingV2>(tampered).is_err());
        }
    }
}

#[test]
fn render_timing_metadata_requires_all_fields_and_rejects_unknown_fields() {
    let value = json!({"sourceIn":{"value":0,"rateNumerator":30,"rateDenominator":1},"sourceOut":{"value":30,"rateNumerator":30,"rateDenominator":1},"speed":{"numerator":1,"denominator":1},"outputDuration":{"value":30,"rateNumerator":30,"rateDenominator":1}});
    for field in ["sourceIn", "sourceOut", "speed", "outputDuration"] {
        let mut partial = value.clone();
        partial.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<RenderClipTimingV2>(partial).is_err());
    }
    let mut extra = value.clone();
    extra["preservePitch"] = json!(false);
    assert!(serde_json::from_value::<RenderClipTimingV2>(extra).is_err());
    let mut null = value;
    null["speed"] = Value::Null;
    assert!(serde_json::from_value::<RenderClipTimingV2>(null).is_err());
}

#[test]
fn normal_speed_shared_duration_drives_adjacency_and_command_affected_ranges() {
    let mut base = snapshot();
    let sequence_id = base.state.sequences[0].id.clone();
    let track_id = base.state.sequences[0].tracks[0].id().to_owned();
    let ProjectTrack::Video { clips, .. } = &mut base.state.sequences[0].tracks[0] else {
        panic!("video fixture");
    };
    clips[0].source_in.rate_numerator = 60;
    clips[0].source_out.rate_numerator = 60;
    clips[0].source_out.value = 60;
    let mut next = clips[0].clone();
    next.id = "10000000-0000-4000-8000-000000000010".into();
    next.timeline_start.value = 30;
    let next_id = next.id.clone();
    clips.push(next);
    validate_state(&base.state).unwrap(); // Half-open adjacency at 30, not source frame 60.
    let command = ProjectCommand::MoveClip {
        command_id: "10000000-0000-4000-8000-000000000011".into(),
        sequence_id,
        track_id,
        clip_id: next_id,
        timeline_start: serde_json::from_value(
            json!({"value":60,"rateNumerator":30,"rateDenominator":1}),
        )
        .unwrap(),
    };
    let applied = apply_group(&base.state, &[command]).unwrap();
    assert!(applied
        .affected_ranges
        .iter()
        .any(|range| range.start.value == 60 && range.end.value == 90));
    let ProjectTrack::Video { clips, .. } = &mut base.state.sequences[0].tracks[0] else {
        panic!("video fixture");
    };
    clips[1].timeline_start.value = 29;
    assert!(validate_state(&base.state).is_err());
    let ProjectTrack::Video { clips, .. } = &mut base.state.sequences[0].tracks[0] else {
        panic!("video fixture");
    };
    clips[1].timeline_start.value = 30;
    clips[0].source_out.value = 59;
    assert!(validate_state(&base.state).is_err()); // 59@60 cannot become an exact 30 fps boundary.
}
