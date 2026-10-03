//! Agent graphics end to end (phase 19, ADR 0005): the TypeScript-generated golden graphics
//! proposal (`packages/video-contracts/fixtures/agent-graphics-proposal.json`, written by
//! `packages/video-produce/src/first-cut-graphics.test.ts`) is submitted for review, approved,
//! exported through the graphics renderer and checked by QC.
//! Needs the renderer built (`cargo build --release --locked` in `graphics-renderer/`).

use super::graphics_clip_export::{node_json, programs_with_renderer};
use super::graphics_export::{decode_samples, pinned_ffmpeg, run_media, Fixture};
use super::*;
use crate::video::{
    project::proposal::NativeProposalStatus,
    qc::{EditorialEvaluation, QcSeverity, QcStatus, RenderQcContext},
};

const OWNER: &str = "agent-graphics-e2e";
const NOW_MS: u64 = 1_750_000_000_000;
const WIDTH: usize = 1280;
const HEIGHT: usize = 720;

/// Frames inside the title card (0–26) and the lower third (30–56), plus one after both.
const SAMPLES: Fixture = Fixture {
    file: "",
    prefix: "",
    width: WIDTH,
    height: HEIGHT,
    samples: &[15, 45, 58],
};

fn uid(value: u64) -> String {
    format!("7e000000-0000-4000-8000-{value:012x}")
}

fn time(value: u64) -> Value {
    serde_json::json!({ "value": value, "rateNumerator": 30, "rateDenominator": 1 })
}

fn golden_proposal() -> Value {
    serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/video-contracts/fixtures/agent-graphics-proposal.json"),
        )
        .expect("golden agent graphics proposal"),
    )
    .unwrap()
}

/// Points the golden proposal at this test's project, revision and sequence; everything the
/// agent authored (items, clips, layers, track insert) is left byte-for-byte as generated.
fn patched_proposal(
    golden: &Value,
    project_id: &str,
    revision: &crate::video::project::types::ProjectRevisionDescriptorV2,
    sequence_id: &str,
) -> Value {
    let mut proposal = golden.clone();
    proposal["projectId"] = Value::from(project_id);
    proposal["projectRevision"] = serde_json::to_value(revision).unwrap();
    proposal["sequenceId"] = Value::from(sequence_id);
    let group = &mut proposal["commandGroup"];
    group["projectId"] = Value::from(project_id);
    group["baseRevision"] = Value::from(revision.number);
    for command in group["commands"].as_array_mut().unwrap() {
        command["sequenceId"] = Value::from(sequence_id);
    }
    proposal
}

/// Mean absolute RGB difference inside a pixel rectangle.
fn region_mean_diff(a: &[u8], b: &[u8], (x0, y0, x1, y1): (usize, usize, usize, usize)) -> f64 {
    let mut total = 0_u64;
    let mut count = 0_u64;
    for y in y0..y1 {
        for x in x0..x1 {
            let offset = (y * WIDTH + x) * 3;
            for channel in 0..3 {
                total += u64::from(a[offset + channel].abs_diff(b[offset + channel]));
                count += 1;
            }
        }
    }
    total as f64 / count as f64
}

/// Bounding box of a clip's layers at rest, from its first keyframes.
fn clip_region(clip: &Value) -> (usize, usize, usize, usize) {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, 0.0_f64, 0.0_f64);
    for layer in clip["layers"].as_array().unwrap() {
        let x = layer["x"][0]["value"].as_f64().unwrap();
        let y = layer["y"][0]["value"].as_f64().unwrap();
        let (w, h) = match layer["kind"].as_str().unwrap() {
            "text" => {
                let size = layer["fontSize"].as_f64().unwrap();
                let characters = layer["text"].as_str().unwrap().chars().count() as f64;
                (characters * size * 0.55, size)
            }
            _ => (
                layer["width"].as_f64().unwrap(),
                layer["height"].as_f64().unwrap(),
            ),
        };
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x + w);
        y1 = y1.max(y + h);
    }
    let clamp = |value: f64, limit: usize| (value.max(0.0) as usize).min(limit);
    (
        clamp(x0, WIDTH),
        clamp(y0, HEIGHT),
        clamp(x1, WIDTH),
        clamp(y1, HEIGHT),
    )
}

#[tokio::test]
async fn agent_graphics_proposal_is_reviewed_applied_exported_and_qced() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let programs = programs_with_renderer(workspace.path());
    let base_path = workspace.path().join("base.mp4");
    // A moving test pattern keeps QC's black/freeze detectors quiet on the base itself.
    run_media(
        Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg(format!("testsrc2=s={WIDTH}x{HEIGHT}:r=30:d=2"))
            .args([
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=2",
            ])
            .args([
                "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1",
            ])
            .arg(&base_path),
    );
    let grants = VideoPathGrants::default();
    let base = grants
        .grant_existing_file(OWNER, GrantCategory::Source, &base_path)
        .unwrap();
    let project_path = grants
        .grant_destination(
            OWNER,
            GrantCategory::Project,
            &workspace.path().join("agent-graphics.svpvideo"),
        )
        .unwrap();
    let output = grants
        .grant_destination(
            OWNER,
            GrantCategory::Output,
            &workspace.path().join("export.mp4"),
        )
        .unwrap();
    let ffprobe = programs.verified_ffprobe("probe_media").await.unwrap();
    let base_probe = crate::video::probe::probe_media_with_program(
        OWNER,
        &grants,
        &base,
        ffprobe,
        ProcessCancellation::new(),
    )
    .await
    .unwrap();
    let service = crate::video::project::service::VideoProjectService::default();
    let created = service
        .create(OWNER, &project_path, "Agent graphics", &grants)
        .unwrap();
    let (asset, sequence, video_track) = (uid(1), uid(3), uid(4));

    // A one-clip project with no graphics track: the proposal must create its own.
    let built = service
        .execute(
            OWNER,
            serde_json::from_value(serde_json::json!({
                "groupId": uid(100),
                "projectId": created.project_id,
                "baseRevision": created.revision.number,
                "commands": [
                    { "type": "ImportAsset", "commandId": uid(101), "asset": {
                        "id": asset, "displayName": "base.mp4",
                        "locator": { "absolutePath": base }, "probe": base_probe } },
                    { "type": "CreateSequence", "commandId": uid(102), "activeSequenceId": sequence,
                      "sequence": {
                        "id": sequence, "name": "Main", "rate": { "numerator": 30, "denominator": 1 },
                        "width": WIDTH, "height": HEIGHT, "audioSampleRate": 48_000, "markers": [],
                        "tracks": [{ "id": video_track, "name": "Video", "kind": "video", "clips": [] }] } },
                    { "type": "InsertClip", "commandId": uid(103), "sequenceId": sequence,
                      "trackId": video_track, "clip": {
                        "id": uid(6), "source": { "kind": "asset", "assetId": asset },
                        "timelineStart": time(0), "sourceIn": time(0), "sourceOut": time(60),
                        "speed": { "numerator": 1, "denominator": 1 },
                        "transform": { "positionXPermille": 0, "positionYPermille": 0,
                            "scaleXPermille": 1000, "scaleYPermille": 1000,
                            "rotationMilliDegrees": 0, "opacityPermille": 1000 },
                        "gainMilliDecibels": 0 } }
                ],
            }))
            .unwrap(),
            &grants,
        )
        .unwrap();

    // Submit: the proposal is pending and the project is untouched.
    let golden = golden_proposal();
    let proposal = patched_proposal(&golden, &created.project_id, &built.new_revision, &sequence);
    let stored = service
        .submit_proposal(OWNER, &created.project_id, &proposal, NOW_MS, 60_000)
        .unwrap();
    assert_eq!(stored.status, NativeProposalStatus::Pending);
    let listing = service
        .list_proposals(OWNER, &created.project_id, NOW_MS + 1)
        .unwrap();
    assert_eq!(listing.proposals.len(), 1);
    let inspected = service
        .inspector(OWNER, &created.project_id)
        .expect("project stays open");
    assert_eq!(
        inspected.revision, built.new_revision,
        "submitting must not change the project"
    );

    // Approve every item: one new revision with the graphics track and both clips.
    let applied = service
        .apply_proposal(
            OWNER,
            &created.project_id,
            stored.proposal_id.as_str(),
            &proposal,
            NOW_MS + 2,
            &grants,
        )
        .unwrap();
    assert_eq!(applied.new_revision.number, built.new_revision.number + 1);
    let state = serde_json::to_value(&applied.projection.state).unwrap();
    let tracks = state["sequences"][0]["tracks"].as_array().unwrap();
    let graphics = tracks
        .iter()
        .find(|track| track["id"] == golden["trackId"])
        .expect("graphics track created by the proposal");
    assert_eq!(graphics["kind"], "graphics");
    let clips = graphics["graphicsClips"].as_array().unwrap();
    let offered: Vec<&Value> = golden["commandGroup"]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|command| command["type"] == "AddGraphicsClip")
        .map(|command| &command["graphicsClip"])
        .collect();
    assert_eq!(clips.len(), offered.len());
    for (clip, expected) in clips.iter().zip(&offered) {
        assert_eq!(clip["id"], expected["id"]);
        assert_eq!(clip["timelineStart"], expected["timelineStart"]);
    }

    // Export through the TypeScript render plan and the graphics renderer, with QC on.
    let plan_request = workspace.path().join("plan.json");
    fs::write(
        &plan_request,
        serde_json::to_vec(&serde_json::json!({
            "planId": uid(300),
            "revision": { "revision": applied.new_revision, "state": applied.projection.state },
            "inputPathsByAssetId": { asset.clone(): base },
            "graphicsImagePathsByAssetId": {},
            "outputPath": output,
        }))
        .unwrap(),
    )
    .unwrap();
    let plan = node_json(&["--project".as_ref(), plan_request.as_os_str()]);
    // One overlay per approved graphics clip.
    assert_eq!(
        plan["graphics"].as_array().map(Vec::len),
        Some(offered.len())
    );
    let mut validated = parse_and_validate_render_plan(plan, OWNER, &grants).unwrap();
    let state_hash = applied.state_hash.clone();
    validated.qc = Some(RenderQcContext {
        revision_state_hash: state_hash.clone(),
        editorial: EditorialEvaluation {
            evaluator_version: "editorial-v1".to_owned(),
            revision_id: validated.plan.revision_id().as_str().to_owned(),
            revision_state_hash: state_hash,
            findings: Vec::new(),
        },
        delivery: None,
    });
    let (request, captured) = registered_render_worker(
        validated,
        false,
        workspace.path().join("render-cache"),
        programs,
    );

    run_render_worker(request).await;

    let events = captured_render_events(&captured);
    assert_worker_event_order(&events);
    let Some(VideoRenderEvent::Completed {
        output: rendered, ..
    }) = events.last()
    else {
        panic!("export must complete: {events:?}");
    };

    // QC ran on the export and found nothing blocking.
    let qc = rendered.qc.as_ref().expect("QC result attached");
    let blockers: Vec<_> = qc
        .findings
        .iter()
        .filter(|finding| finding.severity == QcSeverity::Blocker)
        .collect();
    assert!(blockers.is_empty(), "QC blockers: {blockers:?}");
    assert_ne!(qc.status, QcStatus::Blocked);

    // The cards are visible: frames inside each card differ from the base in its region,
    // and the frame after both cards matches the base there.
    let exported = decode_samples(&ffmpeg, &output, "rgb24", &SAMPLES);
    let reference = decode_samples(&ffmpeg, &base_path, "rgb24", &SAMPLES);
    let title_region = clip_region(offered[0]);
    let lower_region = clip_region(offered[1]);
    let title_diff = region_mean_diff(&exported[0], &reference[0], title_region);
    let lower_diff = region_mean_diff(&exported[1], &reference[1], lower_region);
    let after_diff = region_mean_diff(&exported[2], &reference[2], lower_region);
    println!(
        "AGENT_GRAPHICS title_diff={title_diff:.2} lower_diff={lower_diff:.2} after_diff={after_diff:.2}"
    );
    assert!(title_diff > 10.0, "title card not visible: {title_diff}");
    assert!(lower_diff > 10.0, "lower third not visible: {lower_diff}");
    assert!(
        after_diff < 4.0,
        "graphics linger after their clips: {after_diff}"
    );
}
