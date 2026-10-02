use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Deserialize;
use serde_json::Value;

use crate::rights::gate::{
    release_gate, write_credits_sidecar, GateInput, GateOutcome, RenderRights,
};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, Runtime, State, WebviewWindow};
use tempfile::{Builder as TempFileBuilder, TempPath};

use super::{
    derived::{duration_within_one_frame, MediaPrograms},
    error::{VideoCommandError, VideoErrorCode},
    grants::{normalize_existing_file, GrantCategory, VideoPathGrants},
    jobs::{
        current_timestamp_millis,
        model::{
            MediaJobError, MediaJobErrorCategory, MediaJobEventType, MediaJobKind,
            MediaJobPriority, MediaJobProgress, MediaJobProgressUnit, MediaJobRecoveryAction,
            MediaJobState,
        },
        scheduler::{
            MediaJobFinalOutcome, MediaJobWorker, MediaWorkerFuture, MediaWorkerOutcome,
            SchedulerResource,
        },
        store::{MediaJobStore, MediaJobTransition, MediaStateStoreError, NewMediaJob},
        MediaJobService,
    },
    media_store::MEDIA_STORE_NAMESPACE,
    probe::{probe_trusted_media_with_program, InspectedMedia},
    process::{
        run_supervised_streaming, ProcessCancellation, ProcessFailure, ProcessSpec,
        StdoutRecordObserver,
    },
    qc::{validate_editorial_evaluation, DeliveryGate, RenderQcContext, RenderQcResult},
    render_manifest::{supersede_review_record, write_manifest},
    toolchain::MediaToolchainState,
    types::{
        graphics_input_sentinel, RenderCaptionInput, RenderPlan, RenderPlanV1, RenderPlanV2,
        VerifiedRenderOutput, VideoRenderEvent, VideoRenderStarted, MAX_SAFE_INTEGER,
    },
};

pub const VIDEO_RENDER_EVENT: &str = "video:render-event";
const MAX_RENDER_ARGUMENTS: usize = 128;
const MAX_RENDER_ARGUMENT_UTF16: usize = 32_768;
const MAX_RENDER_CAPTIONS: usize = 100_000;
const MAX_RENDER_CAPTION_UTF16: usize = 16_384;

pub(crate) type RenderEventSink =
    Arc<dyn Fn(VideoRenderEvent) -> Result<(), VideoCommandError> + Send + Sync + 'static>;

#[derive(Debug, Clone)]
pub(crate) struct RenderEventIdentity {
    pub(crate) job_id: String,
    pub(crate) plan_id: String,
    pub(crate) revision_id: String,
}

impl RenderEventIdentity {
    pub(crate) fn started(&self) -> VideoRenderEvent {
        VideoRenderEvent::Started {
            job_id: self.job_id.clone(),
            plan_id: self.plan_id.clone(),
            revision_id: self.revision_id.clone(),
        }
    }

    pub(crate) fn progress(
        &self,
        completed_microseconds: u64,
        duration_microseconds: u64,
    ) -> VideoRenderEvent {
        VideoRenderEvent::Progress {
            job_id: self.job_id.clone(),
            plan_id: self.plan_id.clone(),
            revision_id: self.revision_id.clone(),
            completed_microseconds,
            duration_microseconds,
        }
    }

    pub(crate) fn completed(&self, output: VerifiedRenderOutput) -> VideoRenderEvent {
        VideoRenderEvent::Completed {
            job_id: self.job_id.clone(),
            plan_id: self.plan_id.clone(),
            revision_id: self.revision_id.clone(),
            output,
        }
    }

    pub(crate) fn failed(&self, error: VideoCommandError) -> VideoRenderEvent {
        VideoRenderEvent::Failed {
            job_id: self.job_id.clone(),
            plan_id: self.plan_id.clone(),
            revision_id: self.revision_id.clone(),
            error,
        }
    }

    pub(crate) fn cancelled(&self) -> VideoRenderEvent {
        VideoRenderEvent::Cancelled {
            job_id: self.job_id.clone(),
            plan_id: self.plan_id.clone(),
            revision_id: self.revision_id.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ValidatedRenderPlan {
    pub(crate) plan: RenderPlan,
    pub(crate) input_paths: Vec<PathBuf>,
    /// Grant-checked still images for graphics image layers, by asset id (ADR 0003).
    pub(crate) graphics_image_paths: std::collections::BTreeMap<String, PathBuf>,
    pub(crate) output_path: PathBuf,
    pub(crate) duration_microseconds: u64,
    /// QC context (editorial evaluation bound to the revision state hash, and
    /// the Deliver gate). Always set by `video_start_render`; `None` only for
    /// internal callers without a project (tests, legacy persisted jobs).
    pub(crate) qc: Option<RenderQcContext>,
}

#[derive(Default)]
struct RenderCompatibilityLifecycle {
    pending_terminal: Option<VideoRenderEvent>,
    emitted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedFinalRenderPayload {
    owner_label: String,
    plan: RenderPlan,
    overwrite: bool,
    output_authorization_present: bool,
    #[serde(default)]
    qc: Option<RenderQcContext>,
}

struct FinalRenderWorker {
    validated: ValidatedRenderPlan,
    overwrite: bool,
    app_cache_dir: PathBuf,
    programs: MediaPrograms,
    identity: RenderEventIdentity,
    store: MediaJobStore,
    compatibility_events: RenderEventSink,
    compatibility_lifecycle: Arc<Mutex<RenderCompatibilityLifecycle>>,
}

impl MediaJobWorker for FinalRenderWorker {
    fn run(&self, job_id: String, cancellation: ProcessCancellation) -> MediaWorkerFuture {
        let validated = self.validated.clone();
        let overwrite = self.overwrite;
        let app_cache_dir = self.app_cache_dir.clone();
        let programs = self.programs.clone();
        let identity = self.identity.clone();
        let store = self.store.clone();
        let compatibility_events = self.compatibility_events.clone();
        let compatibility_lifecycle = self.compatibility_lifecycle.clone();
        Box::pin(async move {
            let progress_gate = Arc::new(Mutex::new((
                std::time::Instant::now() - Duration::from_millis(250),
                0_u64,
            )));
            let gate_for_events = progress_gate.clone();
            let store_for_events = store.clone();
            let job_for_events = job_id.clone();
            let compatibility_for_events = compatibility_events.clone();
            let events: RenderEventSink = Arc::new(move |event| {
                let compatibility_result = compatibility_for_events(event.clone());
                if let VideoRenderEvent::Progress {
                    completed_microseconds,
                    duration_microseconds,
                    ..
                } = event
                {
                    let persist = gate_for_events.lock().is_ok_and(|mut gate| {
                        let old_percent = gate
                            .1
                            .saturating_mul(100)
                            .checked_div(duration_microseconds)
                            .unwrap_or(0);
                        let new_percent = completed_microseconds
                            .saturating_mul(100)
                            .checked_div(duration_microseconds)
                            .unwrap_or(0);
                        if new_percent > old_percent
                            || gate.0.elapsed() >= Duration::from_millis(250)
                        {
                            *gate = (std::time::Instant::now(), completed_microseconds);
                            true
                        } else {
                            false
                        }
                    });
                    if persist {
                        let progress_store = store_for_events.clone();
                        let progress_job = job_for_events.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = progress_store
                                .transition(
                                    progress_job,
                                    MediaJobTransition {
                                        state: MediaJobState::Running,
                                        stage: "render".to_owned(),
                                        progress: MediaJobProgress {
                                            completed: completed_microseconds,
                                            total: duration_microseconds,
                                            unit: MediaJobProgressUnit::Microseconds,
                                        },
                                        attempt: None,
                                        error: None,
                                        retry_at_ms: None,
                                        result: None,
                                        cancellation_requested: false,
                                        event_type: MediaJobEventType::Progress,
                                        message: None,
                                        occurred_at_ms: current_timestamp_millis(),
                                    },
                                )
                                .await;
                        });
                    }
                }
                compatibility_result
            });
            let request = RenderWorkerRequest {
                validated,
                overwrite,
                app_cache_dir,
                programs,
                cancellation,
                identity: identity.clone(),
                events,
                hooks: RenderWorkerHooks::default(),
            };
            match execute_render_worker(&request).await {
                Ok(output) => {
                    if let Ok(mut lifecycle) = compatibility_lifecycle.lock() {
                        lifecycle.pending_terminal = Some(identity.completed(output.clone()));
                    }
                    MediaWorkerOutcome::Complete {
                        result: serde_json::to_value(output).unwrap_or(Value::Null),
                        progress: MediaJobProgress {
                            completed: request.validated.duration_microseconds,
                            total: request.validated.duration_microseconds,
                            unit: MediaJobProgressUnit::Microseconds,
                        },
                    }
                }
                Err(error) if error.code == VideoErrorCode::ProcessCancelled => {
                    if let Ok(mut lifecycle) = compatibility_lifecycle.lock() {
                        lifecycle.pending_terminal = Some(identity.cancelled());
                    }
                    MediaWorkerOutcome::Cancelled {
                        progress: MediaJobProgress {
                            completed: 0,
                            total: request.validated.duration_microseconds,
                            unit: MediaJobProgressUnit::Microseconds,
                        },
                    }
                }
                Err(error) => {
                    if let Ok(mut lifecycle) = compatibility_lifecycle.lock() {
                        lifecycle.pending_terminal = Some(identity.failed(error.clone()));
                    }
                    MediaWorkerOutcome::Failed {
                        error: render_job_error(&error),
                        progress: MediaJobProgress {
                            completed: 0,
                            total: request.validated.duration_microseconds,
                            unit: MediaJobProgressUnit::Microseconds,
                        },
                    }
                }
            }
        })
    }

    fn on_terminal(&self, outcome: MediaJobFinalOutcome) {
        let event = {
            let Ok(mut lifecycle) = self.compatibility_lifecycle.lock() else {
                return;
            };
            if lifecycle.emitted {
                return;
            }
            let event = match outcome {
                MediaJobFinalOutcome::Cancelled => self.identity.cancelled(),
                MediaJobFinalOutcome::Complete => {
                    let Some(event @ VideoRenderEvent::Completed { .. }) =
                        lifecycle.pending_terminal.take()
                    else {
                        return;
                    };
                    event
                }
                MediaJobFinalOutcome::Failed => {
                    let Some(event @ VideoRenderEvent::Failed { .. }) =
                        lifecycle.pending_terminal.take()
                    else {
                        return;
                    };
                    event
                }
            };
            lifecycle.emitted = true;
            event
        };
        let _ = (self.compatibility_events)(event);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn video_start_render<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    jobs: State<'_, MediaJobService>,
    toolchain: State<'_, MediaToolchainState>,
    projects: State<'_, super::VideoProjectService>,
    plan: Value,
    overwrite: bool,
    editorial: Option<Value>,
) -> Result<VideoRenderStarted, VideoCommandError> {
    let app_cache_dir = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| VideoCommandError::project_io("start_render", "app_cache"))?;
    toolchain
        .verified_programs()
        .await
        .map_err(|error| error.into_command_error("start_render"))?;
    let programs = MediaPrograms::bundled(toolchain.inner().clone());
    let event_window = window.clone();
    let events: RenderEventSink = Arc::new(move |event| {
        event_window
            .emit(VIDEO_RENDER_EVENT, event)
            .map_err(|_| VideoCommandError::project_io("emit_render_event", "owner_window"))
    });
    let rights_service = window
        .app_handle()
        .try_state::<crate::rights::service::RightsService>()
        .ok_or_else(|| VideoCommandError::invalid_render_plan("rights_unavailable"))?;
    let rights = rights_service.render_rights();
    let owner = window.label().to_owned();
    let lookup = |revision_id: &str| projects.open_revision_state_hash(&owner, revision_id);
    start_render_with_qc(
        &owner,
        &grants,
        &rights,
        &jobs,
        programs,
        app_cache_dir,
        RenderQcRequest {
            plan,
            editorial,
            delivery: None,
            revision_state_hash: &lookup,
        },
        overwrite,
        events,
    )
    .await
}

/// Untrusted QC inputs of a render request plus the trusted revision lookup.
pub(crate) struct RenderQcRequest<'a> {
    pub(crate) plan: Value,
    pub(crate) editorial: Option<Value>,
    pub(crate) delivery: Option<DeliveryGate>,
    pub(crate) revision_state_hash: &'a (dyn Fn(&str) -> Option<String> + Send + Sync),
}

/// Validates the plan (including the rights gate), then the editorial
/// evaluation against the open revision; fails closed before any encoding.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_render_with_qc(
    owner_label: &str,
    grants: &VideoPathGrants,
    rights: &RenderRights<'_>,
    jobs: &MediaJobService,
    programs: MediaPrograms,
    app_cache_dir: PathBuf,
    request: RenderQcRequest<'_>,
    overwrite: bool,
    events: RenderEventSink,
) -> Result<VideoRenderStarted, VideoCommandError> {
    let mut validated =
        parse_and_validate_render_plan_with_rights(request.plan, owner_label, grants, rights)?;
    let revision_id = validated.plan.revision_id().as_str().to_owned();
    let state_hash = (request.revision_state_hash)(&revision_id);
    let editorial =
        validate_editorial_evaluation(request.editorial, &revision_id, state_hash.as_deref())?;
    validated.qc = Some(RenderQcContext {
        revision_state_hash: editorial.revision_state_hash.clone(),
        editorial,
        delivery: request.delivery,
    });
    start_validated_render_with_context(
        owner_label,
        jobs,
        programs,
        app_cache_dir,
        validated,
        overwrite,
        events,
    )
    .await
}

#[cfg(test)]
pub(crate) fn no_receipts_rights() -> RenderRights<'static> {
    RenderRights {
        lookup: &crate::rights::gate::NoReceipts,
        now_ms: 0,
        freshness: std::time::Duration::from_secs(1),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_validated_render_with_context(
    owner_label: &str,
    jobs: &MediaJobService,
    programs: MediaPrograms,
    app_cache_dir: PathBuf,
    validated: ValidatedRenderPlan,
    overwrite: bool,
    events: RenderEventSink,
) -> Result<VideoRenderStarted, VideoCommandError> {
    if !overwrite && validated.output_path.exists() {
        return Err(VideoCommandError::output_exists("start_render"));
    }
    let enqueued = jobs
        .store()
        .enqueue(NewMediaJob {
            kind: MediaJobKind::FinalRender,
            parent_id: None,
            dedupe_key: render_dedupe_key(&validated, overwrite),
            project_id: None,
            asset_id: None,
            revision_id: Some(validated.plan.revision_id().as_str().to_owned()),
            priority: MediaJobPriority::Export,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: validated.duration_microseconds,
                unit: MediaJobProgressUnit::Microseconds,
            },
            max_attempts: 3,
            summary: "Export project revision".to_owned(),
            private_payload: serde_json::json!({
                "ownerLabel": owner_label,
                "plan": validated.plan,
                "overwrite": overwrite,
                "outputAuthorizationPresent": true,
                "qc": validated.qc,
            }),
            created_at_ms: current_timestamp_millis(),
        })
        .await
        .map_err(map_render_job_store_error)?;
    let identity = RenderEventIdentity {
        job_id: enqueued.job.id.clone(),
        plan_id: validated.plan.plan_id().as_str().to_owned(),
        revision_id: validated.plan.revision_id().as_str().to_owned(),
    };
    let response = VideoRenderStarted {
        job_id: identity.job_id.clone(),
        plan_id: identity.plan_id.clone(),
        revision_id: identity.revision_id.clone(),
    };
    if enqueued.job.state == MediaJobState::Complete {
        if let Some(output) = jobs
            .store()
            .get_private(enqueued.job.id.clone())
            .await
            .map_err(map_render_job_store_error)?
            .result
            .and_then(|value| serde_json::from_value::<VerifiedRenderOutput>(value).ok())
        {
            let _ = events(identity.completed(output));
        }
        return Ok(response);
    }
    if enqueued.job.state == MediaJobState::Blocked {
        return Err(map_render_job_store_error(
            MediaStateStoreError::InvalidTransition,
        ));
    }
    let _ = events(identity.started());
    if enqueued.job.state == MediaJobState::Queued {
        jobs.scheduler()
            .submit(
                enqueued.job.id,
                MediaJobPriority::Export,
                enqueued.job.attempt,
                enqueued.job.max_attempts,
                SchedulerResource::Ffmpeg,
                Arc::new(FinalRenderWorker {
                    validated,
                    overwrite,
                    app_cache_dir,
                    programs,
                    identity,
                    store: jobs.store().clone(),
                    compatibility_events: events,
                    compatibility_lifecycle: Arc::new(Mutex::new(
                        RenderCompatibilityLifecycle::default(),
                    )),
                }),
            )
            .await
            .map_err(map_render_job_store_error)?;
    }
    Ok(response)
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn reauthorize_final_render_output_with_context(
    owner_label: &str,
    grants: &VideoPathGrants,
    jobs: &MediaJobService,
    programs: MediaPrograms,
    app_cache_dir: PathBuf,
    job_id: &str,
    output_path: &str,
    events: RenderEventSink,
) -> Result<super::jobs::model::MediaJobRecord, VideoCommandError> {
    reauthorize_final_render_output_with_rights(
        owner_label,
        grants,
        &no_receipts_rights(),
        jobs,
        programs,
        app_cache_dir,
        job_id,
        output_path,
        events,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn reauthorize_final_render_output_with_rights(
    owner_label: &str,
    grants: &VideoPathGrants,
    rights: &RenderRights<'_>,
    jobs: &MediaJobService,
    programs: MediaPrograms,
    app_cache_dir: PathBuf,
    job_id: &str,
    output_path: &str,
    events: RenderEventSink,
) -> Result<super::jobs::model::MediaJobRecord, VideoCommandError> {
    let stored = jobs
        .store()
        .get_private(job_id.to_owned())
        .await
        .map_err(map_render_job_store_error)?;
    let owner_matches = stored
        .private_payload
        .get("ownerLabel")
        .and_then(Value::as_str)
        .is_some_and(|owner| owner == owner_label);
    if stored.public.kind != MediaJobKind::FinalRender || !owner_matches {
        return Err(VideoCommandError::invalid_render_plan("unknown_job"));
    }
    let reauthorization_required = stored.public.state == MediaJobState::Blocked
        && !stored.public.cancellation_requested
        && stored.public.error.as_ref().is_some_and(|error| {
            error.category == MediaJobErrorCategory::OutputAuthorizationRequired
                && error.action == Some(MediaJobRecoveryAction::ReauthorizeOutput)
        });
    if !reauthorization_required {
        return Err(VideoCommandError::invalid_render_plan(
            "output_reauthorization_state",
        ));
    }

    let payload: PersistedFinalRenderPayload =
        serde_json::from_value(stored.private_payload.clone())
            .map_err(|_| VideoCommandError::invalid_render_plan("persisted_payload"))?;
    if payload.owner_label != owner_label
        || !payload.output_authorization_present
        || stored.public.revision_id.as_deref() != Some(payload.plan.revision_id().as_str())
    {
        return Err(VideoCommandError::invalid_render_plan("persisted_identity"));
    }
    if output_path != payload.plan.output_path() {
        return Err(VideoCommandError::invalid_render_plan(
            "output_path_mismatch",
        ));
    }
    remove_owned_render_partial(&payload.plan)?;
    let authorized_output = grants
        .authorize(owner_label, GrantCategory::Output, Path::new(output_path))
        .map_err(|_| VideoCommandError::invalid_render_plan("output_grant"))?;
    if authorized_output.to_string_lossy() != payload.plan.output_path() {
        return Err(VideoCommandError::invalid_render_plan(
            "output_path_normalization",
        ));
    }

    let plan_id = payload.plan.plan_id().as_str().to_owned();
    let revision_id = payload.plan.revision_id().as_str().to_owned();
    let mut validated = validate_persisted_render_plan(payload.plan, owner_label, grants, rights)?;
    validated.qc = payload.qc;
    if stored.dedupe_key != render_dedupe_key(&validated, payload.overwrite) {
        return Err(VideoCommandError::invalid_render_plan("persisted_identity"));
    }
    let started = start_validated_render_with_context(
        owner_label,
        jobs,
        programs,
        app_cache_dir,
        validated,
        payload.overwrite,
        events,
    )
    .await?;
    if started.job_id != job_id || started.plan_id != plan_id || started.revision_id != revision_id
    {
        return Err(VideoCommandError::invalid_render_plan("persisted_identity"));
    }
    jobs.store()
        .get_private(job_id.to_owned())
        .await
        .map(|stored| stored.public)
        .map_err(map_render_job_store_error)
}

#[tauri::command]
pub async fn video_cancel_render<R: Runtime>(
    window: WebviewWindow<R>,
    jobs: State<'_, MediaJobService>,
    job_id: String,
) -> Result<(), VideoCommandError> {
    cancel_render_for_owner(window.label(), &jobs, &job_id).await
}

pub(crate) async fn cancel_render_for_owner(
    owner_label: &str,
    jobs: &MediaJobService,
    job_id: &str,
) -> Result<(), VideoCommandError> {
    let stored = match jobs.store().get_private(job_id.to_owned()).await {
        Ok(stored) => stored,
        Err(MediaStateStoreError::NotFound) => {
            return Err(VideoCommandError::invalid_render_plan("unknown_job"));
        }
        Err(error) => return Err(map_render_job_store_error(error)),
    };
    let owner_matches = stored
        .private_payload
        .get("ownerLabel")
        .and_then(Value::as_str)
        .is_some_and(|owner| owner == owner_label);
    if stored.public.kind != MediaJobKind::FinalRender || !owner_matches {
        return Err(VideoCommandError::invalid_render_plan("unknown_job"));
    }
    if stored.public.state.is_terminal() {
        return Ok(());
    }
    jobs.scheduler()
        .cancel(job_id)
        .await
        .map_err(map_render_job_store_error)
}

pub(crate) fn render_dedupe_key(validated: &ValidatedRenderPlan, overwrite: bool) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"supa-video/final-render-job/v1");
    hasher.update(serde_json::to_vec(&validated.plan).unwrap_or_else(|_| Vec::new()));
    hasher.update([u8::from(overwrite)]);
    // A different editorial evaluation or Deliver gate is a different job.
    if let Some(qc) = &validated.qc {
        hasher.update(b"qc");
        hasher.update(serde_json::to_vec(qc).unwrap_or_else(|_| Vec::new()));
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    format!("final_render:{encoded}")
}

fn render_job_error(error: &VideoCommandError) -> MediaJobError {
    if error.code == VideoErrorCode::ProjectIo
        && error.details.get("outputExists").and_then(Value::as_bool) == Some(true)
    {
        return MediaJobError {
            code: "render_preview_failed".to_owned(),
            category: MediaJobErrorCategory::ProcessFailed,
            message: "The export completed, but its preview could not be prepared.".to_owned(),
            retryable: false,
            action: None,
        };
    }
    let (category, retryable, action, code, message) = match error.code {
        VideoErrorCode::ToolUnavailable => (
            MediaJobErrorCategory::ToolchainUnavailable,
            false,
            Some(MediaJobRecoveryAction::VerifyToolchain),
            "toolchain_unavailable",
            "The verified media tools are unavailable.",
        ),
        VideoErrorCode::ProcessFailed
        | VideoErrorCode::ProcessTimeout
        | VideoErrorCode::ProjectIo => (
            MediaJobErrorCategory::ProcessFailed,
            true,
            Some(MediaJobRecoveryAction::Retry),
            "render_process_failed",
            "The export process failed.",
        ),
        VideoErrorCode::InvalidMedia | VideoErrorCode::InvalidRenderPlan => (
            MediaJobErrorCategory::InvalidMedia,
            false,
            None,
            "invalid_render",
            "The export could not be validated.",
        ),
        _ => (
            MediaJobErrorCategory::PolicyRejected,
            false,
            None,
            "render_failed",
            "The export could not continue.",
        ),
    };
    MediaJobError {
        code: code.to_owned(),
        category,
        message: message.to_owned(),
        retryable,
        action,
    }
}

fn map_render_job_store_error(_error: MediaStateStoreError) -> VideoCommandError {
    #[cfg(test)]
    eprintln!("durable render job store error: {_error:?}");
    VideoCommandError::project_io("render_job", "media_job_state")
}

#[cfg(test)]
pub(crate) fn parse_and_validate_render_plan(
    value: Value,
    owner_label: &str,
    grants: &VideoPathGrants,
) -> Result<ValidatedRenderPlan, VideoCommandError> {
    parse_and_validate_render_plan_with_rights(value, owner_label, grants, &no_receipts_rights())
}

pub(crate) fn parse_and_validate_render_plan_with_rights(
    value: Value,
    owner_label: &str,
    grants: &VideoPathGrants,
    rights: &RenderRights<'_>,
) -> Result<ValidatedRenderPlan, VideoCommandError> {
    let plan: RenderPlan = serde_json::from_value(value)
        .map_err(|_| VideoCommandError::invalid_render_plan("schema"))?;
    validate_render_plan_with_rights(plan, owner_label, grants, rights)
}

pub(crate) fn validate_render_plan_with_rights(
    plan: RenderPlan,
    owner_label: &str,
    grants: &VideoPathGrants,
    rights: &RenderRights<'_>,
) -> Result<ValidatedRenderPlan, VideoCommandError> {
    let requested_inputs: Vec<&str> = match &plan {
        RenderPlan::V1(plan) => vec![plan.input_path.as_str()],
        RenderPlan::V2(plan) => plan
            .input_paths_by_asset_id
            .values()
            .map(String::as_str)
            .collect(),
    };
    let mut input_paths = Vec::with_capacity(requested_inputs.len());
    for requested_input in requested_inputs {
        input_paths.push(
            grants
                .authorize(
                    owner_label,
                    GrantCategory::Source,
                    Path::new(requested_input),
                )
                .map_err(|_| VideoCommandError::invalid_render_plan("input_grant"))?,
        );
    }
    validate_render_plan_with_inputs(plan, owner_label, grants, input_paths, rights)
}

pub(crate) fn validate_persisted_render_plan(
    plan: RenderPlan,
    owner_label: &str,
    grants: &VideoPathGrants,
    rights: &RenderRights<'_>,
) -> Result<ValidatedRenderPlan, VideoCommandError> {
    let requested_inputs: Vec<&str> = match &plan {
        RenderPlan::V1(plan) => vec![plan.input_path.as_str()],
        RenderPlan::V2(plan) => plan
            .input_paths_by_asset_id
            .values()
            .map(String::as_str)
            .collect(),
    };
    let mut input_paths = Vec::with_capacity(requested_inputs.len());
    for requested_input in requested_inputs {
        input_paths.push(
            normalize_existing_file(
                Path::new(requested_input),
                "reauthorize_render",
                GrantCategory::Source,
            )
            .map_err(|_| VideoCommandError::invalid_render_plan("persisted_input"))?,
        );
    }
    validate_render_plan_with_inputs(plan, owner_label, grants, input_paths, rights)
}

fn validate_render_plan_with_inputs(
    plan: RenderPlan,
    owner_label: &str,
    grants: &VideoPathGrants,
    input_paths: Vec<PathBuf>,
    rights: &RenderRights<'_>,
) -> Result<ValidatedRenderPlan, VideoCommandError> {
    let correct_version = matches!(&plan, RenderPlan::V1(value) if value.schema_version == 1)
        || matches!(&plan, RenderPlan::V2(value) if value.schema_version == 2);
    if !correct_version {
        return Err(VideoCommandError::invalid_render_plan("schema_version"));
    }
    if plan.executable() != "ffmpeg" {
        return Err(VideoCommandError::invalid_render_plan("executable"));
    }
    validate_expectation(plan.expected())?;
    validate_captions(&plan)?;
    validate_argument_text(&plan)?;

    let output_path = grants
        .authorize(
            owner_label,
            GrantCategory::Output,
            Path::new(plan.output_path()),
        )
        .map_err(|_| VideoCommandError::invalid_render_plan("output_grant"))?;
    if input_paths
        .iter()
        .any(|input| paths_equal(input, &output_path))
    {
        return Err(VideoCommandError::invalid_render_plan("path_alias"));
    }
    let requested_inputs: Vec<&str> = match &plan {
        RenderPlan::V1(plan) => vec![plan.input_path.as_str()],
        RenderPlan::V2(plan) => plan
            .input_paths_by_asset_id
            .values()
            .map(String::as_str)
            .collect(),
    };
    if input_paths
        .iter()
        .zip(requested_inputs)
        .any(|(normalized, requested)| normalized.to_string_lossy() != requested)
        || output_path.to_string_lossy() != plan.output_path()
    {
        return Err(VideoCommandError::invalid_render_plan("path_normalization"));
    }
    if output_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("mp4"))
    {
        return Err(VideoCommandError::invalid_render_plan("output_extension"));
    }

    let duration_microseconds = expected_duration_microseconds(plan.expected())?;
    let expected_arguments = match &plan {
        RenderPlan::V1(plan) => {
            if plan
                .argv
                .get(10)
                .is_none_or(|value| !is_canonical_fixed_six(value))
            {
                return Err(VideoCommandError::invalid_render_plan("source_time"));
            }
            expected_render_arguments_v1(plan, duration_microseconds)
        }
        RenderPlan::V2(plan) => expected_render_arguments_v2(plan, duration_microseconds)?,
    };
    if plan.argv() != expected_arguments {
        return Err(VideoCommandError::invalid_render_plan("argv_grammar"));
    }

    if input_paths.is_empty() {
        return Err(VideoCommandError::invalid_render_plan("input_paths"));
    }
    let graphics_image_paths = authorize_graphics_images(&plan, owner_label, grants, &output_path)?;
    enforce_release_gate(
        &plan,
        &input_paths,
        &graphics_image_paths,
        &output_path,
        rights,
    )?;
    Ok(ValidatedRenderPlan {
        plan,
        input_paths,
        graphics_image_paths,
        output_path,
        duration_microseconds,
        qc: None,
    })
}

/// Every graphics image path must be a granted, normalized source; one asset id maps to one path
/// across all graphics inputs, and no image may alias the output.
fn authorize_graphics_images(
    plan: &RenderPlan,
    owner_label: &str,
    grants: &VideoPathGrants,
    output_path: &Path,
) -> Result<std::collections::BTreeMap<String, PathBuf>, VideoCommandError> {
    let mut authorized = std::collections::BTreeMap::new();
    let RenderPlan::V2(plan) = plan else {
        return Ok(authorized);
    };
    for input in plan.graphics.iter().flatten() {
        let mut clip_image_bytes: u64 = 0;
        for (asset_id, requested) in &input.image_paths_by_asset_id {
            let normalized = grants
                .authorize(owner_label, GrantCategory::Source, Path::new(requested))
                .map_err(|_| VideoCommandError::invalid_render_plan("graphics_image_grant"))?;
            if normalized.to_string_lossy() != requested.as_str()
                || paths_equal(&normalized, output_path)
            {
                return Err(VideoCommandError::invalid_render_plan(
                    "graphics_image_path",
                ));
            }
            match authorized.get(asset_id.as_str()) {
                Some(existing) if existing != &normalized => {
                    return Err(VideoCommandError::invalid_render_plan(
                        "graphics_image_path",
                    ));
                }
                _ => {
                    authorized.insert(asset_id.as_str().to_owned(), normalized.clone());
                }
            }
            // The renderer bounds a clip's embedded image bytes; reject before any overlay renders.
            let bytes = std::fs::metadata(&normalized)
                .map_err(|_| VideoCommandError::invalid_render_plan("graphics_image_path"))?
                .len();
            clip_image_bytes = clip_image_bytes.saturating_add(bytes);
            if clip_image_bytes > MAX_GRAPHICS_IMAGE_BYTES_PER_CLIP {
                return Err(VideoCommandError::invalid_render_plan(
                    "graphics_image_bytes",
                ));
            }
        }
    }
    Ok(authorized)
}

/// Rights release gate for every input (fresh and persisted paths), media clips and graphics
/// still images alike. Remote inputs are found by content digest; local imports (no receipt for
/// their bytes) pass unchanged.
fn enforce_release_gate(
    plan: &RenderPlan,
    input_paths: &[PathBuf],
    graphics_image_paths: &std::collections::BTreeMap<String, PathBuf>,
    output_path: &Path,
    rights: &RenderRights<'_>,
) -> Result<(), VideoCommandError> {
    // (asset id, input path) pairs taken from the map entries themselves, so pairing never
    // depends on iteration order. Each value was already checked to equal its normalized,
    // granted path (`path_normalization`), so hashing it hashes the authorized input.
    let mut entries: Vec<(Option<&str>, &Path)> = match plan {
        RenderPlan::V1(_) => input_paths
            .iter()
            .map(|path| (None, path.as_path()))
            .collect(),
        RenderPlan::V2(plan) => plan
            .input_paths_by_asset_id
            .iter()
            .map(|(id, path)| (Some(id.as_str()), Path::new(path.as_str())))
            .collect(),
    };
    if entries.len() != input_paths.len() {
        return Err(VideoCommandError::invalid_render_plan("input_paths"));
    }
    // Graphics still images are embedded in the export too. An asset already gated as a media
    // input at the same path is not gated twice; its claimed receipt applies to both uses.
    for (asset_id, path) in graphics_image_paths {
        if !entries
            .iter()
            .any(|(id, gated)| *id == Some(asset_id.as_str()) && paths_equal(gated, path))
        {
            entries.push((Some(asset_id.as_str()), path.as_path()));
        }
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let context = match plan {
        RenderPlan::V1(_) => None,
        RenderPlan::V2(plan) => plan.rights.as_ref(),
    };
    let claimed: std::collections::BTreeMap<String, uuid::Uuid> = context
        .map(|context| {
            context
                .acquisition_receipt_ids_by_asset_id
                .iter()
                .map(|(asset, receipt)| (asset.as_str().to_owned(), *receipt))
                .collect()
        })
        .unwrap_or_default();
    if claimed
        .keys()
        .any(|asset| !entries.iter().any(|(id, _)| *id == Some(asset.as_str())))
    {
        return Err(VideoCommandError::invalid_render_plan("rights_context"));
    }
    let inputs: Vec<GateInput<'_>> = entries
        .into_iter()
        .map(|(asset_id, path)| GateInput { asset_id, path })
        .collect();
    let started = std::time::Instant::now();
    let outcome = release_gate(
        rights,
        &inputs,
        context.map(|context| context.intended_use),
        &claimed,
    );
    match outcome {
        GateOutcome::Blocked { failures } => {
            let reason = failures
                .first()
                .map(|failure| failure.reason.render_field())
                .unwrap_or("rights_blocked");
            eprintln!(
                "rights.release_gate outcome=blocked reason={reason} failures={} elapsed_ms={}",
                failures.len(),
                started.elapsed().as_millis()
            );
            Err(VideoCommandError::invalid_render_plan(reason))
        }
        GateOutcome::Pass { credits } if credits.is_empty() => Ok(()),
        GateOutcome::Pass { credits } => {
            write_credits_sidecar(output_path, &credits)
                .map_err(|_| VideoCommandError::invalid_render_plan("rights_credits_write"))?;
            eprintln!(
                "rights.release_gate outcome=pass credited={} elapsed_ms={}",
                credits.len(),
                started.elapsed().as_millis()
            );
            Ok(())
        }
    }
}

fn validate_expectation(
    expected: &super::types::RenderExpectation,
) -> Result<(), VideoCommandError> {
    let positive_safe = |value: u64| (1..=MAX_SAFE_INTEGER).contains(&value);
    if !positive_safe(expected.duration_frames)
        || !positive_safe(expected.rate.numerator)
        || !positive_safe(expected.rate.denominator)
        || !positive_safe(expected.width)
        || !positive_safe(expected.height)
        || !expected.width.is_multiple_of(2)
        || !expected.height.is_multiple_of(2)
        || greatest_common_divisor(expected.rate.numerator, expected.rate.denominator) != 1
    {
        return Err(VideoCommandError::invalid_render_plan("expectation"));
    }
    Ok(())
}

fn validate_captions(plan: &RenderPlan) -> Result<(), VideoCommandError> {
    let captions = match plan {
        RenderPlan::V1(plan) => &plan.captions,
        RenderPlan::V2(plan) => &plan.captions,
    };
    if captions.len() > MAX_RENDER_CAPTIONS
        || captions.iter().any(|caption| {
            caption.text.is_empty()
                || caption.text.contains('\0')
                || caption.text.encode_utf16().count() > MAX_RENDER_CAPTION_UTF16
                || caption.start_microseconds > MAX_SAFE_INTEGER
                || caption.end_microseconds > MAX_SAFE_INTEGER
                || caption.end_microseconds <= caption.start_microseconds
                || !super::caption_render::valid_caption_style_fields(caption)
        })
    {
        return Err(VideoCommandError::invalid_render_plan("captions"));
    }
    Ok(())
}
fn validate_argument_text(plan: &RenderPlan) -> Result<(), VideoCommandError> {
    let maximum_arguments = if matches!(plan, RenderPlan::V1(_)) {
        MAX_RENDER_ARGUMENTS
    } else {
        10_000
    };
    let paths: Vec<&str> = match plan {
        RenderPlan::V1(plan) => vec![plan.input_path.as_str(), plan.output_path.as_str()],
        RenderPlan::V2(plan) => plan
            .input_paths_by_asset_id
            .values()
            .map(String::as_str)
            .chain(std::iter::once(plan.output_path.as_str()))
            .collect(),
    };
    if !(1..=maximum_arguments).contains(&plan.argv().len())
        || paths.is_empty()
        || paths.iter().any(|value| {
            value.is_empty()
                || value.contains('\0')
                || value.encode_utf16().count() > MAX_RENDER_ARGUMENT_UTF16
        })
        || plan.argv().iter().any(|argument| {
            argument.contains('\0') || argument.encode_utf16().count() > MAX_RENDER_ARGUMENT_UTF16
        })
    {
        return Err(VideoCommandError::invalid_render_plan("argument_bounds"));
    }
    Ok(())
}

pub(crate) fn expected_duration_microseconds(
    expected: &super::types::RenderExpectation,
) -> Result<u64, VideoCommandError> {
    let numerator = u128::from(expected.duration_frames)
        .checked_mul(u128::from(expected.rate.denominator))
        .and_then(|value| value.checked_mul(1_000_000))
        .ok_or_else(|| VideoCommandError::invalid_render_plan("duration_overflow"))?;
    let denominator = u128::from(expected.rate.numerator);
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;
    quotient
        .checked_add(u128::from(remainder.saturating_mul(2) >= denominator))
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))
        .ok_or_else(|| VideoCommandError::invalid_render_plan("duration_overflow"))
}

fn fixed_six_seconds(microseconds: u64) -> String {
    format!(
        "{}.{:06}",
        microseconds / 1_000_000,
        microseconds % 1_000_000
    )
}

fn fixed_three_opacity(opacity_permille: u64) -> String {
    format!(
        "{}.{:03}",
        opacity_permille / 1_000,
        opacity_permille % 1_000
    )
}

fn fixed_three_signed(value: i64) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let magnitude = value.unsigned_abs();
    format!("{sign}{}.{:03}", magnitude / 1_000, magnitude % 1_000)
}

fn has_default_geometry(input: &super::types::RenderVideoInputV2) -> bool {
    input.position_x_permille == 0
        && input.position_y_permille == 0
        && input.scale_x_permille == 1_000
        && input.scale_y_permille == 1_000
        && input.rotation_milli_degrees == 0
}

fn transformed_video_filter(
    index: usize,
    input: &super::types::RenderVideoInputV2,
    expected: &super::types::RenderExpectation,
    timing_filter: &str,
) -> String {
    let contain = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease:flags=lanczos",
        expected.width, expected.height
    );
    if has_default_geometry(input) {
        return format!(
            "[{index}:v:0]{timing_filter},{contain},format=rgba,colorchannelmixer=aa={},pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black@0,fps={}/{}[v{index}]",
            fixed_three_opacity(input.opacity_permille),
            expected.width,
            expected.height,
            expected.rate.numerator,
            expected.rate.denominator,
        );
    }

    let mut filters = vec![
        timing_filter.to_owned(),
        contain,
        "format=rgba".to_owned(),
        format!(
            "pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black@0",
            expected.width, expected.height
        ),
    ];
    if input.scale_x_permille != 1_000 || input.scale_y_permille != 1_000 {
        filters.push(format!(
            "scale=w='max(1\\,round(iw*{}))':h='max(1\\,round(ih*{}))':flags=lanczos",
            fixed_three_signed(input.scale_x_permille),
            fixed_three_signed(input.scale_y_permille),
        ));
    }
    if input.rotation_milli_degrees != 0 {
        filters.push(format!(
            "rotate=angle={}*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0",
            fixed_three_signed(input.rotation_milli_degrees)
        ));
    }
    filters.extend([
        format!(
            "colorchannelmixer=aa={}",
            fixed_three_opacity(input.opacity_permille)
        ),
        format!(
            "fps={}/{}",
            expected.rate.numerator, expected.rate.denominator
        ),
    ]);
    format!("[{index}:v:0]{}[v{index}]", filters.join(","))
}

fn overlay_coordinate(axis: char, position_permille: i64) -> String {
    let (main_size, overlay_size) = if axis == 'x' {
        ("main_w", "overlay_w")
    } else {
        ("main_h", "overlay_h")
    };
    let centered = format!("({main_size}-{overlay_size})/2");
    if position_permille == 0 {
        return centered;
    }
    let operator = if position_permille < 0 { '-' } else { '+' };
    format!(
        "{centered}{operator}{main_size}*{}",
        fixed_three_signed(position_permille.abs())
    )
}

fn transformed_overlay_filter(input: &super::types::RenderVideoInputV2) -> String {
    if has_default_geometry(input) {
        return "overlay=0:0:format=auto".to_owned();
    }
    format!(
        "overlay=x='{}':y='{}':format=auto",
        overlay_coordinate('x', input.position_x_permille),
        overlay_coordinate('y', input.position_y_permille)
    )
}

fn caption_drawtext_filter(caption: &RenderCaptionInput) -> String {
    super::caption_render::caption_drawtext_filter(caption, fixed_six_seconds)
}

/// Export keyframe spacing: a full frame every 2 seconds, in whole frames at the sequence rate,
/// rounded half up. Must match `keyframeIntervalFrames` in `compile-render-plan.ts` exactly.
const KEYFRAME_INTERVAL_SECONDS: u128 = 2;
fn keyframe_interval_frames(rate: &super::types::RationalRate) -> String {
    let numerator = u128::from(rate.numerator);
    let denominator = u128::from(rate.denominator).max(1);
    let frames = (2 * KEYFRAME_INTERVAL_SECONDS * numerator + denominator) / (2 * denominator);
    frames.max(1).to_string()
}

fn expected_render_arguments_v1(plan: &RenderPlanV1, duration_microseconds: u64) -> Vec<String> {
    let expected = &plan.expected;
    let source_in = plan
        .argv
        .get(10)
        .filter(|value| is_canonical_fixed_six(value))
        .cloned()
        .unwrap_or_default();
    let visibility_filter = if expected.video_hidden {
        ",drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill"
    } else {
        ""
    };
    let mut filter = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease:flags=lanczos,pad={}:{}:(ow-iw)/2:(oh-ih)/2:black{},fps={}/{}",
        expected.width, expected.height, expected.width, expected.height, visibility_filter,
        expected.rate.numerator, expected.rate.denominator
    );
    for caption in &plan.captions {
        filter.push(',');
        filter.push_str(&caption_drawtext_filter(caption));
    }
    let mut arguments = vec![
        "-hide_banner".to_owned(),
        "-nostdin".to_owned(),
        "-loglevel".to_owned(),
        "warning".to_owned(),
        "-progress".to_owned(),
        "pipe:1".to_owned(),
        "-nostats".to_owned(),
        "-i".to_owned(),
        plan.input_path.clone(),
        "-ss".to_owned(),
        source_in,
        "-t".to_owned(),
        fixed_six_seconds(duration_microseconds),
        "-map".to_owned(),
        "0:v:0".to_owned(),
    ];
    if expected.audio {
        arguments.extend(["-map".to_owned(), "0:a:0".to_owned()]);
    } else {
        arguments.push("-an".to_owned());
    }
    arguments.extend([
        "-vf".to_owned(),
        filter,
        "-c:v".to_owned(),
        "libx264".to_owned(),
        "-pix_fmt".to_owned(),
        "yuv420p".to_owned(),
        "-g".to_owned(),
        keyframe_interval_frames(&expected.rate),
    ]);
    if expected.audio {
        arguments.extend([
            "-c:a".to_owned(),
            "aac".to_owned(),
            "-ar".to_owned(),
            "48000".to_owned(),
        ]);
    }
    arguments.extend([
        "-movflags".to_owned(),
        "+faststart".to_owned(),
        plan.output_path.clone(),
    ]);
    arguments
}

fn render_time_microseconds(time: &super::types::RationalTime) -> Result<u64, VideoCommandError> {
    let invalid = || VideoCommandError::invalid_render_plan("clip_timing");
    if time.value > MAX_SAFE_INTEGER || time.rate_numerator == 0 || time.rate_denominator == 0 {
        return Err(invalid());
    }
    let numerator = u128::from(time.value)
        .checked_mul(u128::from(time.rate_denominator))
        .and_then(|value| value.checked_mul(1_000_000))
        .ok_or_else(invalid)?;
    let denominator = u128::from(time.rate_numerator);
    let value = numerator.checked_add(denominator / 2).ok_or_else(invalid)? / denominator;
    if value > u128::from(MAX_SAFE_INTEGER) {
        return Err(invalid());
    }
    Ok(value as u64)
}

fn validated_input_timing(
    input: &super::types::RenderVideoInputV2,
    expected: &super::types::RenderExpectation,
) -> Result<Option<u64>, VideoCommandError> {
    let Some(timing) = &input.timing else {
        return Ok(None);
    };
    let invalid = || VideoCommandError::invalid_render_plan("clip_timing");
    let duration = super::project::clip_timing::clip_timeline_duration(
        &timing.source_in,
        &timing.source_out,
        &expected.rate,
        &timing.speed,
    )
    .map_err(|_| invalid())?;
    if [
        &timing.source_in,
        &timing.source_out,
        &timing.output_duration,
    ]
    .iter()
    .any(|time| {
        time.rate_numerator != expected.rate.numerator
            || time.rate_denominator != expected.rate.denominator
    }) || duration != timing.output_duration
        || duration.value != expected.duration_frames
        || render_time_microseconds(&timing.source_in)? != input.source_in_microseconds
    {
        return Err(invalid());
    }
    let source_duration = super::types::RationalTime {
        value: timing.source_out.value - timing.source_in.value,
        rate_numerator: timing.source_in.rate_numerator,
        rate_denominator: timing.source_in.rate_denominator,
    };
    Ok(Some(render_time_microseconds(&source_duration)?))
}

fn audio_fade_filter(
    input: &super::types::RenderVideoInputV2,
    expected: &super::types::RenderExpectation,
) -> Result<String, VideoCommandError> {
    let invalid = || VideoCommandError::invalid_render_plan("clip_fades");
    let Some(fades) = &input.fades else {
        // An audio end only times a fade-out; without fades it is inconsistent.
        return match input.audio_end_microseconds {
            None => Ok(String::new()),
            Some(_) => Err(invalid()),
        };
    };
    if !fades.valid()
        || fades
            .in_frames
            .checked_add(fades.out_frames)
            .ok_or_else(invalid)?
            > expected.duration_frames
    {
        return Err(invalid());
    }
    let seconds = |frames| -> Result<String, VideoCommandError> {
        let us = render_time_microseconds(&super::types::RationalTime {
            value: frames,
            rate_numerator: expected.rate.numerator,
            rate_denominator: expected.rate.denominator,
        })?;
        if frames > 0 && us == 0 {
            return Err(invalid());
        }
        Ok(fixed_six_seconds(us))
    };
    let mut filter = String::new();
    if fades.in_frames > 0 {
        filter.push_str(&format!(
            ",afade=t=in:st=0.000000:d={}:curve=tri",
            seconds(fades.in_frames)?
        ));
    }
    match input.audio_end_microseconds {
        None if fades.out_frames > 0 => {
            filter.push_str(&format!(
                ",afade=t=out:st={}:d={}:curve=tri",
                seconds(expected.duration_frames - fades.out_frames)?,
                seconds(fades.out_frames)?
            ));
        }
        None => {}
        // The audio stops before the clip: end the fade where the sound ends,
        // shortened only if the audio is shorter than the fade itself.
        Some(audio_end) => {
            let clip_end = render_time_microseconds(&super::types::RationalTime {
                value: expected.duration_frames,
                rate_numerator: expected.rate.numerator,
                rate_denominator: expected.rate.denominator,
            })?;
            if fades.out_frames == 0 || !input.has_audio || audio_end == 0 || audio_end >= clip_end
            {
                return Err(invalid());
            }
            let fade = render_time_microseconds(&super::types::RationalTime {
                value: fades.out_frames,
                rate_numerator: expected.rate.numerator,
                rate_denominator: expected.rate.denominator,
            })?
            .min(audio_end);
            filter.push_str(&format!(
                ",afade=t=out:st={}:d={}:curve=tri",
                fixed_six_seconds(audio_end - fade),
                fixed_six_seconds(fade)
            ));
        }
    }
    Ok(filter)
}

fn expected_v2_filter(
    plan: &RenderPlanV2,
    duration_microseconds: u64,
) -> Result<String, VideoCommandError> {
    let expected = &plan.expected;
    let duration = fixed_six_seconds(duration_microseconds);
    let mut parts = vec![format!(
        "color=c=black:s={}x{}:r={}/{}:d={duration}[base]",
        expected.width, expected.height, expected.rate.numerator, expected.rate.denominator,
    )];
    let mut visible = Vec::new();
    let mut audible = Vec::new();
    for (index, input) in plan.video_inputs.iter().enumerate() {
        let gain = input.gain_milli_decibels.unwrap_or(0);
        if !(-96_000..=24_000).contains(&gain) {
            return Err(VideoCommandError::invalid_render_plan("clip_gain"));
        }
        let gain_filter = if gain == 0 {
            String::new()
        } else {
            let magnitude = gain.abs();
            format!(
                ",volume={}{}.{:03}dB",
                if gain < 0 { "-" } else { "" },
                magnitude / 1_000,
                magnitude % 1_000
            )
        };
        let fade_filter = audio_fade_filter(input, expected)?;
        let source_duration = validated_input_timing(input, expected)?;
        let mut video_timing = "setpts=PTS-STARTPTS".to_owned();
        let mut audio_timing = "asetpts=PTS-STARTPTS".to_owned();
        if let (Some(timing), Some(source_duration)) = (&input.timing, source_duration) {
            // Divide the timebase by the speed numerator first so PTS*d/n stays an exact integer.
            // Otherwise it rounds to the source timebase: at 30000/1001 and 2x, 500.5 ticks per
            // frame round up, and the fps filter keeps source frame 2k+1 instead of 2k.
            video_timing = format!(
                "trim=end_frame={},setpts=PTS-STARTPTS,settb=expr=intb/{n},setpts=PTS*{d}/{n}",
                timing.source_out.value - timing.source_in.value,
                d = timing.speed.denominator,
                n = timing.speed.numerator
            );
            let percent = timing.speed.numerator * 100 / timing.speed.denominator;
            let tempo = format!("{}.{:02}", percent / 100, percent % 100);
            let tempo_filter = if percent < 100 {
                format!("rubberband=tempo={tempo}:window=short:transients=smooth")
            } else {
                format!("atempo={tempo}")
            };
            audio_timing = format!(
                "atrim=duration={},asetpts=PTS-STARTPTS,{tempo_filter},atrim=duration={duration}",
                fixed_six_seconds(source_duration)
            );
        }
        if input.timing.is_none() && !fade_filter.is_empty() {
            audio_timing =
                format!("atrim=duration={duration},asetpts=PTS-STARTPTS,atrim=duration={duration}");
        }
        if !input.hidden {
            parts.push(transformed_video_filter(
                index,
                input,
                expected,
                &video_timing,
            ));
            visible.push(index);
        }
        if !input.muted && input.has_audio {
            parts.push(format!(
                "[{index}:a:0]{audio_timing}{gain_filter}{fade_filter}[a{index}]"
            ));
            audible.push(index);
        }
    }
    let mut base = "base".to_owned();
    for (stack, index) in visible.iter().rev().enumerate() {
        let output = format!("stack{stack}");
        parts.push(format!(
            "[{base}][v{index}]{}[{output}]",
            transformed_overlay_filter(&plan.video_inputs[*index])
        ));
        base = output;
    }
    let graphics = plan.graphics.as_deref().unwrap_or_default();
    for (index, input) in graphics.iter().enumerate() {
        let start = fixed_six_seconds(input.start_microseconds);
        let end = fixed_six_seconds(input.end_microseconds);
        parts.push(format!(
            "[{}:v:0]setpts=PTS-STARTPTS+{start}/TB[g{index}]",
            plan.video_inputs.len() + index
        ));
        parts.push(format!(
            "[{base}][g{index}]overlay=x=0:y=0:eof_action=pass:format=auto:enable='gte(t\\,{start})*lt(t\\,{end})'[gfx{index}]"
        ));
        base = format!("gfx{index}");
    }
    for (index, caption) in plan.captions.iter().enumerate() {
        let output = format!("caption{index}");
        parts.push(format!(
            "[{base}]{}[{output}]",
            caption_drawtext_filter(caption)
        ));
        base = output;
    }
    parts.push(format!("[{base}]null[vout]"));
    debug_assert_eq!(
        audible,
        super::audio_mix::audible_inputs(&plan.video_inputs)
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>()
    );
    if plan.audio_mix.is_some_and(|mix| !mix.valid())
        || (plan.audio_mix.is_some() && audible.is_empty())
    {
        return Err(VideoCommandError::invalid_render_plan("audio_mix"));
    }
    parts.extend(
        super::audio_mix::audio_mix_filters(
            &super::audio_mix::audible_inputs(&plan.video_inputs),
            plan.audio_mix.as_ref(),
            &duration,
        )
        .map_err(VideoCommandError::invalid_render_plan)?,
    );
    Ok(parts.join(";"))
}

pub(crate) const MAX_RENDER_GRAPHICS_INPUTS: usize = 64;
/// Largest graphics canvas side: the renderer's `MAX_CANVAS_SIZE`.
pub(crate) const MAX_GRAPHICS_CANVAS_SIDE: u32 = 4096;
/// Distinct images per graphics clip: the renderer's `MAX_IMAGES` (graphics-renderer
/// `description.rs`), mirrored by TypeScript `MAX_GRAPHICS_IMAGES_PER_CLIP`.
pub(crate) const MAX_GRAPHICS_IMAGES_PER_CLIP: usize = 16;
/// Image file bytes per graphics clip: the renderer's `MAX_TOTAL_IMAGE_BYTES`, mirrored by
/// TypeScript `MAX_GRAPHICS_IMAGE_BYTES_PER_CLIP`.
pub(crate) const MAX_GRAPHICS_IMAGE_BYTES_PER_CLIP: u64 = 40 * 1024 * 1024;

/// Distinct still assets referenced by a clip's image layers.
fn graphics_clip_image_ids(
    clip: &super::project::graphics::GraphicsClip,
) -> std::collections::BTreeSet<&str> {
    clip.layers
        .iter()
        .filter_map(|layer| match layer {
            super::project::graphics::GraphicsLayer::Image { asset_id, .. } => {
                Some(asset_id.as_str())
            }
            _ => None,
        })
        .collect()
}

/// A clip may reference at most `MAX_GRAPHICS_IMAGES_PER_CLIP` distinct images, checked before
/// any overlay renders so the export fails up front instead of mid-render.
fn validate_graphics_image_count(
    clip: &super::project::graphics::GraphicsClip,
) -> Result<(), VideoCommandError> {
    if graphics_clip_image_ids(clip).len() > MAX_GRAPHICS_IMAGES_PER_CLIP {
        return Err(VideoCommandError::invalid_render_plan("graphics_images"));
    }
    Ok(())
}

/// Graphics inputs mirror `renderGraphicsInputV2Schema`: valid clips at the export rate, an output
/// window that matches the clip's own times, and image paths for exactly the image layers.
fn validate_graphics_inputs(
    plan: &RenderPlanV2,
    duration_microseconds: u64,
) -> Result<(), VideoCommandError> {
    let Some(graphics) = &plan.graphics else {
        return Ok(());
    };
    let invalid = || VideoCommandError::invalid_render_plan("graphics_inputs");
    if graphics.is_empty() || graphics.len() > MAX_RENDER_GRAPHICS_INPUTS {
        return Err(invalid());
    }
    let expected = &plan.expected;
    if !expected.width.is_multiple_of(2)
        || !expected.height.is_multiple_of(2)
        || expected.width > u64::from(MAX_GRAPHICS_CANVAS_SIDE)
        || expected.height > u64::from(MAX_GRAPHICS_CANVAS_SIDE)
    {
        return Err(VideoCommandError::invalid_render_plan("graphics_canvas"));
    }
    for input in graphics {
        let clip = &input.clip;
        if !super::project::graphics::valid_graphics_clip_shape(clip)
            || clip.timeline_start.rate_numerator != expected.rate.numerator
            || clip.timeline_start.rate_denominator != expected.rate.denominator
        {
            return Err(invalid());
        }
        let end_frame = clip
            .timeline_end()
            .filter(|end| *end <= MAX_SAFE_INTEGER)
            .ok_or_else(invalid)?;
        let start = render_time_microseconds(&clip.timeline_start).map_err(|_| invalid())?;
        let end = render_time_microseconds(&super::types::RationalTime {
            value: end_frame,
            ..clip.timeline_start.clone()
        })
        .map_err(|_| invalid())?;
        if input.start_microseconds != start
            || input.end_microseconds != end
            || start >= duration_microseconds
        {
            return Err(invalid());
        }
        validate_graphics_image_count(clip)?;
        let referenced = graphics_clip_image_ids(clip);
        let provided: std::collections::BTreeSet<&str> = input
            .image_paths_by_asset_id
            .keys()
            .map(super::types::ProjectUuid::as_str)
            .collect();
        if referenced != provided
            || input.image_paths_by_asset_id.values().any(|path| {
                path.is_empty()
                    || path.contains('\0')
                    || path.encode_utf16().count() > MAX_RENDER_ARGUMENT_UTF16
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn expected_render_arguments_v2(
    plan: &RenderPlanV2,
    duration_microseconds: u64,
) -> Result<Vec<String>, VideoCommandError> {
    let duration = fixed_six_seconds(duration_microseconds);
    let audible = plan
        .video_inputs
        .iter()
        .any(|input| !input.muted && input.has_audio);
    if plan.video_inputs.is_empty()
        || plan.video_inputs.len() > 1_000
        || plan.expected.audio != audible
        || plan.video_inputs.iter().any(|input| {
            input.source_in_microseconds > MAX_SAFE_INTEGER
                || input.opacity_permille > 1_000
                || !(-1_000_000..=1_000_000).contains(&input.position_x_permille)
                || !(-1_000_000..=1_000_000).contains(&input.position_y_permille)
                || !(1..=1_000_000).contains(&input.scale_x_permille)
                || !(1..=1_000_000).contains(&input.scale_y_permille)
                || !(-360_000_000..=360_000_000).contains(&input.rotation_milli_degrees)
                || plan.input_paths_by_asset_id.get(&input.asset_id) != Some(&input.path)
        })
        || plan.input_paths_by_asset_id.iter().any(|(asset_id, path)| {
            !plan
                .video_inputs
                .iter()
                .any(|input| &input.asset_id == asset_id && &input.path == path)
        })
    {
        return Err(VideoCommandError::invalid_render_plan("video_inputs"));
    }

    let mut arguments = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "warning",
        "-progress",
        "pipe:1",
        "-nostats",
    ]
    .map(str::to_owned)
    .to_vec();
    validate_graphics_inputs(plan, duration_microseconds)?;
    for input in &plan.video_inputs {
        arguments.extend([
            "-ss".to_owned(),
            fixed_six_seconds(input.source_in_microseconds),
            "-t".to_owned(),
            fixed_six_seconds(
                validated_input_timing(input, &plan.expected)?.unwrap_or(duration_microseconds),
            ),
            "-i".to_owned(),
            input.path.clone(),
        ]);
    }
    for index in 0..plan.graphics.as_ref().map_or(0, Vec::len) {
        arguments.extend(["-i".to_owned(), graphics_input_sentinel(index)]);
    }
    arguments.extend([
        "-filter_complex".to_owned(),
        expected_v2_filter(plan, duration_microseconds)?,
        "-map".to_owned(),
        "[vout]".to_owned(),
    ]);
    if audible {
        arguments.extend(["-map".to_owned(), "[aout]".to_owned()]);
    } else {
        arguments.push("-an".to_owned());
    }
    arguments.extend([
        "-t".to_owned(),
        duration,
        "-c:v".to_owned(),
        "libx264".to_owned(),
        "-pix_fmt".to_owned(),
        "yuv420p".to_owned(),
        "-g".to_owned(),
        keyframe_interval_frames(&plan.expected.rate),
    ]);
    if audible {
        arguments.extend([
            "-c:a".to_owned(),
            "aac".to_owned(),
            "-ar".to_owned(),
            "48000".to_owned(),
        ]);
    }
    arguments.extend([
        "-movflags".to_owned(),
        "+faststart".to_owned(),
        plan.output_path.clone(),
    ]);
    Ok(arguments)
}

fn is_canonical_fixed_six(value: &str) -> bool {
    let Some((whole, fraction)) = value.split_once('.') else {
        return false;
    };
    !whole.is_empty()
        && (whole == "0" || !whole.starts_with('0'))
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.len() == 6
        && fraction.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn render_execution_arguments(
    validated: &ValidatedRenderPlan,
    partial_path: &Path,
) -> Result<Vec<String>, VideoCommandError> {
    let partial = partial_path
        .to_str()
        .ok_or_else(|| VideoCommandError::invalid_render_plan("partial_path_encoding"))?;
    let mut arguments = validated.plan.argv().to_vec();
    let nostdin_index = arguments
        .iter()
        .position(|argument| argument == "-nostdin")
        .ok_or_else(|| VideoCommandError::invalid_render_plan("argv_grammar"))?;
    arguments.insert(nostdin_index + 1, "-y".to_owned());
    let final_argument = arguments
        .last_mut()
        .ok_or_else(|| VideoCommandError::invalid_render_plan("argv_grammar"))?;
    *final_argument = partial.to_owned();
    Ok(arguments)
}

pub(crate) fn partial_render_path(
    validated: &ValidatedRenderPlan,
) -> Result<PathBuf, VideoCommandError> {
    let parent = validated
        .output_path
        .parent()
        .ok_or_else(|| VideoCommandError::invalid_render_plan("partial_parent"))?;
    let partial = parent.join(format!(
        ".svp-part-{}.mp4",
        validated.plan.plan_id().as_str()
    ));
    if partial.parent() != Some(parent)
        || validated
            .input_paths
            .iter()
            .any(|input| paths_equal(&partial, input))
        || paths_equal(&partial, &validated.output_path)
    {
        return Err(VideoCommandError::invalid_render_plan(
            "partial_containment",
        ));
    }
    Ok(partial)
}

const RENDER_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const RENDER_PROGRESS_RECORD_LIMIT: usize = 64 * 1024;
const RENDER_STDERR_TAIL_LIMIT: usize = 64 * 1024;

pub(crate) struct RenderWorkerRequest {
    pub(crate) validated: ValidatedRenderPlan,
    pub(crate) overwrite: bool,
    pub(crate) app_cache_dir: PathBuf,
    pub(crate) programs: MediaPrograms,
    pub(crate) cancellation: ProcessCancellation,
    pub(crate) identity: RenderEventIdentity,
    pub(crate) events: RenderEventSink,
    /// Test seams for QC failure paths; always default in production.
    pub(crate) hooks: RenderWorkerHooks,
}

/// Deterministic seams for QC failure-path tests. Production uses the default.
#[derive(Clone, Copy, Default)]
pub(crate) struct RenderWorkerHooks {
    pub(crate) manifest_failpoint: Option<super::render_manifest::ManifestFailpoint>,
    pub(crate) qc_timeout: Option<std::time::Duration>,
    pub(crate) before_qc: Option<fn(&ProcessCancellation, &std::path::Path)>,
}

#[cfg(test)]
pub(crate) async fn run_render_worker(request: RenderWorkerRequest) {
    let identity = request.identity.clone();
    let events = request.events.clone();
    let event = match execute_render_worker(&request).await {
        Ok(output) => identity.completed(output),
        Err(error) if error.code == VideoErrorCode::ProcessCancelled => identity.cancelled(),
        Err(error) => identity.failed(error),
    };
    let _ = events(event);
}

/// Renders the plan's graphics overlays into a private scratch directory next to the partial
/// output, under the job's cancellation (ADR 0003).
async fn render_plan_graphics(
    request: &RenderWorkerRequest,
    partial_path: &Path,
) -> Result<super::graphics_export::RenderedGraphics, VideoCommandError> {
    let RenderPlan::V2(plan) = &request.validated.plan else {
        return Ok(super::graphics_export::RenderedGraphics::none());
    };
    let Some(graphics) = plan.graphics.as_deref().filter(|inputs| !inputs.is_empty()) else {
        return Ok(super::graphics_export::RenderedGraphics::none());
    };
    let renderer = request.programs.graphics_renderer("render_graphics")?;
    let ffmpeg = PathBuf::from(request.programs.verified_ffmpeg("render_graphics").await?);
    let scratch_parent = partial_path
        .parent()
        .ok_or_else(|| VideoCommandError::invalid_render_plan("graphics_scratch"))?;
    super::graphics_export::render_export_graphics(
        graphics,
        &plan.expected.rate,
        (plan.expected.width, plan.expected.height),
        &request.validated.graphics_image_paths,
        scratch_parent,
        super::graphics_export::GraphicsPrograms {
            renderer: &renderer,
            ffmpeg: &ffmpeg,
        },
        &request.cancellation,
        &|record| {
            eprintln!(
                "{}",
                serde_json::json!({ "event": "graphics_export_overlay", "record": record })
            );
        },
    )
    .await
}

async fn execute_render_worker(
    request: &RenderWorkerRequest,
) -> Result<VerifiedRenderOutput, VideoCommandError> {
    let partial_path = partial_render_path(&request.validated)?;
    let mut arguments = render_execution_arguments(&request.validated, &partial_path)?;
    // Kept alive until the export finishes: dropping it deletes every rendered overlay.
    let graphics = render_plan_graphics(request, &partial_path).await?;
    super::graphics_export::swap_graphics_sentinels(&mut arguments, &graphics.overlays)?;
    // Two-pass loudness: measure the exact mix first, then substitute the
    // pass-2 node. The report records which mode actually ran.
    let loudness = match request.validated.plan.audio_mix() {
        Some(mix) => {
            let pass = measure_mix_loudness(request, &arguments, &mix).await?;
            arguments = super::audio_mix::with_loudnorm_node(
                &arguments,
                &mix,
                &super::audio_mix::pass_two_loudnorm(&mix, pass.mode, pass.measurement.as_ref()),
            )
            .ok_or_else(|| VideoCommandError::invalid_render_plan("audio_mix"))?;
            Some((mix, pass))
        }
        None => None,
    };
    let partial = create_owned_partial(&partial_path)?;
    let progress = Arc::new(Mutex::new(RenderProgress::new(
        request.validated.duration_microseconds,
    )));
    let progress_for_observer = progress.clone();
    let cancellation_for_observer = request.cancellation.clone();
    let identity_for_observer = request.identity.clone();
    let events_for_observer = request.events.clone();
    let duration_microseconds = request.validated.duration_microseconds;
    let observer: StdoutRecordObserver = Arc::new(move |record| {
        if cancellation_for_observer.is_cancelled() {
            return;
        }
        let completed = progress_for_observer
            .lock()
            .ok()
            .and_then(|mut accumulator| accumulator.ingest_record(record));
        if let Some(completed) = completed {
            let _ = events_for_observer(
                identity_for_observer.progress(completed, duration_microseconds),
            );
        }
    });
    let script = with_filter_script(arguments, "render_video")?;
    let process = ProcessSpec {
        program: request.programs.verified_ffmpeg("render_video").await?,
        args: script.arguments.clone(),
        current_dir: None,
        operation: "render_video",
        timeout: RENDER_TIMEOUT,
        stdout_limit: RENDER_PROGRESS_RECORD_LIMIT,
        stderr_tail_limit: RENDER_STDERR_TAIL_LIMIT,
    };
    run_supervised_streaming(process, request.cancellation.clone(), observer)
        .await
        .map_err(map_render_process_failure)?;
    sync_regular_file(&partial_path, "render_output")?;
    let inspected = probe_trusted_media_with_program(
        &partial_path,
        request.programs.verified_ffprobe("verify_render").await?,
        request.cancellation.clone(),
        "verify_render",
    )
    .await?;
    validate_render_output(&partial_path, &inspected, &request.validated)?;
    let loudness_report = match loudness {
        Some((mix, pass)) => {
            let report = verify_output_loudness(request, &partial_path, &mix, pass).await?;
            if !report.passed {
                return Err(loudness_validation_failed(&report));
            }
            Some(Box::new(report))
        }
        None => None,
    };
    if !request.overwrite && request.validated.output_path.exists() {
        return Err(VideoCommandError::output_exists("promote_render"));
    }
    let verdict = match &request.validated.qc {
        Some(context) => Some(
            super::render_qc::evaluate_render(
                request,
                context,
                &partial_path,
                &inspected,
                loudness_report.as_deref(),
                super::render_qc::now_rfc3339(),
            )
            .await?,
        ),
        None => None,
    };
    let (preview_path, preview_probe) = prepare_render_preview(
        &request.app_cache_dir,
        &request.identity.job_id,
        &partial_path,
        &request.validated,
        &request.programs,
        request.cancellation.clone(),
    )
    .await
    .map_err(map_render_preview_failure)?;
    // The manifest is renamed into place before the output is promoted. If
    // promotion fails or is cancelled, dropping it removes the manifest again.
    // A manifest left without its output (deleted by the user) may be replaced.
    let output_path = &request.validated.output_path;
    let written = match &verdict {
        Some(verdict) => {
            if request.cancellation.is_cancelled() {
                return Err(VideoCommandError::process_cancelled(
                    "qc_analysis",
                    "ffmpeg",
                ));
            }
            let replace = request.overwrite || !output_path.exists();
            Some(write_manifest(
                output_path,
                &verdict.manifest,
                replace,
                request.hooks.manifest_failpoint,
            )?)
        }
        None => None,
    };
    let mut delivery_files = Vec::new();
    if let (Some(verdict), Some(written), Some(context)) =
        (&verdict, &written, &request.validated.qc)
    {
        if let Some(gate) = &context.delivery {
            delivery_files = super::delivery::write_delivery_sidecars(
                &request.programs,
                request.cancellation.clone(),
                &partial_path,
                output_path,
                gate,
                &verdict.manifest,
                &written.sha256,
                super::render_qc::plan_captions(&request.validated.plan),
                request.overwrite,
            )
            .await?;
        }
    }
    promote_render_partial_if_active(
        partial,
        output_path,
        request.overwrite,
        &request.cancellation,
    )?;
    for file in delivery_files {
        file.keep();
    }
    let qc = match (verdict, written) {
        (Some(verdict), Some(written)) => {
            if request.overwrite {
                let _ = supersede_review_record(
                    output_path,
                    u64::try_from(current_timestamp_millis()).unwrap_or_default(),
                );
            }
            let (manifest_path, manifest_sha256) = written.keep();
            Some(Box::new(RenderQcResult {
                status: verdict.manifest.qc.status,
                findings: verdict.findings,
                manifest_path: manifest_path.to_string_lossy().into_owned(),
                manifest_sha256,
            }))
        }
        _ => None,
    };
    Ok(VerifiedRenderOutput {
        output_path: output_path.to_string_lossy().into_owned(),
        preview_path: preview_path.to_string_lossy().into_owned(),
        probe: preview_probe.probe,
        loudness_report,
        qc,
    })
}

struct MixMeasurement {
    mode: super::audio_mix::NormalizationMode,
    reason: Option<&'static str>,
    measurement: Option<super::audio_mix::LoudnormMeasurement>,
    clipped_samples: Option<u64>,
}

/// The validated argv with its `-filter_complex` graph moved into a file.
///
/// Windows caps a whole command line at 32,767 UTF-16 units, and the caption
/// graph grows by about 400 characters per cue, so a five-minute interview
/// already reaches the cap. FFmpeg 5.1+ (bundled: 8.1.2) reads an option's
/// value from a file when the option is written `-/name`, so the graph is
/// passed as `-/filter_complex <file>` instead. The graph itself is unchanged:
/// validation and the loudness rewrite still operate on the in-memory argv.
/// The file lives in a private directory that is deleted when the returned
/// guard drops, after FFmpeg exits.
pub(crate) struct FilterScriptArguments {
    pub(crate) arguments: Vec<OsString>,
    _directory: Option<tempfile::TempDir>,
}

pub(crate) fn with_filter_script(
    arguments: Vec<String>,
    operation: &'static str,
) -> Result<FilterScriptArguments, VideoCommandError> {
    let Some(index) = arguments
        .iter()
        .position(|argument| argument == "-filter_complex")
    else {
        return Ok(FilterScriptArguments {
            arguments: arguments.into_iter().map(OsString::from).collect(),
            _directory: None,
        });
    };
    let graph = arguments
        .get(index + 1)
        .ok_or_else(|| VideoCommandError::invalid_render_plan("argv_grammar"))?;
    let directory = tempfile::Builder::new()
        .prefix("svp-filter-")
        .tempdir()
        .map_err(|_| VideoCommandError::project_io(operation, "filter_script"))?;
    let path = directory.path().join("filter_complex.txt");
    fs::write(&path, graph.as_bytes())
        .map_err(|_| VideoCommandError::project_io(operation, "filter_script"))?;
    let mut next: Vec<OsString> = Vec::with_capacity(arguments.len());
    for (position, argument) in arguments.into_iter().enumerate() {
        next.push(if position == index {
            OsString::from("-/filter_complex")
        } else if position == index + 1 {
            path.clone().into_os_string()
        } else {
            OsString::from(argument)
        });
    }
    Ok(FilterScriptArguments {
        arguments: next,
        _directory: Some(directory),
    })
}

async fn run_audio_analysis(
    request: &RenderWorkerRequest,
    arguments: Vec<String>,
    operation: &'static str,
) -> Result<String, VideoCommandError> {
    let script = with_filter_script(arguments, operation)?;
    let output = super::process::run_supervised(
        ProcessSpec {
            program: request.programs.verified_ffmpeg(operation).await?,
            args: script.arguments.clone(),
            current_dir: None,
            operation,
            timeout: RENDER_TIMEOUT,
            stdout_limit: RENDER_PROGRESS_RECORD_LIMIT,
            stderr_tail_limit: RENDER_STDERR_TAIL_LIMIT,
        },
        request.cancellation.clone(),
    )
    .await
    .map_err(map_render_process_failure)?;
    Ok(String::from_utf8_lossy(&output.stderr_tail).into_owned())
}

async fn measure_mix_loudness(
    request: &RenderWorkerRequest,
    arguments: &[String],
    mix: &super::project::types::SequenceLoudnessTarget,
) -> Result<MixMeasurement, VideoCommandError> {
    let pass_one = super::audio_mix::measurement_arguments(arguments, mix)
        .ok_or_else(|| VideoCommandError::invalid_render_plan("audio_mix"))?;
    let stderr = run_audio_analysis(request, pass_one, "measure_loudness").await?;
    let measurement = super::audio_mix::parse_loudnorm_measurement(&stderr);
    let (mode, reason) = super::audio_mix::normalization_decision(measurement.as_ref(), mix);
    Ok(MixMeasurement {
        mode,
        reason,
        measurement,
        clipped_samples: super::audio_mix::parse_clipped_samples(&stderr),
    })
}

async fn verify_output_loudness(
    request: &RenderWorkerRequest,
    output: &Path,
    mix: &super::project::types::SequenceLoudnessTarget,
    pass: MixMeasurement,
) -> Result<super::audio_mix::LoudnessReport, VideoCommandError> {
    let path = output
        .to_str()
        .ok_or_else(|| VideoCommandError::invalid_render_plan("partial_path_encoding"))?;
    let arguments = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
    ]
    .map(str::to_owned)
    .to_vec();
    let stderr = run_audio_analysis(request, arguments, "verify_loudness").await?;
    let summary = super::audio_mix::parse_ebur128_summary(&stderr);
    Ok(super::audio_mix::build_loudness_report(
        mix,
        pass.mode,
        pass.reason,
        pass.measurement.as_ref(),
        summary.as_ref(),
        pass.clipped_samples,
    ))
}

fn loudness_validation_failed(report: &super::audio_mix::LoudnessReport) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::InvalidMedia,
        "The export did not meet its loudness target",
        serde_json::json!({
            "operation": "verify_loudness",
            "category": "loudness_out_of_tolerance",
            "report": report,
        }),
    )
}

fn remove_owned_render_partial(plan: &RenderPlan) -> Result<(), VideoCommandError> {
    let output_path = Path::new(plan.output_path());
    let parent = output_path
        .parent()
        .ok_or_else(|| VideoCommandError::invalid_render_plan("partial_parent"))?;
    let partial = parent.join(format!(".svp-part-{}.mp4", plan.plan_id().as_str()));
    if partial.parent() != Some(parent) || paths_equal(&partial, output_path) {
        return Err(VideoCommandError::invalid_render_plan(
            "partial_containment",
        ));
    }
    match fs::symlink_metadata(&partial) {
        Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(partial)
            .map_err(|_| VideoCommandError::project_io("reauthorize_render", "partial_cleanup")),
        Ok(_) => Err(VideoCommandError::invalid_render_plan("partial_shape")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(VideoCommandError::project_io(
            "reauthorize_render",
            "partial_cleanup",
        )),
    }
}

pub(crate) fn create_owned_partial(path: &Path) -> Result<TempPath, VideoCommandError> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| VideoCommandError::invalid_render_plan("partial_collision"))?;
    drop(file);
    TempPath::try_from_path(path)
        .map_err(|_| VideoCommandError::invalid_render_plan("partial_ownership"))
}

fn sync_regular_file(path: &Path, operation: &'static str) -> Result<(), VideoCommandError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| VideoCommandError::invalid_media(operation, "metadata"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err(VideoCommandError::invalid_media(operation, "file_shape"));
    }
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| VideoCommandError::invalid_media(operation, "sync"))
}

pub(crate) fn validate_render_output(
    path: &Path,
    inspected: &InspectedMedia,
    validated: &ValidatedRenderPlan,
) -> Result<(), VideoCommandError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| VideoCommandError::invalid_media("verify_render", "metadata"))?;
    let expected = validated.plan.expected();
    let probe = &inspected.probe;
    let valid_audio = match (&probe.audio, expected.audio) {
        (Some(audio), true) => audio.codec_name == "aac" && audio.sample_rate == 48_000,
        (None, false) => true,
        _ => false,
    };
    let valid_duration = duration_within_one_frame(
        validated.duration_microseconds,
        probe.duration_microseconds,
        &expected.rate,
    )
    .unwrap_or(false);
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() != probe.file_size_bytes
        || probe.video_codec_name != "h264"
        || inspected.pixel_format.as_deref() != Some("yuv420p")
        || probe.width != expected.width
        || probe.height != expected.height
        || probe.average_frame_rate != expected.rate
        || probe.real_frame_rate != expected.rate
        || probe.variable_frame_rate
        || !valid_audio
        || !valid_duration
    {
        return Err(VideoCommandError::invalid_media(
            "verify_render",
            "unexpected_output_shape",
        ));
    }
    Ok(())
}

pub(crate) fn promote_render_partial(
    partial: TempPath,
    destination: &Path,
    overwrite: bool,
) -> Result<(), VideoCommandError> {
    if overwrite {
        partial
            .persist(destination)
            .map_err(|_| VideoCommandError::invalid_media("promote_render", "persist"))?;
    } else {
        partial.persist_noclobber(destination).map_err(|error| {
            if error.error.kind() == io::ErrorKind::AlreadyExists {
                VideoCommandError::output_exists("promote_render")
            } else {
                VideoCommandError::invalid_media("promote_render", "persist")
            }
        })?;
    }
    Ok(())
}

pub(crate) fn promote_render_partial_if_active(
    partial: TempPath,
    destination: &Path,
    overwrite: bool,
    cancellation: &ProcessCancellation,
) -> Result<(), VideoCommandError> {
    promote_render_partial_if_active_with_hook(partial, destination, overwrite, cancellation, || {})
}

pub(crate) fn promote_render_partial_if_active_with_hook(
    partial: TempPath,
    destination: &Path,
    overwrite: bool,
    cancellation: &ProcessCancellation,
    inside_boundary: impl FnOnce(),
) -> Result<(), VideoCommandError> {
    let committed = cancellation.commit_if_active(|| {
        inside_boundary();
        promote_render_partial(partial, destination, overwrite)
    })?;
    if committed.is_none() {
        return Err(VideoCommandError::process_cancelled(
            "publish_render",
            "ffmpeg",
        ));
    }
    Ok(())
}

pub(crate) fn map_render_preview_failure(error: VideoCommandError) -> VideoCommandError {
    if matches!(
        error.code,
        VideoErrorCode::ToolUnavailable | VideoErrorCode::ProcessCancelled
    ) {
        error
    } else {
        VideoCommandError::preview_preparation_failed("copy_or_verify")
    }
}

async fn prepare_render_preview(
    app_cache_dir: &Path,
    job_id: &str,
    output_path: &Path,
    validated: &ValidatedRenderPlan,
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
) -> Result<(PathBuf, InspectedMedia), VideoCommandError> {
    let preview_directory = ensure_preview_directory(app_cache_dir, job_id)?;
    let preview_path = preview_directory.join("preview.mp4");
    let temporary = TempFileBuilder::new()
        .prefix(".preview-")
        .suffix(".mp4")
        .tempfile_in(&preview_directory)
        .map_err(|_| VideoCommandError::preview_preparation_failed("temporary"))?;
    fs::copy(output_path, temporary.path())
        .map_err(|_| VideoCommandError::preview_preparation_failed("copy"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| VideoCommandError::preview_preparation_failed("sync"))?;
    let temporary_path = temporary.into_temp_path();
    let inspected = probe_trusted_media_with_program(
        &temporary_path,
        programs.verified_ffprobe("verify_render_preview").await?,
        cancellation,
        "verify_render_preview",
    )
    .await?;
    validate_render_output(&temporary_path, &inspected, validated)?;
    temporary_path
        .persist(&preview_path)
        .map_err(|_| VideoCommandError::preview_preparation_failed("persist"))?;
    Ok((preview_path, inspected))
}

pub(crate) fn ensure_preview_directory(
    app_cache_dir: &Path,
    job_id: &str,
) -> Result<PathBuf, VideoCommandError> {
    if job_id.contains(['/', '\\']) || job_id.is_empty() || matches!(job_id, "." | "..") {
        return Err(VideoCommandError::invalid_render_plan("preview_job_id"));
    }
    ensure_directory_without_symlink(app_cache_dir)?;
    let store_directory = app_cache_dir.join(MEDIA_STORE_NAMESPACE);
    ensure_directory_without_symlink(&store_directory)?;
    // Final previews must stay inside the existing asset-protocol derived-cache scope.
    let derived_directory = store_directory.join("derived");
    ensure_directory_without_symlink(&derived_directory)?;
    let render_directory = derived_directory.join("render-preview");
    ensure_directory_without_symlink(&render_directory)?;
    let job_directory = render_directory.join(job_id);
    ensure_directory_without_symlink(&job_directory)?;
    if !job_directory.starts_with(&derived_directory) {
        return Err(VideoCommandError::invalid_render_plan(
            "preview_containment",
        ));
    }
    Ok(job_directory)
}

fn ensure_directory_without_symlink(path: &Path) -> Result<(), VideoCommandError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            Ok(())
        }
        Ok(_) => Err(VideoCommandError::preview_preparation_failed(
            "directory_shape",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(path)
                .map_err(|_| VideoCommandError::preview_preparation_failed("create_directory"))?;
            let metadata = fs::symlink_metadata(path)
                .map_err(|_| VideoCommandError::preview_preparation_failed("directory_metadata"))?;
            if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err(VideoCommandError::preview_preparation_failed(
                    "directory_shape",
                ))
            }
        }
        Err(_) => Err(VideoCommandError::preview_preparation_failed(
            "directory_metadata",
        )),
    }
}

fn map_render_process_failure(failure: ProcessFailure) -> VideoCommandError {
    let operation = failure.operation();
    match failure {
        ProcessFailure::Spawn {
            kind: io::ErrorKind::NotFound,
            ..
        } => VideoCommandError::tool_unavailable(operation, "ffmpeg"),
        ProcessFailure::Timeout { .. } => VideoCommandError::process_timeout(operation, "ffmpeg"),
        ProcessFailure::Cancelled { .. } => {
            VideoCommandError::process_cancelled(operation, "ffmpeg")
        }
        ProcessFailure::StdoutLimit { limit, .. } => {
            VideoCommandError::process_output_limit(operation, "ffmpeg", limit)
        }
        ProcessFailure::NonZero {
            exit_code,
            stderr_tail,
            stderr_truncated,
            ..
        } => {
            let _ = (stderr_tail, stderr_truncated);
            VideoCommandError::process_failed(operation, "ffmpeg", exit_code)
        }
        ProcessFailure::Spawn { .. } | ProcessFailure::Io { .. } => {
            VideoCommandError::process_failed(operation, "ffmpeg", None)
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RenderProgress {
    duration_microseconds: u64,
    completed_microseconds: u64,
}

impl RenderProgress {
    pub(crate) fn new(duration_microseconds: u64) -> Self {
        Self {
            duration_microseconds,
            completed_microseconds: 0,
        }
    }

    pub(crate) fn ingest_record(&mut self, record: &[u8]) -> Option<u64> {
        let text = std::str::from_utf8(record).ok()?;
        let mut out_time_us = None;
        let mut out_time_ms = None;
        let mut ended = false;
        for raw_line in text.lines() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            match key {
                "out_time_us" => out_time_us = parse_non_negative_decimal(value),
                "out_time_ms" => out_time_ms = parse_non_negative_decimal(value),
                "progress" if value == "end" => ended = true,
                _ => {}
            }
        }
        let candidate = if ended {
            self.duration_microseconds
        } else {
            out_time_us
                .or(out_time_ms)
                .unwrap_or(self.completed_microseconds)
                .min(self.duration_microseconds)
        };
        if candidate <= self.completed_microseconds {
            return None;
        }
        self.completed_microseconds = candidate;
        Some(candidate)
    }
}

fn parse_non_negative_decimal(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn greatest_common_divisor(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

#[cfg(test)]
mod graphics_limit_tests {
    use super::{validate_graphics_image_count, MAX_GRAPHICS_IMAGES_PER_CLIP};

    fn clip_with_images(count: usize) -> crate::video::project::graphics::GraphicsClip {
        let hold = |value: f64| serde_json::json!([{ "timeMicroseconds": 0, "value": value }]);
        let time = |value: u64| serde_json::json!({ "value": value, "rateNumerator": 30, "rateDenominator": 1 });
        let layers: Vec<_> = (0..count)
            .map(|index| {
                serde_json::json!({
                    "kind": "image", "assetId": format!("7f000000-0000-4000-8000-{index:012x}"),
                    "width": 64, "height": 64, "x": hold(0.0), "y": hold(0.0),
                    "scale": hold(1.0), "rotation": hold(0.0), "opacity": hold(1.0)
                })
            })
            .collect();
        serde_json::from_value(serde_json::json!({
            "graphicsVersion": 1, "id": "7f000000-0000-4000-8000-0000000000c1",
            "timelineStart": time(0), "duration": time(30), "fontKey": "arial-bold",
            "layers": layers
        }))
        .unwrap()
    }

    #[test]
    fn render_plan_rejects_a_graphics_clip_with_more_images_than_the_renderer_embeds() {
        assert!(
            validate_graphics_image_count(&clip_with_images(MAX_GRAPHICS_IMAGES_PER_CLIP)).is_ok()
        );
        let error =
            validate_graphics_image_count(&clip_with_images(MAX_GRAPHICS_IMAGES_PER_CLIP + 1))
                .unwrap_err();
        assert_eq!(error.details["category"], "graphics_images");
    }
}

#[cfg(test)]
mod filter_script_tests {
    use super::with_filter_script;
    use std::ffi::OsString;

    #[test]
    fn filter_graph_moves_to_a_file_and_the_file_is_removed_after_use() {
        let arguments = vec![
            "-i".to_owned(),
            "in.mp4".to_owned(),
            "-filter_complex".to_owned(),
            "[0:v]null[vout]".to_owned(),
            "-map".to_owned(),
            "[vout]".to_owned(),
        ];
        let script = with_filter_script(arguments, "render_video").unwrap();
        assert_eq!(script.arguments[2], OsString::from("-/filter_complex"));
        let path = std::path::PathBuf::from(&script.arguments[3]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[0:v]null[vout]");
        assert_eq!(
            script.arguments[4..],
            [OsString::from("-map"), OsString::from("[vout]")]
        );
        drop(script);
        assert!(!path.exists(), "the filter file is deleted with its guard");

        let plain = with_filter_script(vec!["-version".to_owned()], "probe").unwrap();
        assert_eq!(plain.arguments, [OsString::from("-version")]);
        assert!(with_filter_script(vec!["-filter_complex".to_owned()], "render_video").is_err());
    }

    /// A caption graph longer than the Windows command-line cap (32,767) runs
    /// through the bundled FFmpeg because it is passed as a file.
    #[test]
    fn bundled_ffmpeg_accepts_a_filter_graph_longer_than_the_command_line_cap() {
        let ffmpeg = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe");
        if !ffmpeg.is_file() {
            eprintln!("skipping: bundled FFmpeg unavailable");
            return;
        }
        let mut graph = "[0:v]null".to_owned();
        while graph.len() <= 40_000 {
            graph.push_str(",null");
        }
        graph.push_str("[vout]");
        let arguments = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=s=64x64:d=0.1",
            "-filter_complex",
            &graph,
            "-map",
            "[vout]",
            "-frames:v",
            "1",
            "-f",
            "null",
            "-",
        ]
        .map(str::to_owned)
        .to_vec();
        let script = with_filter_script(arguments, "render_video").unwrap();
        let output = std::process::Command::new(&ffmpeg)
            .args(&script.arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
