//! Tauri commands for production transcription. Thin wrappers: every rule
//! lives in `transcription_job` so it is testable without a webview.

use serde::Deserialize;
use tauri::{Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::{
    derived::MediaPrograms,
    error::VideoCommandError,
    grants::VideoPathGrants,
    jobs::MediaJobService,
    project_io::dialog_path,
    toolchain::MediaToolchainState,
    transcription_job::{
        asr_runtime_status, require_ready_runtime, set_asr_consent, set_asr_runtime_folder,
        start_transcription, transcription_result, AsrRuntimeStatus, StartTranscriptionRequest,
        TranscriptionJobResult, TranscriptionStartContext, TranscriptionStarted,
    },
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AsrConsentRequest {
    accepted: bool,
    /// The manifest hash the user was shown; consent binds to it.
    manifest_sha256: String,
}

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

#[tauri::command]
pub(crate) async fn video_asr_runtime_status<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<AsrRuntimeStatus, VideoCommandError> {
    asr_runtime_status(&config_dir(&window, "asr_runtime_status")?).await
}

/// Opens a native folder picker; the webview never supplies the path.
/// Returns `None` when the user cancels.
#[tauri::command]
pub(crate) async fn video_asr_set_runtime<R: Runtime>(
    window: WebviewWindow<R>,
    jobs: State<'_, MediaJobService>,
) -> Result<Option<AsrRuntimeStatus>, VideoCommandError> {
    let config_dir = config_dir(&window, "set_asr_runtime")?;
    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose the speech-recognition runtime folder")
        .blocking_pick_folder();
    let Some(folder) = dialog_path(selection, "set_asr_runtime", "folder")? else {
        return Ok(None);
    };
    let folder = folder
        .to_str()
        .ok_or_else(|| VideoCommandError::invalid_path("set_asr_runtime", "folder"))?
        .to_owned();
    set_asr_runtime_folder(&config_dir, &jobs, &folder)
        .await
        .map(Some)
}

#[tauri::command]
pub(crate) async fn video_asr_accept_consent<R: Runtime>(
    window: WebviewWindow<R>,
    request: AsrConsentRequest,
) -> Result<AsrRuntimeStatus, VideoCommandError> {
    set_asr_consent(
        &config_dir(&window, "accept_asr_consent")?,
        request.accepted,
        &request.manifest_sha256,
    )
    .await
}

#[tauri::command]
pub(crate) async fn video_start_transcription<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    jobs: State<'_, MediaJobService>,
    toolchain: State<'_, MediaToolchainState>,
    request: StartTranscriptionRequest,
) -> Result<TranscriptionStarted, VideoCommandError> {
    // Consent and runtime integrity are checked before any source access.
    let ready = require_ready_runtime(&config_dir(&window, "start_transcription")?).await?;
    let app_cache_root = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| VideoCommandError::project_io("start_transcription", "app_cache"))?;
    toolchain
        .verified_programs()
        .await
        .map_err(|error| error.into_command_error("start_transcription"))?;
    start_transcription(
        TranscriptionStartContext {
            owner_label: window.label(),
            grants: &grants,
            jobs: &jobs,
            programs: MediaPrograms::bundled(toolchain.inner().clone()),
            app_cache_root,
        },
        ready,
        request,
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TranscriptionResultRequest {
    job_id: String,
}

#[tauri::command]
pub(crate) async fn video_transcription_result<R: Runtime>(
    window: WebviewWindow<R>,
    jobs: State<'_, MediaJobService>,
    request: TranscriptionResultRequest,
) -> Result<TranscriptionJobResult, VideoCommandError> {
    transcription_result(&jobs, window.label(), &request.job_id).await
}
