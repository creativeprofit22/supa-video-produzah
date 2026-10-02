//! Phase 15: graphics clips exported through the render plan (docs/adr/0003-graphics-clips.md).
//!
//! Commands create a graphics clip, a motion preset is applied as one command built by the
//! TypeScript `applyMotionPreset`, the TypeScript compiler builds the render plan, and the real
//! Rust export renders the overlay, composites it and checks sampled frames against references.
//! Needs the renderer built (`cargo build --release --locked` in `graphics-renderer/`).

use super::graphics_export::{
    check_fixture_references, crate_root, pinned_ffmpeg, renderer_exe, run_media, scratch_entries,
    Fixture, Tolerance,
};
use super::*;

const OWNER: &str = "graphics-clip-export";

/// A named mutation applied to a JSON render plan under test.
type PlanMutation = (&'static str, Box<dyn Fn(&mut Value)>);

/// Exported frames: before the clip, its first frame, middle, last frame and after it.
const GRAPHICS_EXPORT: Fixture = Fixture {
    file: "",
    prefix: "graphics-export-",
    width: 1280,
    height: 720,
    samples: &[5, 10, 30, 49, 55],
};
/// Exports render with the automatic backend, so edges may be GPU- or CPU-antialiased.
const EXPORT_COMPOSITE: Tolerance = Tolerance {
    max: 255,
    mean: 2.0,
    over_edge_threshold: 0.01,
};

fn programs_with_renderer(root: &Path) -> MediaPrograms {
    let destination = root.join("media-tools");
    fs::create_dir_all(&destination).unwrap();
    let staged = crate_root().join("media-toolchain/bin/x86_64-pc-windows-msvc");
    for name in ["ffmpeg.exe", "ffprobe.exe"] {
        fs::copy(staged.join(name), destination.join(name))
            .expect("pinned resources missing: run media:bootstrap:windows");
    }
    let toolchain = crate::video::toolchain::MediaToolchain::resolve_from_resource_root(root);
    MediaPrograms::bundled(
        crate::video::toolchain::MediaToolchainState::from_ready(toolchain)
            .with_graphics_renderer(renderer_exe()),
    )
}

fn node_json(arguments: &[&std::ffi::OsStr]) -> Value {
    serde_json::from_slice(&run_media(
        Command::new("node")
            .arg(crate_root().join("../browser-tests/compile-graphics-export.mjs"))
            .args(arguments),
    ))
    .unwrap()
}

fn uid(value: u64) -> String {
    format!("7f000000-0000-4000-8000-{value:012x}")
}

fn hold(value: f64) -> Value {
    serde_json::json!([{ "timeMicroseconds": 0, "value": value }])
}

fn time(value: u64) -> Value {
    serde_json::json!({ "value": value, "rateNumerator": 30, "rateDenominator": 1 })
}

fn execute_group(
    service: &crate::video::project::service::VideoProjectService,
    grants: &VideoPathGrants,
    project_id: &str,
    base_revision: u64,
    group: u64,
    commands: Value,
) -> crate::video::project::types::CommandResult {
    service
        .execute(
            OWNER,
            serde_json::from_value(serde_json::json!({
                "groupId": uid(group),
                "projectId": project_id,
                "baseRevision": base_revision,
                "commands": commands,
            }))
            .unwrap(),
            grants,
        )
        .unwrap()
}

fn graphics_clip_json(clip_id: &str, logo_asset: &str) -> Value {
    serde_json::json!({
        "graphicsVersion": 1, "id": clip_id,
        "timelineStart": time(10), "duration": time(40), "fontKey": "arial-bold",
        "layers": [
            { "kind": "rect", "width": 640, "height": 160, "cornerRadius": 24, "fill": "#1E3A8A",
              "x": hold(320.0), "y": hold(480.0), "scale": hold(1.0), "rotation": hold(0.0),
              "opacity": hold(0.9) },
            { "kind": "text", "text": "Graphics export", "fontSize": 56, "fill": "#FFFFFF",
              "x": hold(380.0), "y": hold(532.0), "scale": hold(1.0), "rotation": hold(0.0),
              "opacity": hold(1.0) },
            { "kind": "image", "assetId": logo_asset, "width": 96, "height": 96,
              "x": hold(1100.0), "y": hold(80.0), "scale": hold(1.0), "rotation": hold(0.0),
              "opacity": hold(1.0) }
        ]
    })
}

fn base_clip_json(clip_id: &str, asset_id: &str) -> Value {
    serde_json::json!({
        "id": clip_id, "source": { "kind": "asset", "assetId": asset_id },
        "timelineStart": time(0), "sourceIn": time(0), "sourceOut": time(60),
        "speed": { "numerator": 1, "denominator": 1 },
        "transform": { "positionXPermille": 0, "positionYPermille": 0,
            "scaleXPermille": 1000, "scaleYPermille": 1000,
            "rotationMilliDegrees": 0, "opacityPermille": 1000 },
        "gainMilliDecibels": 0
    })
}

#[tokio::test]
async fn graphics_clip_exports_through_render_plan() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let programs = programs_with_renderer(workspace.path());
    let (width, height) = (1280_usize, 720_usize);
    let base_path = workspace.path().join("base.mp4");
    // A diagonal gradient base makes misplaced or opaque overlay pixels visible.
    run_media(
        Command::new(&ffmpeg)
            .args(["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!(
                "gradients=s={width}x{height}:r=30:d=2:c0=0xC04020:c1=0x20A060:x0=0:y0=0:x1={width}:y1={height}:speed=0:seed=1"
            ))
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"])
            .args(["-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1"])
            .arg(&base_path),
    );
    let logo_path = workspace.path().join("logo.png");
    fs::copy(
        crate_root().join("graphics-renderer/fixtures/images/badge.png"),
        &logo_path,
    )
    .unwrap();
    let grants = VideoPathGrants::default();
    let base = grants
        .grant_existing_file(OWNER, GrantCategory::Source, &base_path)
        .unwrap();
    let logo = grants
        .grant_existing_file(OWNER, GrantCategory::Source, &logo_path)
        .unwrap();
    let project_path = grants
        .grant_destination(
            OWNER,
            GrantCategory::Project,
            &workspace.path().join("graphics.svpvideo"),
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
    let logo_probe = crate::video::still_image::probe_still_image(&logo, &|_| {}).unwrap();
    let service = crate::video::project::service::VideoProjectService::default();
    let created = service
        .create(OWNER, &project_path, "Graphics export", &grants)
        .unwrap();
    let base_asset = uid(1);
    let logo_asset = uid(2);
    let sequence = uid(3);
    let video_track = uid(4);
    let graphics_track = uid(5);
    let graphics_clip = uid(7);

    let built = execute_group(
        &service,
        &grants,
        &created.project_id,
        created.revision.number,
        100,
        serde_json::json!([
            { "type": "ImportAsset", "commandId": uid(101), "asset": {
                "id": base_asset, "displayName": "base.mp4",
                "locator": { "absolutePath": base }, "probe": base_probe } },
            { "type": "ImportAsset", "commandId": uid(102), "asset": {
                "id": logo_asset, "displayName": "logo.png",
                "locator": { "absolutePath": logo }, "probe": logo_probe } },
            { "type": "CreateSequence", "commandId": uid(103), "activeSequenceId": sequence,
              "sequence": {
                "id": sequence, "name": "Main", "rate": { "numerator": 30, "denominator": 1 },
                "width": width, "height": height, "audioSampleRate": 48_000, "markers": [],
                "tracks": [
                    { "id": graphics_track, "name": "Titles", "kind": "graphics",
                      "graphicsClips": [] },
                    { "id": video_track, "name": "Video", "kind": "video", "clips": [] }
                ] } },
            { "type": "InsertClip", "commandId": uid(104), "sequenceId": sequence,
              "trackId": video_track, "clip": base_clip_json(&uid(6), &base_asset) },
            { "type": "AddGraphicsClip", "commandId": uid(105), "sequenceId": sequence,
              "trackId": graphics_track,
              "graphicsClip": graphics_clip_json(&graphics_clip, &logo_asset) }
        ]),
    );

    // One undoable command from the TypeScript preset builder: layers pop in one after another.
    let preset_request = workspace.path().join("preset.json");
    fs::write(
        &preset_request,
        serde_json::to_vec(&serde_json::json!({
            "state": built.projection.state,
            "clip": { "sequenceId": sequence, "trackId": graphics_track,
                      "graphicsClipId": graphics_clip },
            "request": { "kind": "staggeredEntrance", "name": "pop",
                         "staggerMicroseconds": 120_000 },
            "commandId": uid(201),
        }))
        .unwrap(),
    )
    .unwrap();
    let preset_command = node_json(&["--preset".as_ref(), preset_request.as_os_str()]);
    assert_eq!(preset_command["type"], "SetGraphicsClipLayers");
    let applied = execute_group(
        &service,
        &grants,
        &created.project_id,
        built.new_revision.number,
        200,
        serde_json::json!([preset_command]),
    );
    assert_eq!(applied.new_revision.number, built.new_revision.number + 1);
    let state = serde_json::to_value(&applied.projection.state).unwrap();
    let layers = &state["sequences"][0]["tracks"][0]["graphicsClips"][0]["layers"];
    assert_eq!(layers.as_array().unwrap().len(), 3);
    assert!(
        layers[2]["scale"].as_array().unwrap().len() > 1,
        "preset animates scale"
    );

    let plan_request = workspace.path().join("plan.json");
    fs::write(
        &plan_request,
        serde_json::to_vec(&serde_json::json!({
            "planId": uid(300),
            "revision": { "revision": applied.new_revision, "state": applied.projection.state },
            "inputPathsByAssetId": { base_asset.clone(): base },
            "graphicsImagePathsByAssetId": { logo_asset.clone(): logo },
            "outputPath": output,
        }))
        .unwrap(),
    )
    .unwrap();
    let plan = node_json(&["--project".as_ref(), plan_request.as_os_str()]);
    assert_eq!(plan["graphics"].as_array().map(Vec::len), Some(1));
    let argv: Vec<&str> = plan["argv"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(argv.windows(2).any(|pair| pair == ["-i", "graphics:0"]));
    // Rust re-validates the TypeScript plan, including its byte-exact argv.
    // Rust rebuilds the argv from the plan and accepts only byte-identical TypeScript output.
    let tampered: [PlanMutation; 4] = [
        (
            "shifted window",
            Box::new(|plan| plan["graphics"][0]["startMicroseconds"] = 1.into()),
        ),
        (
            "extra image path",
            Box::new(|plan| {
                plan["graphics"][0]["imagePathsByAssetId"][uid(99)] = Value::from("C:\\x.png")
            }),
        ),
        (
            "renamed sentinel",
            Box::new(|plan| {
                let argv = plan["argv"].as_array_mut().unwrap();
                let position = argv.iter().position(|item| item == "graphics:0").unwrap();
                argv[position] = Value::from("graphics:1");
            }),
        ),
        (
            "dropped overlay",
            Box::new(|plan| {
                plan.as_object_mut().unwrap().remove("graphics");
            }),
        ),
    ];
    for (name, mutate) in tampered {
        let mut changed = plan.clone();
        mutate(&mut changed);
        assert!(
            parse_and_validate_render_plan(changed, OWNER, &grants).is_err(),
            "{name} must be rejected"
        );
    }
    let validated = parse_and_validate_render_plan(plan, OWNER, &grants).unwrap();
    assert_eq!(validated.graphics_image_paths.get(&logo_asset), Some(&logo));
    let (request, captured) = registered_render_worker(
        validated,
        false,
        workspace.path().join("render-cache"),
        programs,
    );

    run_render_worker(request).await;

    let events = captured_render_events(&captured);
    assert_worker_event_order(&events);
    assert!(
        matches!(events.last(), Some(VideoRenderEvent::Completed { .. })),
        "{events:?}"
    );
    let leftovers: Vec<_> = fs::read_dir(workspace.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".svp-graphics-") || name.contains(".partial"))
        .collect();
    assert!(leftovers.is_empty(), "scratch left behind: {leftovers:?}");
    check_fixture_references(
        &ffmpeg,
        &output,
        &GRAPHICS_EXPORT,
        "composite",
        "rgb24",
        EXPORT_COMPOSITE,
    );
}

fn export_input(clip: Value) -> crate::video::types::RenderGraphicsInputV2 {
    serde_json::from_value(serde_json::json!({
        "trackId": uid(2),
        "clip": clip,
        "startMicroseconds": 0,
        "endMicroseconds": 1_000_000,
        "imagePathsByAssetId": {},
    }))
    .unwrap()
}

fn title_clip() -> Value {
    serde_json::json!({
        "graphicsVersion": 1, "id": uid(9),
        "timelineStart": time(0), "duration": time(30), "fontKey": "arial-regular",
        "layers": [{ "kind": "text", "text": "Title", "fontSize": 48, "fill": "#FFFFFF",
            "x": hold(10.0), "y": hold(10.0), "scale": hold(1.0), "rotation": hold(0.0),
            "opacity": [
                { "timeMicroseconds": 0, "value": 0,
                  "easing": { "kind": "preset", "name": "snappy" } },
                { "timeMicroseconds": 500_000, "value": 1 }
            ] }]
    })
}

fn rate_30() -> crate::video::types::RationalRate {
    crate::video::types::RationalRate {
        numerator: 30,
        denominator: 1,
    }
}

#[tokio::test]
async fn export_graphics_render_into_scratch_and_clean_up_on_drop() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let parent = workspace.path().join("out");
    fs::create_dir_all(&parent).unwrap();
    let records = std::sync::Mutex::new(Vec::new());
    let renderer = renderer_exe();

    let rendered = crate::video::graphics_export::render_export_graphics(
        &[export_input(title_clip())],
        &rate_30(),
        (640, 360),
        &std::collections::BTreeMap::new(),
        &parent,
        crate::video::graphics_export::GraphicsPrograms {
            renderer: &renderer,
            ffmpeg: &ffmpeg,
        },
        &ProcessCancellation::new(),
        &|record| records.lock().unwrap().push(record.clone()),
    )
    .await
    .unwrap();

    assert_eq!(rendered.overlays.len(), 1);
    assert!(rendered.overlays[0].starts_with(&parent));
    assert!(rendered.overlays[0].is_file());
    let records = records.into_inner().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].outcome, "succeeded");
    drop(rendered);
    assert!(
        scratch_entries(&parent).is_empty(),
        "{:?}",
        scratch_entries(&parent)
    );
}

#[tokio::test]
async fn cancelled_export_graphics_leave_no_scratch() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let parent = workspace.path().join("out");
    fs::create_dir_all(&parent).unwrap();
    let cancellation = ProcessCancellation::new();
    cancellation.cancel();
    let records = std::sync::Mutex::new(Vec::new());
    let renderer = renderer_exe();

    let result = crate::video::graphics_export::render_export_graphics(
        &[export_input(title_clip())],
        &rate_30(),
        (640, 360),
        &std::collections::BTreeMap::new(),
        &parent,
        crate::video::graphics_export::GraphicsPrograms {
            renderer: &renderer,
            ffmpeg: &ffmpeg,
        },
        &cancellation,
        &|record| records.lock().unwrap().push(record.clone()),
    )
    .await;

    let error = result.err().expect("cancelled render must fail");
    assert_eq!(error.code, VideoErrorCode::ProcessCancelled);
    assert_eq!(records.into_inner().unwrap()[0].outcome, "cancelled");
    assert!(
        scratch_entries(&parent).is_empty(),
        "{:?}",
        scratch_entries(&parent)
    );
}

#[test]
fn graphics_sentinels_are_swapped_exactly_once() {
    let overlays = [PathBuf::from(r"C:\scratch\graphics-0.mov")];
    let mut arguments: Vec<String> = ["-i", "base.mp4", "-i", "graphics:0", "-filter_complex", "x"]
        .map(str::to_owned)
        .to_vec();

    crate::video::graphics_export::swap_graphics_sentinels(&mut arguments, &overlays).unwrap();

    assert_eq!(arguments[3], r"C:\scratch\graphics-0.mov");
    for broken in [
        vec!["-i", "base.mp4"],
        vec!["-i", "graphics:0", "-i", "graphics:0"],
        vec!["graphics:0", "-i", "base.mp4"],
    ] {
        let mut arguments: Vec<String> = broken.into_iter().map(str::to_owned).collect();
        assert!(
            crate::video::graphics_export::swap_graphics_sentinels(&mut arguments, &overlays)
                .is_err(),
            "{arguments:?}"
        );
    }
}

/// The installer bundles the renderer folder where the app looks for it at run time.
#[test]
fn bundled_renderer_resources_match_the_runtime_path() {
    let overlay: Value = serde_json::from_slice(
        &fs::read(crate_root().join("tauri.media-tools.windows.conf.json")).unwrap(),
    )
    .unwrap();
    let resources = overlay["bundle"]["resources"].as_object().unwrap();
    let bundled: Vec<&str> = resources
        .values()
        .filter_map(Value::as_str)
        .filter(|target| target.starts_with("graphics-renderer/"))
        .collect();

    assert!(bundled.contains(&crate::video::toolchain::GRAPHICS_RENDERER_RESOURCE));
    // The renderer imports these FFmpeg 9 libraries; they must sit beside it.
    for library in [
        "avcodec-63.dll",
        "avformat-63.dll",
        "avutil-61.dll",
        "swscale-10.dll",
    ] {
        assert!(
            bundled.contains(&format!("graphics-renderer/{library}").as_str()),
            "{library} is not bundled"
        );
    }
    for source in resources
        .iter()
        .filter(|(_, target)| {
            target
                .as_str()
                .is_some_and(|t| t.starts_with("graphics-renderer/"))
        })
        .map(|(source, _)| source)
    {
        assert!(
            source.starts_with("graphics-renderer/target/release/"),
            "{source} must come from the renderer build output"
        );
    }
}
