//! Graphics overlay clips end to end: the fframes renderer sidecar, the pinned FFmpeg encoder and
//! the existing export path. Needs the renderer built (`cargo build --release --locked` in
//! `graphics-renderer/`, see docs/adr/0002-graphics-render-engine.md); missing tools fail the test.
//!
//! Reference frames live in `tests/fixtures/graphics/`. They were generated with the CPU backend
//! by running these tests with `SUPA_GRAPHICS_WRITE_REFERENCES=1` and inspected before commit.

use super::*;
use crate::video::graphics_render::{
    render_graphics_overlay, render_graphics_overlay_with_test_environment, GraphicsBackend,
    GraphicsOverlay, GraphicsProgress, GraphicsRenderError, GraphicsRenderLog,
    GraphicsRenderRequest,
};

const WIDTH: usize = 1080;
const HEIGHT: usize = 1920;
const FRAMES: u32 = 60;

/// A description fixture and the frames its references sample.
pub(super) struct Fixture {
    pub(super) file: &'static str,
    /// Reference file prefix: `{prefix}{kind}-{frame}.png`.
    pub(super) prefix: &'static str,
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) samples: &'static [u32],
}

/// The phase 14 test graphic: slide-in card and fading title.
const TEST_GRAPHIC: Fixture = Fixture {
    file: "test-graphic-9x16.json",
    prefix: "",
    width: WIDTH,
    height: HEIGHT,
    samples: &[0, 15, 30, 45, 59],
};
/// Phase 15 motion: spring scale, bezier and eased rotation, steps, an embedded PNG image and a
/// per-word text reveal (`scripts/generate-motion-graphic-fixture.py`).
const MOTION_GRAPHIC: Fixture = Fixture {
    file: "motion-graphic-16x9.json",
    prefix: "motion-",
    width: 1280,
    height: 720,
    samples: &[0, 4, 10, 20, 47],
};
const OWNER: &str = "graphics-export";

pub(super) fn crate_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

pub(super) fn renderer_exe() -> PathBuf {
    let path = env::var_os("SUPA_GRAPHICS_RENDERER").map_or_else(
        || crate_root().join("graphics-renderer/target/release/supa-graphics-render.exe"),
        PathBuf::from,
    );
    assert!(
        path.is_file(),
        "graphics renderer missing at {}: build graphics-renderer (docs/adr/0002-graphics-render-engine.md) or set SUPA_GRAPHICS_RENDERER",
        path.display()
    );
    path
}

fn description_fixture() -> PathBuf {
    fixture_path(&TEST_GRAPHIC)
}

fn fixture_path(fixture: &Fixture) -> PathBuf {
    crate_root()
        .join("graphics-renderer/fixtures")
        .join(fixture.file)
}

fn reference_dir() -> PathBuf {
    crate_root().join("tests/fixtures/graphics")
}

fn writing_references() -> bool {
    env::var_os("SUPA_GRAPHICS_WRITE_REFERENCES").is_some_and(|value| value == "1")
}

pub(super) async fn pinned_ffmpeg(root: &Path) -> PathBuf {
    let programs = super::qc_export::bundled_programs(root);
    PathBuf::from(programs.verified_ffmpeg("graphics_export").await.unwrap())
}

pub(super) fn run_media(command: &mut Command) -> Vec<u8> {
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    result.stdout
}

/// Decodes the sample frames of `path` as packed RGBA (or RGB) bytes, one buffer per frame.
pub(super) fn decode_samples(
    ffmpeg: &Path,
    path: &Path,
    pixel_format: &str,
    fixture: &Fixture,
) -> Vec<Vec<u8>> {
    let select = fixture
        .samples
        .iter()
        .map(|frame| format!("eq(n\\,{frame})"))
        .collect::<Vec<_>>()
        .join("+");
    let bytes = run_media(
        Command::new(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-v", "error", "-i"])
            .arg(path)
            .args(["-map", "0:v:0", "-vf"])
            .arg(format!("select='{select}'"))
            .args(["-fps_mode", "passthrough", "-pix_fmt", pixel_format])
            .args(["-f", "rawvideo", "pipe:1"]),
    );
    let frame_len = fixture.width * fixture.height * channels(pixel_format);
    assert_eq!(
        bytes.len(),
        frame_len * fixture.samples.len(),
        "{}",
        path.display()
    );
    bytes.chunks(frame_len).map(<[u8]>::to_vec).collect()
}

fn channels(pixel_format: &str) -> usize {
    match pixel_format {
        "rgba" => 4,
        "rgb24" => 3,
        other => panic!("unsupported pixel format {other}"),
    }
}

fn reference_path(fixture: &Fixture, kind: &str, frame: u32) -> PathBuf {
    reference_dir().join(format!("{}{kind}-{frame:03}.png", fixture.prefix))
}

fn write_reference(
    ffmpeg: &Path,
    fixture: &Fixture,
    kind: &str,
    frame: u32,
    pixel_format: &str,
    bytes: &[u8],
) {
    fs::create_dir_all(reference_dir()).unwrap();
    let mut child = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-v", "error", "-y"])
        .args(["-f", "rawvideo", "-pix_fmt", pixel_format])
        .args(["-s", &format!("{}x{}", fixture.width, fixture.height)])
        .args(["-i", "pipe:0", "-frames:v", "1", "-c:v", "png"])
        .arg(reference_path(fixture, kind, frame))
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    assert!(child.wait().unwrap().success());
}

fn read_reference(
    ffmpeg: &Path,
    fixture: &Fixture,
    kind: &str,
    frame: u32,
    pixel_format: &str,
) -> Vec<u8> {
    let path = reference_path(fixture, kind, frame);
    assert!(
        path.is_file(),
        "reference frame missing: {}",
        path.display()
    );
    run_media(
        Command::new(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-v", "error", "-i"])
            .arg(&path)
            .args(["-pix_fmt", pixel_format, "-f", "rawvideo", "pipe:1"]),
    )
}

#[derive(Debug)]
struct FrameDiff {
    max: u8,
    mean: f64,
    /// Share of pixels with any channel differing by more than `EDGE_THRESHOLD`.
    over_edge_threshold: f64,
}

const EDGE_THRESHOLD: i32 = 8;

/// Per-channel tolerances for one comparison.
#[derive(Debug, Clone, Copy)]
pub(super) struct Tolerance {
    pub(super) max: u8,
    pub(super) mean: f64,
    /// Allowed share of pixels over `EDGE_THRESHOLD`; GPU and CPU antialias edges differently.
    pub(super) over_edge_threshold: f64,
}

/// Same backend as the references: every pixel within a few levels.
const CPU_OVERLAY: Tolerance = Tolerance {
    max: 8,
    mean: 1.0,
    over_edge_threshold: 1.0,
};
/// H.264 4:2:0 round trip of the composite.
const CPU_COMPOSITE: Tolerance = Tolerance {
    max: 24,
    mean: 2.0,
    over_edge_threshold: 1.0,
};
/// GPU against CPU references: interiors match, only antialiased edge pixels may differ.
/// Measured: ≤ 0.08 % of pixels over 8, max 101, mean ≤ 0.02.
const GPU_OVERLAY: Tolerance = Tolerance {
    max: 255,
    mean: 1.0,
    over_edge_threshold: 0.0025,
};

/// Channel differences; with alpha, colour is compared premultiplied so the colour of
/// invisible pixels does not count.
fn frame_diff(actual: &[u8], expected: &[u8], channels: usize) -> FrameDiff {
    assert_eq!(actual.len(), expected.len());
    let premultiplied = |pixel: &[u8], index: usize| -> i32 {
        let value = i32::from(pixel[index]);
        if channels == 4 && index < 3 {
            (value * i32::from(pixel[3]) + 127) / 255
        } else {
            value
        }
    };
    let mut max = 0_i32;
    let mut total = 0_u64;
    let mut over = 0_usize;
    for (a, e) in actual.chunks(channels).zip(expected.chunks(channels)) {
        let mut pixel_max = 0_i32;
        for index in 0..channels {
            let diff = (premultiplied(a, index) - premultiplied(e, index)).abs();
            pixel_max = pixel_max.max(diff);
            total += u64::from(diff.unsigned_abs());
        }
        max = max.max(pixel_max);
        over += usize::from(pixel_max > EDGE_THRESHOLD);
    }
    let pixels = actual.len() / channels;
    FrameDiff {
        max: u8::try_from(max).unwrap(),
        mean: total as f64 / actual.len() as f64,
        over_edge_threshold: over as f64 / pixels as f64,
    }
}

/// Compares (or, when writing references, records) the sample frames of `path`.
fn check_against_references(
    ffmpeg: &Path,
    path: &Path,
    kind: &str,
    pixel_format: &str,
    tolerance: Tolerance,
) {
    check_fixture_references(ffmpeg, path, &TEST_GRAPHIC, kind, pixel_format, tolerance);
}

pub(super) fn check_fixture_references(
    ffmpeg: &Path,
    path: &Path,
    fixture: &Fixture,
    kind: &str,
    pixel_format: &str,
    tolerance: Tolerance,
) {
    let samples = decode_samples(ffmpeg, path, pixel_format, fixture);
    for (frame, actual) in fixture.samples.iter().zip(&samples) {
        if writing_references() {
            write_reference(ffmpeg, fixture, kind, *frame, pixel_format, actual);
            continue;
        }
        let expected = read_reference(ffmpeg, fixture, kind, *frame, pixel_format);
        let diff = frame_diff(actual, &expected, channels(pixel_format));
        println!(
            "GRAPHICS_REFERENCE fixture={} kind={kind} frame={frame} max={} mean={:.4} over8={:.4}%",
            fixture.file,
            diff.max,
            diff.mean,
            diff.over_edge_threshold * 100.0
        );
        assert!(
            diff.max <= tolerance.max
                && diff.mean <= tolerance.mean
                && diff.over_edge_threshold <= tolerance.over_edge_threshold,
            "{kind} frame {frame} differs from reference: {diff:?} (tolerance {tolerance:?})"
        );
    }
}

type CapturedLogs = Arc<Mutex<Vec<GraphicsRenderLog>>>;

async fn render_overlay(
    ffmpeg: &Path,
    output: &Path,
    backend: GraphicsBackend,
    cancellation: ProcessCancellation,
    on_frame: Option<GraphicsProgress>,
) -> (
    Result<GraphicsOverlay, GraphicsRenderError>,
    Vec<GraphicsRenderLog>,
) {
    render_fixture_overlay(
        &TEST_GRAPHIC,
        ffmpeg,
        output,
        backend,
        cancellation,
        on_frame,
    )
    .await
}

async fn render_fixture_overlay(
    fixture: &Fixture,
    ffmpeg: &Path,
    output: &Path,
    backend: GraphicsBackend,
    cancellation: ProcessCancellation,
    on_frame: Option<GraphicsProgress>,
) -> (
    Result<GraphicsOverlay, GraphicsRenderError>,
    Vec<GraphicsRenderLog>,
) {
    let renderer = renderer_exe();
    let description = fixture_path(fixture);
    let logs: CapturedLogs = Arc::default();
    let sink = {
        let logs = Arc::clone(&logs);
        move |record: &GraphicsRenderLog| logs.lock().unwrap().push(record.clone())
    };
    let result = render_graphics_overlay(
        GraphicsRenderRequest {
            renderer: &renderer,
            ffmpeg,
            description: &description,
            output,
            backend,
        },
        cancellation,
        on_frame,
        &sink,
    )
    .await;
    let records = logs.lock().unwrap().clone();
    (result, records)
}

/// Scratch entries the overlay pipeline creates next to its output.
pub(super) fn scratch_entries(directory: &Path) -> Vec<String> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".svp-graphics-"))
        .collect()
}

fn description_sha256() -> String {
    format!(
        "{:x}",
        Sha256::digest(fs::read(description_fixture()).unwrap())
    )
}

fn assert_success_log(records: &[GraphicsRenderLog], overlay: &GraphicsOverlay, requested: &str) {
    assert_eq!(records.len(), 1, "{records:?}");
    let record = &records[0];
    assert_eq!(record.event, "graphics_overlay_render");
    assert_eq!(record.outcome, "succeeded");
    assert_eq!(record.requested_backend, requested);
    assert_eq!(record.backend.as_deref(), Some(overlay.backend.as_str()));
    assert_eq!(record.gpu_fallback_reason, None);
    assert_eq!(overlay.gpu_fallback_reason, None);
    assert_eq!(record.frames, Some(FRAMES));
    assert_eq!(record.description_sha256, Some(description_sha256()));
    assert!(record.elapsed_ms > 0, "{record:?}");
}

// (a) + (f): overlay frames match the CPU references; one structured log record.
#[tokio::test]
async fn graphics_overlay_matches_reference_frames() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let output = workspace.path().join("overlay.mov");

    let (result, records) = render_overlay(
        &ffmpeg,
        &output,
        GraphicsBackend::Cpu,
        ProcessCancellation::new(),
        None,
    )
    .await;

    let overlay = result.unwrap();
    println!(
        "GRAPHICS_OVERLAY backend={} frames={} bytes={}",
        overlay.backend,
        overlay.frames,
        fs::metadata(&output).unwrap().len()
    );
    assert_eq!(overlay.output, output);
    assert_eq!(overlay.backend, "cpu");
    assert_eq!((overlay.width, overlay.height), (1080, 1920));
    assert_eq!(overlay.frame_rate, (30, 1));
    assert_eq!(overlay.frames, FRAMES);
    assert_success_log(&records, &overlay, "cpu");
    assert!(scratch_entries(workspace.path()).is_empty());
    // Every frame decodes, not just the sampled ones.
    run_media(
        Command::new(&ffmpeg)
            .args(["-hide_banner", "-nostdin", "-v", "error", "-i"])
            .arg(&output)
            .args(["-map", "0:v:0", "-f", "null", "-"]),
    );
    check_against_references(&ffmpeg, &output, "overlay", "rgba", CPU_OVERLAY);
}

// (a), GPU: the Vulkan backend matches the same references except for edge antialiasing.
#[tokio::test]
async fn graphics_overlay_gpu_matches_reference_frames() {
    if writing_references() {
        return;
    }
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let output = workspace.path().join("overlay-gpu.mov");

    let (result, records) = render_overlay(
        &ffmpeg,
        &output,
        GraphicsBackend::Gpu,
        ProcessCancellation::new(),
        None,
    )
    .await;

    let overlay = result.unwrap();
    assert_eq!(overlay.backend, "gpu");
    assert_success_log(&records, &overlay, "gpu");
    check_against_references(&ffmpeg, &output, "overlay", "rgba", GPU_OVERLAY);
}

// (b): the overlay clip composites over a base clip through the existing export path.
#[tokio::test]
async fn graphics_overlay_composites_through_export() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let programs = super::qc_export::bundled_programs(workspace.path());
    let overlay_path = workspace.path().join("overlay.mov");
    let (result, _) = render_overlay(
        &ffmpeg,
        &overlay_path,
        GraphicsBackend::Cpu,
        ProcessCancellation::new(),
        None,
    )
    .await;
    result.unwrap();
    // A diagonal gradient base makes misplaced or opaque overlay pixels visible.
    let base_path = workspace.path().join("base.mp4");
    run_media(
        Command::new(&ffmpeg)
            .args(["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!(
                "gradients=s={WIDTH}x{HEIGHT}:r=30:d=2:c0=0xC04020:c1=0x20A060:x0=0:y0=0:x1={WIDTH}:y1={HEIGHT}:speed=0:seed=1"
            ))
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"])
            .args(["-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1"])
            .arg(&base_path),
    );
    let grants = VideoPathGrants::default();
    let base = grants
        .grant_existing_file(OWNER, GrantCategory::Source, &base_path)
        .unwrap();
    let overlay = grants
        .grant_existing_file(OWNER, GrantCategory::Source, &overlay_path)
        .unwrap();
    let output = grants
        .grant_destination(
            OWNER,
            GrantCategory::Output,
            &workspace.path().join("export.mp4"),
        )
        .unwrap();
    let plan: Value = serde_json::from_slice(&run_media(
        Command::new("node")
            .arg(crate_root().join("../browser-tests/compile-graphics-export.mjs"))
            .args([&base, &overlay, &output])
            .args([WIDTH.to_string(), HEIGHT.to_string(), FRAMES.to_string()]),
    ))
    .unwrap();
    let validated = parse_and_validate_render_plan(plan, OWNER, &grants).unwrap();
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
    check_against_references(&ffmpeg, &output, "composite", "rgb24", CPU_COMPOSITE);
}

// (c): two renders of one description on one backend produce identical frames.
#[tokio::test]
async fn graphics_overlay_render_is_deterministic() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let mut runs = Vec::new();
    for name in ["first.mov", "second.mov"] {
        let output = workspace.path().join(name);
        let (result, _) = render_overlay(
            &ffmpeg,
            &output,
            GraphicsBackend::Auto,
            ProcessCancellation::new(),
            None,
        )
        .await;
        runs.push(result.unwrap());
    }

    let (first, second) = (&runs[0], &runs[1]);
    println!(
        "GRAPHICS_DETERMINISM backend={} frames={}",
        first.backend, first.frames
    );
    assert_eq!(first.backend, second.backend);
    assert_eq!(first.frame_sha256.len(), FRAMES as usize);
    assert_eq!(first.frame_sha256, second.frame_sha256);
    // The animation actually moves: not every frame is the same image.
    let distinct: std::collections::BTreeSet<_> = first.frame_sha256.iter().collect();
    assert!(distinct.len() > 30, "{} distinct frames", distinct.len());
    assert_eq!(
        fs::read(&first.output).unwrap(),
        fs::read(&second.output).unwrap(),
        "encoded overlays differ"
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RendererSummaryProbe {
    backend: String,
    gpu_fallback_reason: Option<String>,
    frames: u32,
}

// (d): with no usable Vulkan driver, `auto` renders on the CPU and says so.
#[test]
fn graphics_renderer_auto_falls_back_to_cpu_without_vulkan() {
    let frames_dir = tempdir().unwrap();
    let missing_driver = frames_dir.path().join("missing-icd.json");
    let mut command = Command::new(renderer_exe());
    command
        .arg("render")
        .arg("--description")
        .arg(description_fixture())
        .arg("--frames-dir")
        .arg(frames_dir.path())
        .args(["--backend", "auto"])
        // Real Vulkan loader failure: the loader is pointed at a driver manifest that does not exist.
        .env("VK_ICD_FILENAMES", &missing_driver)
        .env("VK_DRIVER_FILES", &missing_driver);

    let output = command.output().unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let summary = stdout
        .lines()
        .find_map(|line| line.strip_prefix("summary="))
        .expect("renderer summary");
    let summary: RendererSummaryProbe = serde_json::from_str(summary).unwrap();
    println!(
        "GRAPHICS_FALLBACK backend={} reason={:?}",
        summary.backend, summary.gpu_fallback_reason
    );
    assert_eq!(summary.backend, "cpu");
    assert!(summary
        .gpu_fallback_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("Vulkan")));
    assert_eq!(summary.frames, FRAMES);
    assert_eq!(
        fs::read_dir(frames_dir.path()).unwrap().count(),
        FRAMES as usize
    );

    let gpu_only = Command::new(renderer_exe())
        .arg("render")
        .arg("--description")
        .arg(description_fixture())
        .arg("--frames-dir")
        .arg(tempdir().unwrap().path())
        .args(["--backend", "gpu"])
        .env("VK_ICD_FILENAMES", &missing_driver)
        .env("VK_DRIVER_FILES", &missing_driver)
        .output()
        .unwrap();
    assert_eq!(
        gpu_only.status.code(),
        Some(3),
        "gpu must not silently fall back"
    );
}

// (d) through the app: the fallback reason reaches the overlay result and the structured log.
#[tokio::test]
async fn graphics_overlay_logs_gpu_fallback_reason_without_vulkan() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let output = workspace.path().join("fallback.mov");
    let missing_driver = workspace.path().join("missing-icd.json");
    let logs: CapturedLogs = Arc::default();
    let sink = {
        let logs = Arc::clone(&logs);
        move |record: &GraphicsRenderLog| logs.lock().unwrap().push(record.clone())
    };

    let result = render_graphics_overlay_with_test_environment(
        GraphicsRenderRequest {
            renderer: &renderer_exe(),
            ffmpeg: &ffmpeg,
            description: &description_fixture(),
            output: &output,
            backend: GraphicsBackend::Auto,
        },
        ProcessCancellation::new(),
        None,
        &sink,
        // Real Vulkan loader failure, set only on the renderer child.
        vec![
            (
                "VK_ICD_FILENAMES".into(),
                Some(missing_driver.clone().into()),
            ),
            ("VK_DRIVER_FILES".into(), Some(missing_driver.into())),
        ],
    )
    .await;

    let overlay = result.unwrap();
    let records = logs.lock().unwrap().clone();
    assert_eq!(records.len(), 1, "{records:?}");
    let record = &records[0];
    println!(
        "GRAPHICS_FALLBACK_LOG backend={:?} reason={:?}",
        record.backend, record.gpu_fallback_reason
    );
    assert_eq!(record.outcome, "succeeded");
    assert_eq!(record.requested_backend, "auto");
    assert_eq!(record.backend.as_deref(), Some("cpu"));
    assert!(
        record
            .gpu_fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Vulkan")),
        "{record:?}"
    );
    assert_eq!(overlay.backend, "cpu");
    assert_eq!(overlay.gpu_fallback_reason, record.gpu_fallback_reason);
    assert!(output.is_file());
}

// A family missing from the font file would render frames without text; the renderer rejects it
// as invalid input (exit code 2) instead.
#[tokio::test]
async fn graphics_overlay_rejects_font_family_missing_from_font_file() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let mut description: Value =
        serde_json::from_slice(&fs::read(description_fixture()).unwrap()).unwrap();
    description["font"]["family"] = Value::from("Helvetica");
    let description_path = workspace.path().join("wrong-family.json");
    fs::write(&description_path, serde_json::to_vec(&description).unwrap()).unwrap();
    let output = workspace.path().join("wrong-family.mov");

    let result = render_graphics_overlay(
        GraphicsRenderRequest {
            renderer: &renderer_exe(),
            ffmpeg: &ffmpeg,
            description: &description_path,
            output: &output,
            backend: GraphicsBackend::Cpu,
        },
        ProcessCancellation::new(),
        None,
        &|_: &GraphicsRenderLog| {},
    )
    .await;

    match result {
        Err(GraphicsRenderError::InvalidDescription(reason)) => assert!(
            reason.contains(r#"font family "Helvetica" is not in the font file"#)
                && reason.contains(r#""Arial""#),
            "{reason}"
        ),
        other => panic!("expected InvalidDescription, got {other:?}"),
    }
    assert!(!output.exists(), "rejected render promoted an output");
    assert_eq!(scratch_entries(workspace.path()), Vec::<String>::new());
}

// (e) + (f): cancelling mid-render promotes nothing, removes scratch files and logs once.
#[tokio::test]
async fn graphics_overlay_cancellation_leaves_nothing_behind() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let output = workspace.path().join("cancelled.mov");
    let cancellation = ProcessCancellation::new();
    let seen = Arc::new(Mutex::new(Vec::<u32>::new()));
    let on_frame: GraphicsProgress = {
        let cancellation = cancellation.clone();
        let seen = Arc::clone(&seen);
        Arc::new(move |frame| {
            seen.lock().unwrap().push(frame);
            cancellation.cancel();
        })
    };

    let (result, records) = render_overlay(
        &ffmpeg,
        &output,
        GraphicsBackend::Cpu,
        cancellation,
        Some(on_frame),
    )
    .await;

    assert_eq!(result, Err(GraphicsRenderError::Cancelled));
    let seen = seen.lock().unwrap().clone();
    assert!(
        !seen.is_empty(),
        "renderer reported no progress before cancel"
    );
    assert!(
        seen.len() < FRAMES as usize,
        "render ran to completion: {}",
        seen.len()
    );
    assert!(!output.exists(), "cancelled render promoted an output");
    assert_eq!(scratch_entries(workspace.path()), Vec::<String>::new());
    assert_eq!(records.len(), 1, "{records:?}");
    let record = &records[0];
    assert_eq!(record.event, "graphics_overlay_render");
    assert_eq!(record.outcome, "cancelled");
    assert_eq!(record.requested_backend, "cpu");
    assert_eq!(record.description_sha256, Some(description_sha256()));
    assert_eq!(record.backend, None);
    assert_eq!(record.gpu_fallback_reason, None);
    assert_eq!(record.frames, None);
}

// Phase 15: scale, rotation, spring and steps easing, an embedded image and a per-word reveal
// render to the CPU references.
#[tokio::test]
async fn motion_graphic_overlay_matches_reference_frames() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let output = workspace.path().join("motion.mov");

    let (result, records) = render_fixture_overlay(
        &MOTION_GRAPHIC,
        &ffmpeg,
        &output,
        GraphicsBackend::Cpu,
        ProcessCancellation::new(),
        None,
    )
    .await;

    let overlay = result.unwrap();
    assert_eq!((overlay.width, overlay.height), (1280, 720));
    assert_eq!(overlay.frames, 48);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].outcome, "succeeded");
    assert!(scratch_entries(workspace.path()).is_empty());
    check_fixture_references(
        &ffmpeg,
        &output,
        &MOTION_GRAPHIC,
        "overlay",
        "rgba",
        CPU_OVERLAY,
    );
}

#[tokio::test]
async fn motion_graphic_overlay_render_is_deterministic() {
    let workspace = tempdir().unwrap();
    let ffmpeg = pinned_ffmpeg(workspace.path()).await;
    let mut runs = Vec::new();
    for name in ["first.mov", "second.mov"] {
        let (result, _) = render_fixture_overlay(
            &MOTION_GRAPHIC,
            &ffmpeg,
            &workspace.path().join(name),
            GraphicsBackend::Cpu,
            ProcessCancellation::new(),
            None,
        )
        .await;
        runs.push(result.unwrap());
    }

    assert_eq!(runs[0].frame_sha256, runs[1].frame_sha256);
    let distinct: std::collections::BTreeSet<_> = runs[0].frame_sha256.iter().collect();
    // Motion settles by frame 41, so the tail repeats; everything before it moves.
    assert!(distinct.len() >= 40, "{} distinct frames", distinct.len());
    assert_eq!(
        fs::read(&runs[0].output).unwrap(),
        fs::read(&runs[1].output).unwrap(),
        "encoded overlays differ"
    );
}
