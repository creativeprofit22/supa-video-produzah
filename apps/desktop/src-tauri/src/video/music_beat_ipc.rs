//! Tauri commands for music beat detection. Thin wrappers: every rule lives in
//! `music_beat_runtime` and `music_beat_job` so it is testable without a
//! webview.

use std::path::PathBuf;

use serde::Deserialize;
use tauri::{Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::{
    derived::MediaPrograms,
    error::VideoCommandError,
    grants::VideoPathGrants,
    jobs::MediaJobService,
    music_beat_job::{
        load_music_beat_analysis, music_beat_detection_result, start_music_beat_detection,
        MusicBeatDetectionResult, MusicBeatDetectionStarted, MusicBeatDetectorChoice,
        MusicBeatStartContext, StartMusicBeatDetectionRequest,
    },
    music_beat_runtime::{
        music_beat_runtime_status, set_music_beat_runtime_folder, MusicBeatRuntimeStatus,
    },
    music_beats::MusicBeatAnalysisV1,
    project_io::dialog_path,
    toolchain::MediaToolchainState,
};

fn config_dir<R: Runtime>(
    window: &WebviewWindow<R>,
    operation: &'static str,
) -> Result<std::path::PathBuf, VideoCommandError> {
    window
        .app_handle()
        .path()
        .app_config_dir()
        .map_err(|_| VideoCommandError::project_io(operation, "app_config"))
}

/// The bundled `supa-beat-detect` sidecar, when this build ships it.
fn beat_detector(toolchain: &State<'_, MediaToolchainState>) -> Option<PathBuf> {
    MediaPrograms::bundled(toolchain.inner().clone()).beat_detector()
}

#[tauri::command]
pub(crate) async fn video_music_beat_runtime_status<R: Runtime>(
    window: WebviewWindow<R>,
    toolchain: State<'_, MediaToolchainState>,
) -> Result<MusicBeatRuntimeStatus, VideoCommandError> {
    let config_dir = config_dir(&window, "music_beat_runtime_status")?;
    let sidecar = beat_detector(&toolchain);
    Ok(music_beat_runtime_status(&config_dir, sidecar.as_deref())
        .await
        .0)
}

/// Opens a native folder picker; the webview never supplies the path.
/// Returns `None` when the user cancels. A running job keeps the runtime it
/// verified at start and re-hashes the models before use, so changing the
/// folder mid-job is safe.
#[tauri::command]
pub(crate) async fn video_music_beat_set_runtime<R: Runtime>(
    window: WebviewWindow<R>,
    toolchain: State<'_, MediaToolchainState>,
) -> Result<Option<MusicBeatRuntimeStatus>, VideoCommandError> {
    let config_dir = config_dir(&window, "set_music_beat_runtime")?;
    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose the music beat runtime folder")
        .blocking_pick_folder();
    let Some(folder) = dialog_path(selection, "set_music_beat_runtime", "folder")? else {
        return Ok(None);
    };
    let folder = folder
        .to_str()
        .ok_or_else(|| VideoCommandError::invalid_path("set_music_beat_runtime", "folder"))?
        .to_owned();
    let sidecar = beat_detector(&toolchain);
    set_music_beat_runtime_folder(&config_dir, sidecar.as_deref(), &folder)
        .await
        .map(Some)
}

/// Starts detection with Beat This! when the runtime is ready, otherwise with
/// the in-app tempo fallback.
#[tauri::command]
pub(crate) async fn video_start_music_beat_detection<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    jobs: State<'_, MediaJobService>,
    toolchain: State<'_, MediaToolchainState>,
    request: StartMusicBeatDetectionRequest,
) -> Result<MusicBeatDetectionStarted, VideoCommandError> {
    const OPERATION: &str = "start_music_beat_detection";
    let sidecar = beat_detector(&toolchain);
    let (_, verified) =
        music_beat_runtime_status(&config_dir(&window, OPERATION)?, sidecar.as_deref()).await;
    let choice = verified.map_or(
        MusicBeatDetectorChoice::TempoFallback,
        MusicBeatDetectorChoice::BeatThis,
    );
    let app_cache_root = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| VideoCommandError::project_io(OPERATION, "app_cache"))?;
    toolchain
        .verified_programs()
        .await
        .map_err(|error| error.into_command_error(OPERATION))?;
    start_music_beat_detection(
        MusicBeatStartContext {
            owner_label: window.label(),
            grants: &grants,
            jobs: &jobs,
            programs: MediaPrograms::bundled(toolchain.inner().clone()),
            app_cache_root,
        },
        choice,
        request,
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MusicBeatDetectionResultRequest {
    job_id: String,
}

#[tauri::command]
pub(crate) async fn video_music_beat_detection_result<R: Runtime>(
    window: WebviewWindow<R>,
    jobs: State<'_, MediaJobService>,
    request: MusicBeatDetectionResultRequest,
) -> Result<MusicBeatDetectionResult, VideoCommandError> {
    music_beat_detection_result(&jobs, window.label(), &request.job_id).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoadMusicBeatAnalysisRequest {
    analysis_key: String,
}

#[tauri::command]
pub(crate) async fn video_load_music_beat_analysis(
    jobs: State<'_, MediaJobService>,
    request: LoadMusicBeatAnalysisRequest,
) -> Result<MusicBeatAnalysisV1, VideoCommandError> {
    let app_cache_root = jobs.cache().app_cache_root().to_path_buf();
    load_music_beat_analysis(&app_cache_root, &request.analysis_key).await
}
