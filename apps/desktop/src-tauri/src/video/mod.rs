#[allow(dead_code)]
pub(crate) mod derived;
mod error;
mod grants;
pub(crate) mod probe;
mod process;
pub(crate) mod project_io;
pub(crate) mod render;
mod types;

pub use derived::video_prepare_asset;
pub use error::{VideoCommandError, VideoErrorCode};
pub use grants::{GrantCategory, VideoPathGrants};
pub use probe::{video_ffmpeg_status, video_probe_media};
pub use project_io::{
    video_open_project, video_pick_export_path, video_pick_new_project_path, video_pick_source,
    video_save_project, OpenedVideoProject, VideoSourceRecord, VideoSourceStatus,
    MAX_PROJECT_BYTES,
};
pub use render::{video_cancel_render, video_start_render, VideoRenderJobs, VIDEO_RENDER_EVENT};
pub use types::{
    MediaProbe, PreparedVideoAsset, RenderExpectation, RenderPlanV1, VerifiedRenderOutput,
    VideoProjectFileV1, VideoRenderEvent, VideoRenderStarted, VideoToolInfo, VideoToolProblem,
    VideoToolStatus, MAX_SAFE_INTEGER,
};

#[cfg(test)]
mod tests;
