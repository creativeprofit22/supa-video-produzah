pub(crate) mod asr_ipc;
mod asr_runtime;
mod asr_settings;
pub(crate) mod audio_mix;
pub(crate) mod cache;
#[allow(dead_code)]
mod caption;
mod caption_render;
pub(crate) mod delivery;
#[allow(dead_code)]
pub(crate) mod derived;
pub(crate) mod error;
pub(crate) mod grants;
// Wired into exports in a later phase; exercised by tests until then.
#[allow(dead_code)]
pub(crate) mod graphics_export;
pub(crate) mod graphics_render;
pub(crate) mod jobs;
pub(crate) mod media_store;
pub(crate) mod music_beat_ipc;
pub(crate) mod music_beat_job;
pub(crate) mod music_beat_runtime;
pub(crate) mod music_beats;
mod nemo_transcription;
pub(crate) mod probe;
pub(crate) mod process;
pub mod project;
pub(crate) mod project_io;
pub(crate) mod qc;
pub(crate) mod render;
pub(crate) mod render_manifest;
pub(crate) mod render_qc;
pub(crate) mod review_record;
pub(crate) mod still_image;
pub(crate) mod subtitle_export;
pub(crate) mod text_boxes;
pub(crate) mod text_layout;
pub(crate) mod toolchain;
mod transcript;
pub(crate) mod transcription_job;
pub(crate) mod types;

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoadManagedTranscriptArtifactRequest {
    artifact_key: String,
}

#[tauri::command]
pub(crate) async fn video_load_managed_transcript_artifact(
    jobs: tauri::State<'_, jobs::MediaJobService>,
    request: LoadManagedTranscriptArtifactRequest,
) -> Result<transcript::TranscriptArtifactV1, VideoCommandError> {
    let app_cache_root = jobs.cache().app_cache_root().to_path_buf();
    transcript::load_managed_transcript_artifact_for_key(&app_cache_root, &request.artifact_key)
        .await
}

#[cfg(test)]
pub(crate) fn managed_cache_root_for_test(jobs: &jobs::MediaJobService) -> &std::path::Path {
    jobs.cache().app_cache_root()
}

pub use derived::video_prepare_asset;
pub use error::{VideoCommandError, VideoErrorCode};
pub use grants::{GrantCategory, VideoPathGrants};
pub use probe::{video_ffmpeg_status, video_probe_media};
pub use project::service::VideoProjectService;
pub use project_io::{
    video_open_project, video_pick_export_path, video_pick_new_project_path, video_pick_source,
    video_pick_still_image, video_probe_still_image, video_regrant_project_source,
    video_save_project, OpenedVideoProject, VideoSourceRecord, VideoSourceStatus,
    MAX_PROJECT_BYTES,
};
pub use render::{video_cancel_render, video_start_render, VIDEO_RENDER_EVENT};
pub use types::{
    MediaProbe, PreparedVideoAsset, RenderExpectation, RenderPlanV1, VerifiedRenderOutput,
    VideoProjectFileV1, VideoRenderEvent, VideoRenderStarted, VideoToolInfo, VideoToolProblem,
    VideoToolSource, VideoToolStatus, MAX_SAFE_INTEGER,
};

#[cfg(test)]
pub(crate) mod tests;
