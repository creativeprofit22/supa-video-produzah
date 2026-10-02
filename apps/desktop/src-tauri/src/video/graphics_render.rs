//! Graphics overlay clips: runs the graphics renderer sidecar (fframes) to produce transparent
//! PNG frames, then the pinned FFmpeg to encode them into a QuickTime Animation (`qtrle`, ARGB)
//! `.mov` that the export path composites as an ordinary top video input.
//!
//! See docs/adr/0002-graphics-render-engine.md. Exports call it through `graphics_export.rs` (ADR 0003).

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::process::{run_supervised, ProcessCancellation, ProcessFailure, ProcessSpec};

const RENDER_OPERATION: &str = "graphics_render_frames";
const ENCODE_OPERATION: &str = "graphics_encode_overlay";
const LOG_EVENT: &str = "graphics_overlay_render";
/// Ceiling for one stage; the cancellation token is the user-facing stop.
const STAGE_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
/// The summary line carries one 64-char hash per frame (≤ 36 000 frames).
const RENDERER_STDOUT_LINE_LIMIT: usize = 4 * 1024 * 1024;
const STDERR_TAIL_LIMIT: usize = 16 * 1024;
const RENDERER_EXIT_INVALID_INPUT: i32 = 2;
/// The fallback reason is sidecar text that ends up in logs; keep it bounded.
const GPU_FALLBACK_REASON_LIMIT: usize = 512;

/// Child-environment overrides for the renderer. Only tests can set them; app builds always
/// launch the renderer with the app's own environment.
#[cfg(test)]
type RendererEnvironment = Vec<(OsString, Option<OsString>)>;
#[cfg(not(test))]
struct RendererEnvironment;

#[cfg(test)]
fn inherited_environment() -> RendererEnvironment {
    Vec::new()
}

#[cfg(not(test))]
fn inherited_environment() -> RendererEnvironment {
    RendererEnvironment
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GraphicsBackend {
    /// Exports use this: GPU when available, CPU otherwise.
    Auto,
    /// Forced backends exist for the reference-frame tests.
    #[cfg_attr(not(test), allow(dead_code))]
    Gpu,
    #[cfg_attr(not(test), allow(dead_code))]
    Cpu,
}

impl GraphicsBackend {
    fn as_arg(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Gpu => "gpu",
            Self::Cpu => "cpu",
        }
    }
}

pub(crate) struct GraphicsRenderRequest<'a> {
    /// The `supa-graphics-render` executable.
    pub(crate) renderer: &'a Path,
    /// The verified, pinned FFmpeg executable.
    pub(crate) ffmpeg: &'a Path,
    pub(crate) description: &'a Path,
    /// Final `.mov` path; scratch files live next to it and never survive the call.
    pub(crate) output: &'a Path,
    pub(crate) backend: GraphicsBackend,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GraphicsOverlay {
    pub(crate) output: PathBuf,
    pub(crate) backend: String,
    /// Why `auto` skipped the GPU, when it did.
    pub(crate) gpu_fallback_reason: Option<String>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) frame_rate: (u32, u32),
    pub(crate) frames: u32,
    /// SHA-256 of each rendered frame's RGBA bytes, in frame order.
    pub(crate) frame_sha256: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GraphicsRenderError {
    Cancelled,
    /// The renderer rejected the description (exit code 2).
    InvalidDescription(String),
    RendererFailed(String),
    EncodeFailed(String),
    Io(String),
}

impl GraphicsRenderError {
    fn outcome(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::InvalidDescription(_) => "invalid_description",
            Self::RendererFailed(_) => "renderer_failed",
            Self::EncodeFailed(_) => "encode_failed",
            Self::Io(_) => "io_failed",
        }
    }
}

/// One structured record per call, emitted on every path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphicsRenderLog {
    pub(crate) event: &'static str,
    pub(crate) description_sha256: Option<String>,
    pub(crate) requested_backend: &'static str,
    pub(crate) backend: Option<String>,
    /// Why `auto` skipped the GPU (for example a missing Vulkan driver); `None` when it did not.
    pub(crate) gpu_fallback_reason: Option<String>,
    pub(crate) frames: Option<u32>,
    pub(crate) outcome: &'static str,
    pub(crate) elapsed_ms: u64,
}

pub(crate) type GraphicsProgress = Arc<dyn Fn(u32) + Send + Sync + 'static>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RendererSummary {
    schema_version: u32,
    backend: String,
    gpu_fallback_reason: Option<String>,
    width: u32,
    height: u32,
    frame_rate: RendererFrameRate,
    frames: u32,
    description_sha256: String,
    frame_sha256: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RendererFrameRate {
    numerator: u32,
    denominator: u32,
}

/// Renders `request.description` into a transparent overlay clip at `request.output`.
///
/// The output appears only when every stage succeeded and `cancellation` is still active; the
/// scratch frame directory and partial clip are removed on every path. `on_frame` sees each
/// rendered frame index; `log` receives exactly one record.
pub(crate) async fn render_graphics_overlay(
    request: GraphicsRenderRequest<'_>,
    cancellation: ProcessCancellation,
    on_frame: Option<GraphicsProgress>,
    log: &(dyn Fn(&GraphicsRenderLog) + Sync),
) -> Result<GraphicsOverlay, GraphicsRenderError> {
    render_logged(
        request,
        cancellation,
        on_frame,
        log,
        inherited_environment(),
    )
    .await
}

/// [`render_graphics_overlay`] with the renderer launched under `environment` overrides, so tests
/// can reproduce driver conditions without touching this process's environment.
#[cfg(test)]
pub(crate) async fn render_graphics_overlay_with_test_environment(
    request: GraphicsRenderRequest<'_>,
    cancellation: ProcessCancellation,
    on_frame: Option<GraphicsProgress>,
    log: &(dyn Fn(&GraphicsRenderLog) + Sync),
    environment: RendererEnvironment,
) -> Result<GraphicsOverlay, GraphicsRenderError> {
    render_logged(request, cancellation, on_frame, log, environment).await
}

async fn render_logged(
    request: GraphicsRenderRequest<'_>,
    cancellation: ProcessCancellation,
    on_frame: Option<GraphicsProgress>,
    log: &(dyn Fn(&GraphicsRenderLog) + Sync),
    environment: RendererEnvironment,
) -> Result<GraphicsOverlay, GraphicsRenderError> {
    let started = Instant::now();
    let mut record = GraphicsRenderLog {
        event: LOG_EVENT,
        description_sha256: None,
        requested_backend: request.backend.as_arg(),
        backend: None,
        gpu_fallback_reason: None,
        frames: None,
        outcome: "succeeded",
        elapsed_ms: 0,
    };
    let result = render_stages(&request, cancellation, on_frame, environment, &mut record).await;
    if let Err(error) = &result {
        record.outcome = error.outcome();
    }
    record.elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    log(&record);
    result
}

async fn render_stages(
    request: &GraphicsRenderRequest<'_>,
    cancellation: ProcessCancellation,
    on_frame: Option<GraphicsProgress>,
    environment: RendererEnvironment,
    record: &mut GraphicsRenderLog,
) -> Result<GraphicsOverlay, GraphicsRenderError> {
    let description = std::fs::read(request.description).map_err(|error| {
        GraphicsRenderError::Io(format!("cannot read description: {}", error.kind()))
    })?;
    let description_sha256 = sha256_hex(&description);
    record.description_sha256 = Some(description_sha256.clone());

    let parent = request
        .output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| GraphicsRenderError::Io("output has no parent directory".to_owned()))?;
    let frames_dir = tempfile::Builder::new()
        .prefix(".svp-graphics-frames-")
        .tempdir_in(parent)
        .map_err(|error| {
            GraphicsRenderError::Io(format!("cannot create frame dir: {}", error.kind()))
        })?;

    let summary = run_renderer(
        request,
        frames_dir.path(),
        cancellation.clone(),
        on_frame,
        environment,
    )
    .await?;
    if summary.description_sha256 != description_sha256 {
        return Err(GraphicsRenderError::RendererFailed(
            "description changed while rendering".to_owned(),
        ));
    }
    record.backend = Some(summary.backend.clone());
    record
        .gpu_fallback_reason
        .clone_from(&summary.gpu_fallback_reason);
    record.frames = Some(summary.frames);

    let partial = tempfile::Builder::new()
        .prefix(".svp-graphics-overlay-")
        .suffix(".mov")
        .tempfile_in(parent)
        .map_err(|error| {
            GraphicsRenderError::Io(format!("cannot create partial overlay: {}", error.kind()))
        })?
        .into_temp_path();
    encode_overlay(
        request.ffmpeg,
        frames_dir.path(),
        &summary,
        &partial,
        cancellation.clone(),
    )
    .await?;
    drop(frames_dir);

    let size = std::fs::metadata(&partial)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    if size == 0 {
        return Err(GraphicsRenderError::EncodeFailed(
            "encoder wrote no data".to_owned(),
        ));
    }
    let output = request.output.to_path_buf();
    let committed = cancellation
        .commit_if_active(|| partial.persist(&output).map_err(|error| error.error))
        .map_err(|error| {
            GraphicsRenderError::Io(format!("cannot promote overlay: {}", error.kind()))
        })?;
    if committed.is_none() {
        return Err(GraphicsRenderError::Cancelled);
    }
    Ok(GraphicsOverlay {
        output,
        backend: summary.backend,
        gpu_fallback_reason: summary.gpu_fallback_reason,
        width: summary.width,
        height: summary.height,
        frame_rate: (summary.frame_rate.numerator, summary.frame_rate.denominator),
        frames: summary.frames,
        frame_sha256: summary.frame_sha256,
    })
}

async fn run_renderer(
    request: &GraphicsRenderRequest<'_>,
    frames_dir: &Path,
    cancellation: ProcessCancellation,
    on_frame: Option<GraphicsProgress>,
    environment: RendererEnvironment,
) -> Result<RendererSummary, GraphicsRenderError> {
    let summary_line: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(Mutex::new(None));
    let observer = {
        let summary_line = Arc::clone(&summary_line);
        Arc::new(move |record: &[u8]| {
            for line in record.split(|byte| *byte == b'\n') {
                if let Some(index) = line.strip_prefix(b"frame=") {
                    let index = std::str::from_utf8(index)
                        .ok()
                        .and_then(|index| index.parse::<u32>().ok());
                    if let (Some(index), Some(on_frame)) = (index, on_frame.as_ref()) {
                        on_frame(index);
                    }
                } else if let Some(json) = line.strip_prefix(b"summary=") {
                    *summary_line
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(json.to_vec());
                }
            }
        })
    };
    let args: Vec<OsString> = vec![
        "render".into(),
        "--description".into(),
        request.description.as_os_str().to_owned(),
        "--frames-dir".into(),
        frames_dir.as_os_str().to_owned(),
        "--backend".into(),
        request.backend.as_arg().into(),
    ];
    let spec = ProcessSpec {
        program: request.renderer.as_os_str().to_owned(),
        args,
        current_dir: None,
        operation: RENDER_OPERATION,
        timeout: STAGE_TIMEOUT,
        stdout_limit: RENDERER_STDOUT_LINE_LIMIT,
        stderr_tail_limit: STDERR_TAIL_LIMIT,
    };
    #[cfg(test)]
    let run = super::process::run_supervised_streaming_with_test_environment(
        spec,
        cancellation,
        environment,
        observer,
    )
    .await;
    #[cfg(not(test))]
    let run = {
        let RendererEnvironment = environment;
        super::process::run_supervised_streaming(spec, cancellation, observer).await
    };
    run.map_err(|failure| match failure {
        ProcessFailure::NonZero {
            exit_code: Some(RENDERER_EXIT_INVALID_INPUT),
            stderr_tail,
            ..
        } => GraphicsRenderError::InvalidDescription(stderr_text(&stderr_tail)),
        other => stage_failure(other, GraphicsRenderError::RendererFailed),
    })?;
    let line = summary_line
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
        .ok_or_else(|| {
            GraphicsRenderError::RendererFailed("renderer wrote no summary".to_owned())
        })?;
    parse_summary(&line)
}

fn parse_summary(line: &[u8]) -> Result<RendererSummary, GraphicsRenderError> {
    let invalid = |reason: &str| GraphicsRenderError::RendererFailed(format!("summary {reason}"));
    let mut summary: RendererSummary =
        serde_json::from_slice(line).map_err(|_| invalid("is not valid JSON"))?;
    summary.gpu_fallback_reason = summary
        .gpu_fallback_reason
        .map(|reason| bounded_text(&reason, GPU_FALLBACK_REASON_LIMIT));
    let is_hash = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if summary.schema_version != 1 {
        return Err(invalid("has an unknown schema version"));
    }
    if !matches!(summary.backend.as_str(), "gpu" | "cpu") {
        return Err(invalid("names an unknown backend"));
    }
    if summary.frames == 0
        || summary.frame_sha256.len() != summary.frames as usize
        || !summary.frame_sha256.iter().all(|hash| is_hash(hash))
        || !is_hash(&summary.description_sha256)
    {
        return Err(invalid("has inconsistent frame data"));
    }
    if summary.frame_rate.numerator == 0 || summary.frame_rate.denominator == 0 {
        return Err(invalid("has an invalid frame rate"));
    }
    Ok(summary)
}

async fn encode_overlay(
    ffmpeg: &Path,
    frames_dir: &Path,
    summary: &RendererSummary,
    partial: &Path,
    cancellation: ProcessCancellation,
) -> Result<(), GraphicsRenderError> {
    let pattern = frames_dir.join("%06d.png");
    let args: Vec<OsString> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-framerate".into(),
        format!(
            "{}/{}",
            summary.frame_rate.numerator, summary.frame_rate.denominator
        )
        .into(),
        "-start_number".into(),
        "0".into(),
        "-f".into(),
        "image2".into(),
        "-i".into(),
        pattern.into_os_string(),
        "-frames:v".into(),
        summary.frames.to_string().into(),
        "-an".into(),
        "-c:v".into(),
        "qtrle".into(),
        "-pix_fmt".into(),
        "argb".into(),
        "-f".into(),
        "mov".into(),
        partial.as_os_str().to_owned(),
    ];
    let spec = ProcessSpec {
        program: ffmpeg.as_os_str().to_owned(),
        args,
        current_dir: None,
        operation: ENCODE_OPERATION,
        timeout: STAGE_TIMEOUT,
        stdout_limit: 64 * 1024,
        stderr_tail_limit: STDERR_TAIL_LIMIT,
    };
    run_supervised(spec, cancellation)
        .await
        .map(|_| ())
        .map_err(|failure| stage_failure(failure, GraphicsRenderError::EncodeFailed))
}

fn stage_failure(
    failure: ProcessFailure,
    wrap: fn(String) -> GraphicsRenderError,
) -> GraphicsRenderError {
    match failure {
        ProcessFailure::Cancelled { .. } => GraphicsRenderError::Cancelled,
        ProcessFailure::Spawn { kind, .. } => wrap(format!("cannot start: {kind}")),
        ProcessFailure::Timeout { .. } => wrap("timed out".to_owned()),
        ProcessFailure::StdoutLimit { .. } => wrap("too much output".to_owned()),
        ProcessFailure::Io { .. } => wrap("pipe failure".to_owned()),
        ProcessFailure::NonZero {
            exit_code,
            stderr_tail,
            ..
        } => wrap(format!(
            "exit code {exit_code:?}: {}",
            stderr_text(&stderr_tail)
        )),
    }
}

/// `text` trimmed and cut to at most `limit` characters.
fn bounded_text(text: &str, limit: usize) -> String {
    text.trim().chars().take(limit).collect()
}

fn stderr_text(tail: &[u8]) -> String {
    String::from_utf8_lossy(tail).trim().to_owned()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary_json(frames: u32, hashes: usize, backend: &str) -> Vec<u8> {
        summary_json_with_reason(frames, hashes, backend, None)
    }

    fn summary_json_with_reason(
        frames: u32,
        hashes: usize,
        backend: &str,
        gpu_fallback_reason: Option<&str>,
    ) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "backend": backend,
            "gpuFallbackReason": gpu_fallback_reason,
            "width": 4,
            "height": 4,
            "frameRate": { "numerator": 30, "denominator": 1 },
            "frames": frames,
            "descriptionSha256": "a".repeat(64),
            "elapsedMs": 1,
            "frameSha256": vec!["b".repeat(64); hashes],
        }))
        .unwrap()
    }

    #[test]
    fn accepts_a_consistent_summary() {
        let summary = parse_summary(&summary_json(2, 2, "cpu")).unwrap();

        assert_eq!(summary.frames, 2);
        assert_eq!(summary.backend, "cpu");
        assert_eq!(summary.gpu_fallback_reason, None);
    }

    #[test]
    fn keeps_a_bounded_gpu_fallback_reason() {
        let cases = [
            (
                "short",
                " Unable to find a Vulkan driver ".to_owned(),
                "Unable to find a Vulkan driver".to_owned(),
            ),
            (
                "overlong",
                "é".repeat(GPU_FALLBACK_REASON_LIMIT + 100),
                "é".repeat(GPU_FALLBACK_REASON_LIMIT),
            ),
        ];
        for (name, reason, expected) in cases {
            let summary =
                parse_summary(&summary_json_with_reason(1, 1, "cpu", Some(&reason))).unwrap();

            assert_eq!(summary.gpu_fallback_reason, Some(expected), "{name}");
        }
    }

    #[test]
    fn rejects_inconsistent_summaries() {
        let cases = [
            ("hash count", summary_json(3, 2, "cpu")),
            ("zero frames", summary_json(0, 0, "cpu")),
            ("backend", summary_json(1, 1, "metal")),
            ("json", b"{".to_vec()),
        ];
        for (name, line) in cases {
            assert!(
                matches!(
                    parse_summary(&line),
                    Err(GraphicsRenderError::RendererFailed(_))
                ),
                "{name}"
            );
        }
    }
}
