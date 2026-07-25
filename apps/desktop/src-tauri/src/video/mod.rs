mod error;
mod grants;
mod project_io;
mod types;

pub use error::{VideoCommandError, VideoErrorCode};
pub use grants::{GrantCategory, VideoPathGrants};
pub use project_io::{
    video_open_project, video_pick_export_path, video_pick_new_project_path, video_pick_source,
    video_save_project, OpenedVideoProject, VideoSourceRecord, VideoSourceStatus,
    MAX_PROJECT_BYTES,
};
pub use types::{VideoProjectFileV1, MAX_SAFE_INTEGER};

#[cfg(test)]
mod tests;
