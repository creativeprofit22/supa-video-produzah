//! Graphics clips in exports (docs/adr/0003-graphics-clips.md).
//!
//! The render plan names each graphics overlay by a sentinel input (`graphics:<index>`). Before
//! FFmpeg runs, this module builds every renderer description from the *validated* plan (never
//! from renderer-facing JSON supplied by the webview), renders each overlay into the job's
//! private scratch directory under the job's cancellation, and returns the overlay paths that
//! replace the sentinels. The scratch directory is removed when the returned guard drops, on every
//! exit path.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Instant,
};

use serde_json::{json, Value};
use tempfile::TempDir;

use super::{
    delivery::SafeAreaRect,
    error::VideoCommandError,
    graphics_render::{
        render_graphics_overlay, GraphicsBackend, GraphicsRenderError, GraphicsRenderLog,
        GraphicsRenderRequest,
    },
    process::ProcessCancellation,
    project::graphics::{GraphicsEasing, GraphicsKeyframe, GraphicsLayer, GraphicsTextSplit},
    still_image::{parse_still_header, MAX_STILL_BYTES},
    text_boxes::fit_graphics_text,
    text_layout::{load_text_font, TextMeasurer},
    types::{graphics_input_sentinel, RationalRate, RenderGraphicsInputV2},
};

/// Windows core-font directory shared with burned-in captions.
pub(crate) const FONT_DIRECTORY: &str = r"C:\Windows\Fonts";

/// Where text must stay and which fonts measure it, for one export.
#[derive(Debug, Clone, Copy)]
pub(crate) struct TextFitContext<'a> {
    pub(crate) safe_area: SafeAreaRect,
    pub(crate) font_dir: &'a Path,
}

/// Rendered overlays for one export; dropping it deletes the scratch directory and every overlay.
pub(crate) struct RenderedGraphics {
    _scratch: Option<TempDir>,
    pub(crate) overlays: Vec<PathBuf>,
}

impl RenderedGraphics {
    pub(crate) fn none() -> Self {
        Self {
            _scratch: None,
            overlays: Vec::new(),
        }
    }
}

/// Microseconds → description frames at `rate` (fractional frames keep sub-frame timing).
fn frames(microseconds: u64, rate: &RationalRate) -> f64 {
    microseconds as f64 * rate.numerator as f64 / (rate.denominator as f64 * 1_000_000.0)
}

fn easing_json(easing: &GraphicsEasing) -> Value {
    // The project and renderer share one easing wire format; re-serializing the validated value
    // keeps renderer input free of anything the project schema did not accept.
    serde_json::to_value(easing).unwrap_or_else(|_| json!({ "kind": "linear" }))
}

fn track_json(keys: &[GraphicsKeyframe], rate: &RationalRate) -> Value {
    Value::Array(
        keys.iter()
            .map(|key| {
                let mut entry = json!({
                    "frame": frames(key.time_microseconds, rate),
                    "value": key.value.get(),
                });
                if let Some(easing) = &key.easing {
                    entry["easing"] = easing_json(easing);
                }
                entry
            })
            .collect(),
    )
}

fn tracks_json(layer: &GraphicsLayer, rate: &RationalRate, entry: &mut Value) {
    let tracks = layer.tracks();
    entry["x"] = track_json(tracks.x, rate);
    entry["y"] = track_json(tracks.y, rate);
    entry["scale"] = track_json(tracks.scale, rate);
    entry["rotation"] = track_json(tracks.rotation, rate);
    entry["opacity"] = track_json(tracks.opacity, rate);
}

fn invalid(category: &'static str) -> VideoCommandError {
    VideoCommandError::invalid_render_plan(category)
}

/// Reads a still image at a grant-checked path with the same bounds as import.
fn read_still(path: &Path) -> Result<(String, Vec<u8>), VideoCommandError> {
    let metadata = std::fs::metadata(path).map_err(|_| invalid("graphics_image"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_STILL_BYTES {
        return Err(invalid("graphics_image"));
    }
    let bytes = std::fs::read(path).map_err(|_| invalid("graphics_image"))?;
    let header = parse_still_header(&bytes).ok_or_else(|| invalid("graphics_image"))?;
    let mime = match header.format {
        super::still_image::StillFormat::Png => "image/png",
        super::still_image::StillFormat::Jpeg => "image/jpeg",
    };
    Ok((mime.to_owned(), bytes))
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(BASE64_ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(BASE64_ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The renderer description (schema 2) for one validated graphics input.
///
/// `image_paths` maps asset ids to grant-checked paths. The description covers the clip's own
/// duration; times are clip-relative, as stored.
///
/// Unrotated text layers are auto-fitted into `fit.safe_area` at their resting pose (shrink, then
/// wrap) with the clip's real font: the fitted `fontSize` replaces the authored one, and wrapped
/// text carries `lineBreaks` (byte offsets of each new line). Text that already fits is emitted
/// exactly as authored.
pub(crate) fn graphics_description(
    input: &RenderGraphicsInputV2,
    rate: &RationalRate,
    canvas: (u64, u64),
    image_paths: &BTreeMap<String, PathBuf>,
    fit: TextFitContext<'_>,
) -> Result<Value, VideoCommandError> {
    let clip = &input.clip;
    let font_file = super::caption_render::caption_font_file(&clip.font_key)
        .ok_or_else(|| invalid("graphics_font"))?;
    let family = graphics_font_family(&clip.font_key).ok_or_else(|| invalid("graphics_font"))?;
    let duration_frames =
        u32::try_from(clip.duration.value).map_err(|_| invalid("graphics_duration"))?;
    // Loaded only when the clip has text, so text-free clips never touch the font directory.
    let mut measurer: Option<TextMeasurer> = None;
    let mut image_indexes: BTreeMap<&str, usize> = BTreeMap::new();
    let mut images = Vec::new();
    let mut layers = Vec::with_capacity(clip.layers.len());
    for layer in &clip.layers {
        let mut entry = match layer {
            GraphicsLayer::Rect {
                width,
                height,
                corner_radius,
                fill,
                ..
            } => json!({
                "kind": "rect",
                "width": width.get(),
                "height": height.get(),
                "cornerRadius": corner_radius.get(),
                "fill": fill,
            }),
            GraphicsLayer::Text {
                text,
                font_size,
                fill,
                units,
                ..
            } => {
                let measure = match &mut measurer {
                    Some(measure) => measure,
                    None => measurer.insert(TextMeasurer::new(
                        load_text_font(&clip.font_key, fit.font_dir)
                            .map_err(|_| invalid("graphics_font"))?,
                    )),
                };
                let fitted = fit_graphics_text(
                    measure,
                    text,
                    font_size.get(),
                    &layer.tracks(),
                    &fit.safe_area,
                );
                let mut entry = json!({
                    "kind": "text",
                    "text": text,
                    "fontSize": font_size.get(),
                    "fill": fill,
                });
                if let Some(fitted) = fitted {
                    let authored = font_size.get();
                    // Floored to 1/100 px so the drawn size never exceeds the fitted one.
                    let size = (f64::from(fitted.font_size) * 100.0).floor() / 100.0;
                    if size < authored {
                        entry["fontSize"] = json!(size);
                    }
                    if !fitted.line_breaks.is_empty() {
                        entry["lineBreaks"] = json!(fitted.line_breaks);
                    }
                }
                if let Some(units) = units {
                    entry["units"] = json!({
                        "split": match units.split {
                            GraphicsTextSplit::Word => "word",
                            GraphicsTextSplit::Letter => "letter",
                        },
                        "opacity": units.opacity.iter().map(|track| track_json(track, rate)).collect::<Vec<_>>(),
                        "offsetY": units.offset_y.iter().map(|track| track_json(track, rate)).collect::<Vec<_>>(),
                    });
                }
                entry
            }
            GraphicsLayer::Image {
                asset_id,
                width,
                height,
                ..
            } => {
                let index = match image_indexes.get(asset_id.as_str()) {
                    Some(index) => *index,
                    None => {
                        let path = image_paths
                            .get(asset_id)
                            .ok_or_else(|| invalid("graphics_image"))?;
                        let (mime, bytes) = read_still(path)?;
                        images.push(
                            json!({ "data": format!("data:{mime};base64,{}", base64(&bytes)) }),
                        );
                        image_indexes.insert(asset_id, images.len() - 1);
                        images.len() - 1
                    }
                };
                json!({
                    "kind": "image",
                    "image": index,
                    "width": width.get(),
                    "height": height.get(),
                })
            }
        };
        tracks_json(layer, rate, &mut entry);
        layers.push(entry);
    }
    Ok(json!({
        "schemaVersion": 2,
        "canvas": { "width": canvas.0, "height": canvas.1 },
        "frameRate": { "numerator": rate.numerator, "denominator": rate.denominator },
        "durationFrames": duration_frames,
        "font": { "file": fit.font_dir.join(font_file), "family": family },
        "images": images,
        "layers": layers,
    }))
}

/// Family name inside each caption font file; the single source of family names, covering
/// every key in the TS `RENDER_CAPTION_FONT_FILES` table.
pub(crate) fn graphics_font_family(key: &str) -> Option<&'static str> {
    super::caption_render::caption_font_file(key)?;
    [
        ("arial-", "Arial"),
        ("segoe-ui-", "Segoe UI"),
        ("verdana-", "Verdana"),
        ("georgia-", "Georgia"),
        ("consolas-", "Consolas"),
    ]
    .into_iter()
    .find_map(|(prefix, family)| key.starts_with(prefix).then_some(family))
}

/// Where the renderer and FFmpeg live for one export.
pub(crate) struct GraphicsPrograms<'a> {
    pub(crate) renderer: &'a Path,
    pub(crate) ffmpeg: &'a Path,
}

/// One structured record per overlay: inputs, outcome and elapsed time.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphicsExportLog {
    pub(crate) event: &'static str,
    pub(crate) index: usize,
    pub(crate) graphics_clip_id: String,
    pub(crate) layers: usize,
    pub(crate) images: usize,
    pub(crate) frames: u64,
    pub(crate) outcome: &'static str,
    pub(crate) renderer: Option<GraphicsRenderLog>,
    pub(crate) elapsed_ms: u64,
}

/// Renders every graphics input of a validated plan into a fresh scratch directory under
/// `scratch_parent`. `image_paths` holds the grant-checked image paths for all inputs.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn render_export_graphics(
    graphics: &[RenderGraphicsInputV2],
    rate: &RationalRate,
    canvas: (u64, u64),
    image_paths: &BTreeMap<String, PathBuf>,
    fit: TextFitContext<'_>,
    scratch_parent: &Path,
    programs: GraphicsPrograms<'_>,
    cancellation: &ProcessCancellation,
    log: &(dyn Fn(&GraphicsExportLog) + Sync),
) -> Result<RenderedGraphics, VideoCommandError> {
    if graphics.is_empty() {
        return Ok(RenderedGraphics::none());
    }
    let scratch = tempfile::Builder::new()
        .prefix(".svp-graphics-")
        .tempdir_in(scratch_parent)
        .map_err(|_| VideoCommandError::invalid_render_plan("graphics_scratch"))?;
    let mut overlays = Vec::with_capacity(graphics.len());
    for (index, input) in graphics.iter().enumerate() {
        let started = Instant::now();
        let record = |outcome: &'static str, renderer: Option<GraphicsRenderLog>, images: usize| {
            log(&GraphicsExportLog {
                event: "graphics_export_overlay",
                index,
                graphics_clip_id: input.clip.id.clone(),
                layers: input.clip.layers.len(),
                images,
                frames: input.clip.duration.value,
                outcome,
                renderer,
                elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            })
        };
        if cancellation.is_cancelled() {
            record("cancelled", None, 0);
            return Err(VideoCommandError::process_cancelled(
                "render_graphics",
                "graphics",
            ));
        }
        let description = match graphics_description(input, rate, canvas, image_paths, fit) {
            Ok(description) => description,
            Err(error) => {
                record("invalid_input", None, 0);
                return Err(error);
            }
        };
        let images = description["images"].as_array().map_or(0, Vec::len);
        let description_path = scratch.path().join(format!("graphics-{index}.json"));
        let output = scratch.path().join(format!("graphics-{index}.mov"));
        let bytes = serde_json::to_vec(&description)
            .map_err(|_| VideoCommandError::invalid_render_plan("graphics_description"))?;
        std::fs::write(&description_path, bytes)
            .map_err(|_| VideoCommandError::invalid_render_plan("graphics_scratch"))?;
        let renderer_log = std::sync::Mutex::new(None);
        // The renderer commits its own token when it persists the overlay; the job's token must
        // stay active for the final export publish, so each overlay gets a child token that the
        // job's cancellation is forwarded to.
        let overlay_cancellation = ProcessCancellation::new();
        let capture_log = |entry: &GraphicsRenderLog| {
            if let Ok(mut slot) = renderer_log.lock() {
                *slot = Some(entry.clone());
            }
        };
        let render = render_graphics_overlay(
            GraphicsRenderRequest {
                renderer: programs.renderer,
                ffmpeg: programs.ffmpeg,
                description: &description_path,
                output: &output,
                backend: GraphicsBackend::Auto,
            },
            overlay_cancellation.clone(),
            None,
            &capture_log,
        );
        let forward = async {
            cancellation.wait().await;
            overlay_cancellation.cancel();
            std::future::pending::<()>().await;
        };
        let result = tokio::select! {
            result = render => result,
            () = forward => unreachable!("forwarding never completes"),
        };
        let _ = std::fs::remove_file(&description_path);
        let renderer_log = renderer_log.into_inner().ok().flatten();
        match result {
            Ok(overlay) => {
                record("succeeded", renderer_log, images);
                overlays.push(overlay.output);
            }
            Err(GraphicsRenderError::Cancelled) => {
                record("cancelled", renderer_log, images);
                return Err(VideoCommandError::process_cancelled(
                    "render_graphics",
                    "graphics",
                ));
            }
            Err(error) => {
                record("failed", renderer_log, images);
                return Err(graphics_render_failure(&error));
            }
        }
    }
    Ok(RenderedGraphics {
        _scratch: Some(scratch),
        overlays,
    })
}

fn graphics_render_failure(error: &GraphicsRenderError) -> VideoCommandError {
    match error {
        GraphicsRenderError::Cancelled => {
            VideoCommandError::process_cancelled("render_graphics", "graphics")
        }
        // The description is built from validated project data, so a rejection is a plan bug.
        GraphicsRenderError::InvalidDescription(_) => {
            VideoCommandError::invalid_render_plan("graphics_description")
        }
        GraphicsRenderError::RendererFailed(_) => {
            VideoCommandError::process_failed("render_graphics", "supa-graphics-render", None)
        }
        GraphicsRenderError::EncodeFailed(_) => {
            VideoCommandError::process_failed("render_graphics", "ffmpeg", None)
        }
        GraphicsRenderError::Io(_) => VideoCommandError::invalid_render_plan("graphics_scratch"),
    }
}

/// Replaces each `graphics:<index>` sentinel that directly follows `-i` with its overlay path.
/// Every sentinel must be replaced exactly once and nothing else may change.
pub(crate) fn swap_graphics_sentinels(
    arguments: &mut [String],
    overlays: &[PathBuf],
) -> Result<(), VideoCommandError> {
    let mut replaced = vec![false; overlays.len()];
    for index in 1..arguments.len() {
        if arguments[index - 1] != "-i" {
            continue;
        }
        let Some(slot) =
            (0..overlays.len()).find(|slot| arguments[index] == graphics_input_sentinel(*slot))
        else {
            continue;
        };
        if replaced[slot] {
            return Err(invalid("graphics_sentinel"));
        }
        arguments[index] = overlays[slot]
            .to_str()
            .ok_or_else(|| invalid("graphics_sentinel"))?
            .to_owned();
        replaced[slot] = true;
    }
    if replaced.iter().all(|done| *done) {
        Ok(())
    } else {
        Err(invalid("graphics_sentinel"))
    }
}
