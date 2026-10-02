//! Deliver: render one reviewed revision into each delivery preset.
//!
//! Gate (before any render starts, `prepare_delivery`):
//! - the source review export's manifest + review record must be `releasable`;
//! - the source revision must still be the open revision (same state hash);
//! - every preset plan must target that revision at the preset's frame size
//!   and pass the rights gate (rights failures are never overridable);
//! - every preset's editorial evaluation must have no blocker that was not
//!   accepted on the source review export.
//!
//! Each preset render then re-runs the full QC pass. Accepted finding ids
//! (which exclude frame size) carry over; any new unaccepted blocker fails that
//! preset with `qc_release_blocked` and nothing is promoted. A delivered output
//! gets its own manifest that references the source review manifest, plus a
//! thumbnail, `metadata.json` and SRT/VTT caption sidecars.

use std::{
    collections::BTreeSet,
    ffi::OsString,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager, Runtime, State, WebviewWindow};

use super::{
    derived::MediaPrograms,
    error::{VideoCommandError, VideoErrorCode},
    jobs::MediaJobService,
    process::{run_supervised, ProcessCancellation, ProcessSpec},
    qc::{
        hex_sha256, qc_release_blocked, unresolved_blockers, validate_editorial_evaluation,
        DeliveryGate, RenderQcContext,
    },
    render::{
        parse_and_validate_render_plan_with_rights, start_validated_render_with_context,
        RenderEventSink, ValidatedRenderPlan,
    },
    render_manifest::{RenderManifest, WrittenManifest},
    review_record::{invalid_review_record, read_review_state, ReleaseDecision},
    toolchain::MediaToolchainState,
    types::{RenderCaptionInput, VideoRenderStarted},
    GrantCategory, VideoPathGrants, VIDEO_RENDER_EVENT,
};
use crate::rights::gate::RenderRights;

pub(crate) struct DeliveryPresetSpec {
    pub(crate) id: &'static str,
    pub(crate) width: u64,
    pub(crate) height: u64,
    pub(crate) thumbnail_at_permille: u64,
    /// Inset kept clear of text, per side, as permille of the frame side it borders.
    pub(crate) safe_area: SafeAreaPermille,
}

/// Safe-area insets in permille: `top`/`bottom` of the frame height, `left`/`right` of the width.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SafeAreaPermille {
    pub(crate) top: u32,
    pub(crate) right: u32,
    pub(crate) bottom: u32,
    pub(crate) left: u32,
}

impl SafeAreaPermille {
    pub(crate) const fn uniform(inset: u32) -> Self {
        Self {
            top: inset,
            right: inset,
            bottom: inset,
            left: inset,
        }
    }
}

/// Safe area used when no preset matches the frame (title-safe 90 %).
pub(crate) const DEFAULT_SAFE_AREA: SafeAreaPermille = SafeAreaPermille::uniform(50);

/// A safe area resolved to pixels for one frame size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SafeAreaRect {
    pub(crate) left: f64,
    pub(crate) top: f64,
    pub(crate) right: f64,
    pub(crate) bottom: f64,
}

/// Mirrors `DELIVERY_PRESETS` in `@supa-video/contracts` `qc.ts`.
pub(crate) const DELIVERY_PRESETS: [DeliveryPresetSpec; 3] = [
    DeliveryPresetSpec {
        id: "landscape_16x9_1080p",
        width: 1920,
        height: 1080,
        thumbnail_at_permille: 100,
        safe_area: SafeAreaPermille::uniform(50),
    },
    DeliveryPresetSpec {
        id: "portrait_9x16_1080p",
        width: 1080,
        height: 1920,
        thumbnail_at_permille: 100,
        // Clear of the social apps' top bar, side action buttons and bottom caption UI.
        safe_area: SafeAreaPermille {
            top: 120,
            right: 120,
            bottom: 200,
            left: 60,
        },
    },
    DeliveryPresetSpec {
        id: "square_1x1_1080p",
        width: 1080,
        height: 1080,
        thumbnail_at_permille: 100,
        safe_area: SafeAreaPermille::uniform(50),
    },
];

/// The safe area for a frame: the named delivery preset's, else the preset with exactly the
/// frame's aspect ratio, else [`DEFAULT_SAFE_AREA`].
pub(crate) fn safe_area_for_frame(
    width: u64,
    height: u64,
    preset_id: Option<&str>,
) -> SafeAreaRect {
    let permille = preset_id
        .and_then(|id| DELIVERY_PRESETS.iter().find(|preset| preset.id == id))
        .or_else(|| {
            DELIVERY_PRESETS.iter().find(|preset| {
                u128::from(preset.width) * u128::from(height)
                    == u128::from(preset.height) * u128::from(width)
            })
        })
        .map_or(DEFAULT_SAFE_AREA, |preset| preset.safe_area);
    let (w, h) = (width as f64, height as f64);
    SafeAreaRect {
        left: w * f64::from(permille.left) / 1000.0,
        top: h * f64::from(permille.top) / 1000.0,
        right: w - w * f64::from(permille.right) / 1000.0,
        bottom: h - h * f64::from(permille.bottom) / 1000.0,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryPresetRequest {
    pub preset_id: String,
    pub plan: Value,
    #[serde(default)]
    pub editorial: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryRequest {
    pub source_output_path: String,
    pub presets: Vec<DeliveryPresetRequest>,
}

pub(crate) fn invalid_delivery(reason: &'static str) -> VideoCommandError {
    VideoCommandError::invalid_render_plan(reason)
}

fn delivery_sidecar(stage: &'static str) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::ProjectIo,
        "A delivery file could not be written",
        json!({ "operation": "delivery", "category": "delivery_sidecar", "stage": stage }),
    )
}

/// Validates everything Deliver can know before encoding and returns one
/// validated plan per preset with its QC context. Nothing is queued on error.
pub(crate) fn prepare_delivery(
    owner_label: &str,
    grants: &VideoPathGrants,
    rights: &RenderRights<'_>,
    request: DeliveryRequest,
    revision_state_hash: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<ValidatedRenderPlan>, VideoCommandError> {
    if request.presets.is_empty() || request.presets.len() > DELIVERY_PRESETS.len() {
        return Err(invalid_delivery("delivery_presets"));
    }
    let source = grants.authorize(
        owner_label,
        GrantCategory::Output,
        Path::new(&request.source_output_path),
    )?;
    let state = read_review_state(&source)?;
    if state.manifest.kind != "review" {
        return Err(invalid_review_record("not_a_review_export"));
    }
    if let ReleaseDecision::Blocked {
        unresolved_finding_ids,
    } = &state.release
    {
        return Err(qc_release_blocked(unresolved_finding_ids));
    }
    // Identity is the project *content* (state hash): an edit that is undone
    // back to the reviewed state gets a new revision id but the same hash.
    let state_hash = state.manifest.project.revision_state_hash.clone();
    let mut plan_revision: Option<String> = None;
    let accepted = state.accepted();
    let accepted_ids: BTreeSet<String> = accepted.keys().cloned().collect();
    let mut seen_presets = BTreeSet::new();
    let mut seen_outputs = BTreeSet::from([source.clone()]);
    let mut unresolved = Vec::new();
    let mut prepared = Vec::new();
    for preset_request in request.presets {
        let preset = DELIVERY_PRESETS
            .iter()
            .find(|preset| preset.id == preset_request.preset_id)
            .ok_or_else(|| invalid_delivery("delivery_preset"))?;
        if !seen_presets.insert(preset.id) {
            return Err(invalid_delivery("delivery_preset_duplicate"));
        }
        // Rights gate runs here for every preset; never overridable.
        let mut validated = parse_and_validate_render_plan_with_rights(
            preset_request.plan,
            owner_label,
            grants,
            rights,
        )?;
        let revision_id = validated.plan.revision_id().as_str().to_owned();
        if plan_revision.get_or_insert_with(|| revision_id.clone()) != &revision_id
            || revision_state_hash(&revision_id).as_deref() != Some(state_hash.as_str())
        {
            return Err(invalid_review_record("revision_changed"));
        }
        let expected = validated.plan.expected();
        if expected.width != preset.width || expected.height != preset.height {
            return Err(invalid_delivery("delivery_frame_size"));
        }
        if !seen_outputs.insert(validated.output_path.clone()) {
            return Err(invalid_delivery("delivery_output_duplicate"));
        }
        let editorial = validate_editorial_evaluation(
            preset_request.editorial,
            &revision_id,
            Some(&state_hash),
        )?;
        unresolved.extend(unresolved_blockers(&editorial.findings, &accepted_ids));
        validated.qc = Some(RenderQcContext {
            revision_state_hash: state_hash.clone(),
            editorial,
            delivery: Some(DeliveryGate {
                preset_id: preset.id.to_owned(),
                width: preset.width,
                height: preset.height,
                thumbnail_at_permille: preset.thumbnail_at_permille,
                source_manifest_sha256: state.manifest_sha256.clone(),
                accepted: accepted.clone(),
            }),
        });
        prepared.push(validated);
    }
    if !unresolved.is_empty() {
        unresolved.sort();
        unresolved.dedup();
        return Err(qc_release_blocked(&unresolved));
    }
    Ok(prepared)
}

/// Start one render job per delivery preset after the gate passes.
#[tauri::command]
pub async fn video_start_delivery<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    jobs: State<'_, MediaJobService>,
    toolchain: State<'_, MediaToolchainState>,
    projects: State<'_, super::VideoProjectService>,
    request: DeliveryRequest,
) -> Result<Vec<VideoRenderStarted>, VideoCommandError> {
    let app_cache_dir = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| VideoCommandError::project_io("start_delivery", "app_cache"))?;
    toolchain
        .verified_programs()
        .await
        .map_err(|error| error.into_command_error("start_delivery"))?;
    let rights_service = window
        .app_handle()
        .try_state::<crate::rights::service::RightsService>()
        .ok_or_else(|| VideoCommandError::invalid_render_plan("rights_unavailable"))?;
    let rights = rights_service.render_rights();
    let owner = window.label().to_owned();
    let lookup = |revision_id: &str| projects.open_revision_state_hash(&owner, revision_id);
    let prepared = prepare_delivery(&owner, &grants, &rights, request, &lookup)?;
    let mut started = Vec::new();
    for validated in prepared {
        let event_window = window.clone();
        let events: RenderEventSink = Arc::new(move |event| {
            event_window
                .emit(VIDEO_RENDER_EVENT, event)
                .map_err(|_| VideoCommandError::project_io("emit_render_event", "owner_window"))
        });
        started.push(
            start_validated_render_with_context(
                &owner,
                &jobs,
                MediaPrograms::bundled(toolchain.inner().clone()),
                app_cache_dir.clone(),
                validated,
                false,
                events,
            )
            .await?,
        );
    }
    Ok(started)
}

fn sidecar_path(output_path: &Path, suffix: &str) -> Option<PathBuf> {
    let parent = output_path.parent()?;
    let name = output_path.file_name()?.to_str()?;
    Some(parent.join(format!("{name}{suffix}")))
}

/// Caption sidecars use the player convention `<stem>.srt` / `<stem>.vtt`.
fn caption_path(output_path: &Path, extension: &str) -> Option<PathBuf> {
    let parent = output_path.parent()?;
    let stem = output_path.file_stem()?.to_str()?;
    Some(parent.join(format!("{stem}.{extension}")))
}

fn write_sidecar(
    target: &Path,
    bytes: &[u8],
    overwrite: bool,
) -> Result<WrittenManifest, VideoCommandError> {
    let parent = target.parent().ok_or_else(|| delivery_sidecar("path"))?;
    if let Ok(metadata) = std::fs::symlink_metadata(target) {
        if !metadata.file_type().is_file() || !overwrite {
            return Err(delivery_sidecar("exists"));
        }
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".svp-delivery-")
        .suffix(".part")
        .tempfile_in(parent)
        .map_err(|_| delivery_sidecar("create"))?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| delivery_sidecar("write"))?;
    let persisted = if overwrite {
        temporary.persist(target).map(|_| ())
    } else {
        temporary.persist_noclobber(target).map(|_| ())
    };
    persisted.map_err(|_| delivery_sidecar("persist"))?;
    Ok(WrittenManifest::guard(
        target.to_path_buf(),
        hex_sha256(bytes),
    ))
}

fn timestamp(us: u64, separator: char) -> String {
    let ms = us / 1_000;
    format!(
        "{:02}:{:02}:{:02}{separator}{:03}",
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1_000) % 60,
        ms % 1_000
    )
}

/// Cue text without blank lines or cue-timing arrows (both end a cue early).
fn cue_text(text: &str) -> String {
    text.replace("-->", "\u{2192}")
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn captions_srt(captions: &[RenderCaptionInput]) -> String {
    let mut sorted: Vec<&RenderCaptionInput> = captions.iter().collect();
    sorted.sort_by_key(|caption| (caption.start_microseconds, caption.end_microseconds));
    let mut out = String::new();
    for (index, caption) in sorted
        .iter()
        .filter(|c| !cue_text(&c.text).is_empty())
        .enumerate()
    {
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            timestamp(caption.start_microseconds, ','),
            timestamp(caption.end_microseconds, ','),
            cue_text(&caption.text)
        ));
    }
    out
}

pub(crate) fn captions_vtt(captions: &[RenderCaptionInput]) -> String {
    let mut sorted: Vec<&RenderCaptionInput> = captions.iter().collect();
    sorted.sort_by_key(|caption| (caption.start_microseconds, caption.end_microseconds));
    let mut out = String::from("WEBVTT\n\n");
    for caption in sorted.iter().filter(|c| !cue_text(&c.text).is_empty()) {
        out.push_str(&format!(
            "{} --> {}\n{}\n\n",
            timestamp(caption.start_microseconds, '.'),
            timestamp(caption.end_microseconds, '.'),
            cue_text(&caption.text)
        ));
    }
    out
}

async fn extract_thumbnail(
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
    partial_path: &Path,
    output_path: &Path,
    at_us: u64,
) -> Result<tempfile::TempPath, VideoCommandError> {
    let parent = output_path
        .parent()
        .ok_or_else(|| delivery_sidecar("path"))?;
    let temporary = tempfile::Builder::new()
        .prefix(".svp-thumbnail-")
        .suffix(".jpg")
        .tempfile_in(parent)
        .map_err(|_| delivery_sidecar("create"))?
        .into_temp_path();
    let program = programs.verified_ffmpeg("delivery_thumbnail").await?;
    let seconds = format!("{}.{:06}", at_us / 1_000_000, at_us % 1_000_000);
    let args: Vec<OsString> = [
        OsString::from("-hide_banner"),
        "-nostdin".into(),
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        seconds.into(),
        "-i".into(),
        partial_path.as_os_str().to_owned(),
        "-frames:v".into(),
        "1".into(),
        "-an".into(),
        "-c:v".into(),
        "mjpeg".into(),
        "-q:v".into(),
        "3".into(),
        "-f".into(),
        "image2".into(),
        temporary.as_os_str().to_owned(),
    ]
    .into_iter()
    .collect();
    run_supervised(
        ProcessSpec {
            program,
            args,
            current_dir: None,
            operation: "delivery_thumbnail",
            timeout: std::time::Duration::from_secs(120),
            stdout_limit: 64 * 1024,
            stderr_tail_limit: 64 * 1024,
        },
        cancellation,
    )
    .await
    .map_err(|failure| match failure {
        super::process::ProcessFailure::Cancelled { .. } => {
            VideoCommandError::process_cancelled("delivery_thumbnail", "ffmpeg")
        }
        _ => delivery_sidecar("thumbnail"),
    })?;
    let size = std::fs::metadata(&temporary)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    if size == 0 {
        return Err(delivery_sidecar("thumbnail"));
    }
    Ok(temporary)
}

/// Thumbnail, caption sidecars and `metadata.json` for one delivered output,
/// written before the output is promoted. Guards remove them again unless kept.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn write_delivery_sidecars(
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
    partial_path: &Path,
    output_path: &Path,
    gate: &DeliveryGate,
    manifest: &RenderManifest,
    manifest_sha256: &str,
    captions: &[RenderCaptionInput],
    overwrite: bool,
) -> Result<Vec<WrittenManifest>, VideoCommandError> {
    let mut written = Vec::new();
    let duration = manifest.output.duration_microseconds;
    let frame_us = 100_000;
    let at_us = (duration.saturating_mul(gate.thumbnail_at_permille) / 1000)
        .min(duration.saturating_sub(frame_us));
    let thumbnail =
        extract_thumbnail(programs, cancellation, partial_path, output_path, at_us).await?;
    let thumbnail_target =
        sidecar_path(output_path, ".thumbnail.jpg").ok_or_else(|| delivery_sidecar("path"))?;
    let thumbnail_bytes = std::fs::read(&thumbnail).map_err(|_| delivery_sidecar("thumbnail"))?;
    written.push(write_sidecar(
        &thumbnail_target,
        &thumbnail_bytes,
        overwrite,
    )?);
    drop(thumbnail);
    let mut caption_files = Vec::new();
    if !captions.is_empty() {
        for (extension, contents) in [
            ("srt", captions_srt(captions)),
            ("vtt", captions_vtt(captions)),
        ] {
            let target =
                caption_path(output_path, extension).ok_or_else(|| delivery_sidecar("path"))?;
            written.push(write_sidecar(&target, contents.as_bytes(), overwrite)?);
            caption_files.push(
                target
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned(),
            );
        }
    }
    let metadata = json!({
        "schemaVersion": 1,
        "presetId": gate.preset_id,
        "fileName": manifest.output.file_name,
        "width": manifest.output.width,
        "height": manifest.output.height,
        "durationMicroseconds": duration,
        "outputSha256": manifest.output.sha256,
        "manifestSha256": manifest_sha256,
        "revisionId": manifest.project.revision_id,
        "thumbnailFileName": thumbnail_target.file_name().and_then(|name| name.to_str()),
        "thumbnailAtMicroseconds": at_us,
        "captionFileNames": caption_files,
        "createdAt": manifest.created_at,
    });
    let bytes =
        serde_json_canonicalizer::to_vec(&metadata).map_err(|_| delivery_sidecar("serialize"))?;
    let metadata_target =
        sidecar_path(output_path, ".metadata.json").ok_or_else(|| delivery_sidecar("path"))?;
    written.push(write_sidecar(&metadata_target, &bytes, overwrite)?);
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caption(text: &str, start: u64, end: u64) -> RenderCaptionInput {
        serde_json::from_value(json!({
            "trackId": "66666666-6666-4666-8666-666666666601",
            "captionId": "66666666-6666-4666-8666-666666666602",
            "startMicroseconds": start,
            "endMicroseconds": end,
            "text": text,
        }))
        .unwrap()
    }

    #[test]
    fn caption_sidecars_are_ordered_and_cannot_break_cues() {
        let captions = [
            caption("Second", 2_000_000, 3_500_000),
            caption("First\n\nline --> two", 0, 1_250_000),
            caption("   ", 4_000_000, 5_000_000),
        ];
        assert_eq!(
            captions_srt(&captions),
            "1\n00:00:00,000 --> 00:00:01,250\nFirst\nline \u{2192} two\n\n2\n00:00:02,000 --> 00:00:03,500\nSecond\n\n"
        );
        assert_eq!(
            captions_vtt(&captions),
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.250\nFirst\nline \u{2192} two\n\n00:00:02.000 --> 00:00:03.500\nSecond\n\n"
        );
    }

    #[test]
    fn presets_match_the_contract() {
        let ids: Vec<_> = DELIVERY_PRESETS.iter().map(|preset| preset.id).collect();
        assert_eq!(
            ids,
            [
                "landscape_16x9_1080p",
                "portrait_9x16_1080p",
                "square_1x1_1080p"
            ]
        );
    }

    /// Every Rust preset's safe area appears, field for field, in the TS mirror.
    #[test]
    fn safe_areas_match_the_typescript_presets() {
        let ts = include_str!("../../../../../packages/video-contracts/src/qc.ts");
        let compact: String = ts.chars().filter(|c| !c.is_whitespace()).collect();
        for preset in &DELIVERY_PRESETS {
            let area = preset.safe_area;
            let expected = format!(
                "width:{},height:{},safeArea:{{top:{},right:{},bottom:{},left:{}}}",
                preset.width, preset.height, area.top, area.right, area.bottom, area.left
            );
            assert!(
                compact.contains(&expected),
                "{} missing {expected}",
                preset.id
            );
        }
    }

    #[test]
    fn safe_area_resolves_per_preset() {
        let check = |actual: SafeAreaRect, expected: [f64; 4]| {
            let got = [actual.left, actual.top, actual.right, actual.bottom];
            for (got, want) in got.iter().zip(expected) {
                assert!((got - want).abs() < 1e-9, "{got} != {want}");
            }
        };
        check(
            safe_area_for_frame(1920, 1080, Some("landscape_16x9_1080p")),
            [96.0, 54.0, 1824.0, 1026.0],
        );
        check(
            safe_area_for_frame(1080, 1920, Some("portrait_9x16_1080p")),
            [64.8, 230.4, 950.4, 1536.0],
        );
        check(
            safe_area_for_frame(1080, 1080, Some("square_1x1_1080p")),
            [54.0, 54.0, 1026.0, 1026.0],
        );
    }

    #[test]
    fn safe_area_falls_back_to_aspect_ratio_then_default() {
        // A 720p review export of a vertical project uses the 9:16 insets.
        assert_eq!(
            safe_area_for_frame(720, 1280, None),
            safe_area_for_frame(720, 1280, Some("portrait_9x16_1080p"))
        );
        assert_eq!(
            safe_area_for_frame(1000, 800, None),
            SafeAreaRect {
                left: 50.0,
                top: 40.0,
                right: 950.0,
                bottom: 760.0
            }
        );
        // An unknown preset id falls through to the aspect-ratio match.
        assert_eq!(
            safe_area_for_frame(1280, 720, Some("custom")),
            safe_area_for_frame(1280, 720, None)
        );
    }
}
