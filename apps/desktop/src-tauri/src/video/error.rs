use serde::Serialize;
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoErrorCode {
    InvalidProject,
    InvalidCommand,
    StaleRevision,
    DuplicateConflict,
    ProjectInUse,
    StorageLimit,
    UnsupportedSchema,
    Phase1Limit,
    InvalidPath,
    PathNotGranted,
    ProjectIo,
    ToolUnavailable,
    ProcessFailed,
    ProcessTimeout,
    ProcessCancelled,
    ProcessOutputLimit,
    InvalidMedia,
    InvalidRenderPlan,
    OutputExists,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCommandError {
    pub code: VideoErrorCode,
    pub message: String,
    pub details: Value,
}

impl VideoCommandError {
    pub(crate) fn new(code: VideoErrorCode, message: impl Into<String>, details: Value) -> Self {
        Self {
            code,
            message: message.into(),
            details,
        }
    }

    pub(crate) fn project_error(
        code: VideoErrorCode,
        message: impl Into<String>,
        operation: &'static str,
        category: &'static str,
    ) -> Self {
        Self::new(
            code,
            message,
            json!({ "operation": operation, "category": category }),
        )
    }

    pub(crate) fn invalid_project(issues: impl Serialize) -> Self {
        Self::new(
            VideoErrorCode::InvalidProject,
            "Project file failed strict V1 validation",
            json!({ "operation": "validate_project", "issues": issues }),
        )
    }

    pub(crate) fn unsupported_schema(schema_version: &Value) -> Self {
        Self::new(
            VideoErrorCode::UnsupportedSchema,
            "Project schema is not supported by this version",
            json!({ "operation": "parse_project", "schemaVersion": schema_version }),
        )
    }

    pub(crate) fn phase1_limit(operation: &'static str, category: &'static str) -> Self {
        Self::new(
            VideoErrorCode::Phase1Limit,
            "The operation exceeds a Phase 1 safety limit",
            json!({ "operation": operation, "category": category }),
        )
    }

    pub(crate) fn invalid_path(operation: &'static str, category: &'static str) -> Self {
        Self::new(
            VideoErrorCode::InvalidPath,
            "The selected path is not valid for this operation",
            json!({ "operation": operation, "category": category }),
        )
    }

    pub(crate) fn path_not_granted(operation: &'static str, category: &'static str) -> Self {
        Self::new(
            VideoErrorCode::PathNotGranted,
            "The selected path is not authorized for this window",
            json!({ "operation": operation, "category": category }),
        )
    }

    pub(crate) fn project_io(operation: &'static str, category: &'static str) -> Self {
        Self::new(
            VideoErrorCode::ProjectIo,
            "The project file operation failed",
            json!({ "operation": operation, "category": category }),
        )
    }

    pub(crate) fn tool_unavailable(operation: &'static str, executable: &'static str) -> Self {
        Self::new(
            VideoErrorCode::ToolUnavailable,
            "A required media tool is unavailable",
            json!({ "operation": operation, "executable": executable }),
        )
    }

    pub(crate) fn bundled_toolchain(
        operation: &'static str,
        category: &'static str,
        timed_out: bool,
        failed: bool,
    ) -> Self {
        let (code, message) = if timed_out {
            (
                VideoErrorCode::ProcessTimeout,
                "Bundled media-tool verification timed out",
            )
        } else if failed {
            (
                VideoErrorCode::ProcessFailed,
                "Bundled media-tool verification failed",
            )
        } else {
            (
                VideoErrorCode::ToolUnavailable,
                "Bundled media tools are unavailable",
            )
        };
        Self::new(
            code,
            message,
            json!({
                "operation": operation,
                "executable": "bundled",
                "category": category,
            }),
        )
    }

    pub(crate) fn process_failed(
        operation: &'static str,
        executable: &'static str,
        exit_code: Option<i32>,
    ) -> Self {
        Self::new(
            VideoErrorCode::ProcessFailed,
            "The media tool process failed",
            json!({
                "operation": operation,
                "executable": executable,
                "exitCode": exit_code,
            }),
        )
    }

    pub(crate) fn process_timeout(operation: &'static str, executable: &'static str) -> Self {
        Self::new(
            VideoErrorCode::ProcessTimeout,
            "The media tool process timed out",
            json!({ "operation": operation, "executable": executable }),
        )
    }

    pub(crate) fn process_cancelled(operation: &'static str, executable: &'static str) -> Self {
        Self::new(
            VideoErrorCode::ProcessCancelled,
            "The media tool process was cancelled",
            json!({ "operation": operation, "executable": executable }),
        )
    }

    pub(crate) fn process_output_limit(
        operation: &'static str,
        executable: &'static str,
        limit_bytes: usize,
    ) -> Self {
        Self::new(
            VideoErrorCode::ProcessOutputLimit,
            "The media tool returned too much structured output",
            json!({
                "operation": operation,
                "executable": executable,
                "limitBytes": limit_bytes,
            }),
        )
    }

    pub(crate) fn invalid_media(operation: &'static str, category: &'static str) -> Self {
        Self::new(
            VideoErrorCode::InvalidMedia,
            "The media file is malformed or unsupported",
            json!({ "operation": operation, "category": category }),
        )
    }

    pub(crate) fn invalid_render_plan(category: &'static str) -> Self {
        Self::new(
            VideoErrorCode::InvalidRenderPlan,
            "The render plan failed strict validation",
            json!({ "operation": "validate_render_plan", "category": category }),
        )
    }

    pub(crate) fn output_exists(operation: &'static str) -> Self {
        Self::new(
            VideoErrorCode::OutputExists,
            "The selected export destination already exists",
            json!({ "operation": operation, "category": "destination_collision" }),
        )
    }

    pub(crate) fn preview_preparation_failed(category: &'static str) -> Self {
        Self::new(
            VideoErrorCode::ProjectIo,
            "The export completed but its preview could not be prepared",
            json!({
                "operation": "prepare_render_preview",
                "category": category,
                "outputExists": true,
            }),
        )
    }
}

#[derive(Debug, Error)]
pub(crate) enum ProjectIoError {
    #[error("filesystem operation failed")]
    Io(#[from] std::io::Error),
    #[error("JSON operation failed")]
    Json(#[from] serde_json::Error),
}

impl ProjectIoError {
    pub(crate) fn into_command(
        self,
        operation: &'static str,
        category: &'static str,
    ) -> VideoCommandError {
        let _ = self;
        VideoCommandError::project_io(operation, category)
    }
}
