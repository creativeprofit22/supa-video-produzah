use serde::Serialize;
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoErrorCode {
    InvalidProject,
    UnsupportedSchema,
    Phase1Limit,
    InvalidPath,
    PathNotGranted,
    ProjectIo,
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
