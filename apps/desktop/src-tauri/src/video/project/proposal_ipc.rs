//! IPC for edit proposals. Every command is gated by the `agentProposals`
//! switch, which is off unless the app was started with
//! `SUPA_VIDEO_AGENT_PROPOSALS=1`. When off, commands fail closed.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, Runtime, WebviewWindow};

use super::{
    proposal::StoredProposal,
    service::{ProposalListing, VideoProjectService, DEFAULT_PROPOSAL_TTL_MS},
    types::CommandResult,
};
use crate::video::{
    error::{VideoCommandError, VideoErrorCode},
    grants::VideoPathGrants,
};

pub const AGENT_PROPOSALS_ENV: &str = "SUPA_VIDEO_AGENT_PROPOSALS";

/// Feature switch for agent/rule edit proposals. Read once at startup.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProposalsSwitch {
    pub enabled: bool,
}

impl AgentProposalsSwitch {
    pub fn from_env() -> Self {
        Self {
            enabled: std::env::var_os(AGENT_PROPOSALS_ENV).is_some_and(|value| value == "1"),
        }
    }

    fn require(self) -> Result<(), VideoCommandError> {
        if self.enabled {
            Ok(())
        } else {
            Err(VideoCommandError::project_error(
                VideoErrorCode::InvalidCommand,
                "Edit proposals are turned off",
                "project_proposal",
                "feature_disabled",
            ))
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

async fn run_gated<R, T, F>(
    window: &WebviewWindow<R>,
    operation: &'static str,
    task: F,
) -> Result<T, VideoCommandError>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(tauri::AppHandle<R>, String) -> Result<T, VideoCommandError> + Send + 'static,
{
    let app = window.app_handle().clone();
    let switch = app
        .try_state::<AgentProposalsSwitch>()
        .map(|state| *state.inner())
        .unwrap_or_default();
    switch.require()?;
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || task(app, owner))
        .await
        .map_err(|_| VideoCommandError::project_io(operation, "worker"))?
}

#[tauri::command]
pub fn video_agent_proposals_status<R: Runtime>(window: WebviewWindow<R>) -> AgentProposalsSwitch {
    window
        .app_handle()
        .try_state::<AgentProposalsSwitch>()
        .map(|state| *state.inner())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn video_list_proposals<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
) -> Result<ProposalListing, VideoCommandError> {
    run_gated(&window, "list_proposals", move |app, owner| {
        app.state::<VideoProjectService>()
            .list_proposals(&owner, &project_id, now_ms())
    })
    .await
}

#[tauri::command]
pub async fn video_submit_proposal<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
    proposal: Value,
) -> Result<StoredProposal, VideoCommandError> {
    run_gated(&window, "submit_proposal", move |app, owner| {
        app.state::<VideoProjectService>().submit_proposal(
            &owner,
            &project_id,
            &proposal,
            now_ms(),
            DEFAULT_PROPOSAL_TTL_MS,
        )
    })
    .await
}

/// Applies the approved ranges. `approved` is the proposal re-derived for
/// exactly those ranges (the full proposal when everything was approved).
#[tauri::command]
pub async fn video_apply_proposal<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
    proposal_id: String,
    approved: Value,
) -> Result<CommandResult, VideoCommandError> {
    run_gated(&window, "apply_proposal", move |app, owner| {
        let grants = app.state::<VideoPathGrants>();
        app.state::<VideoProjectService>().apply_proposal(
            &owner,
            &project_id,
            &proposal_id,
            &approved,
            now_ms(),
            &grants,
        )
    })
    .await
}

#[tauri::command]
pub async fn video_reject_proposal<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
    proposal_id: String,
) -> Result<StoredProposal, VideoCommandError> {
    run_gated(&window, "reject_proposal", move |app, owner| {
        app.state::<VideoProjectService>().reject_proposal(
            &owner,
            &project_id,
            &proposal_id,
            now_ms(),
        )
    })
    .await
}

#[tauri::command]
pub async fn video_mark_proposal_stale<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
    proposal_id: String,
    reason: String,
) -> Result<StoredProposal, VideoCommandError> {
    run_gated(&window, "mark_proposal_stale", move |app, owner| {
        app.state::<VideoProjectService>().mark_proposal_stale(
            &owner,
            &project_id,
            &proposal_id,
            &reason,
            now_ms(),
        )
    })
    .await
}

#[tauri::command]
pub async fn video_restore_before_proposal<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
    proposal_id: String,
    operation_id: String,
) -> Result<Vec<CommandResult>, VideoCommandError> {
    run_gated(&window, "restore_before_proposal", move |app, owner| {
        let grants = app.state::<VideoPathGrants>();
        app.state::<VideoProjectService>().restore_before_proposal(
            &owner,
            &project_id,
            &proposal_id,
            &operation_id,
            now_ms(),
            &grants,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_is_off_by_default_and_fails_closed() {
        let switch = AgentProposalsSwitch::default();
        assert!(!switch.enabled);
        let error = switch.require().unwrap_err();
        assert_eq!(error.details["category"], "feature_disabled");
        assert!(AgentProposalsSwitch { enabled: true }.require().is_ok());
    }
}
