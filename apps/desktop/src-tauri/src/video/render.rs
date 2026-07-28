use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, Runtime, State, WebviewWindow};
use tempfile::{Builder as TempFileBuilder, TempPath};

use super::{
    derived::{duration_within_one_frame, MediaPrograms},
    error::{VideoCommandError, VideoErrorCode},
    grants::{GrantCategory, VideoPathGrants},
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
    probe::{probe_trusted_media_with_program, InspectedMedia},
    process::{
        run_supervised_streaming, ProcessCancellation, ProcessFailure, ProcessSpec,
        StdoutRecordObserver,
    },
    toolchain::MediaToolchainState,
    types::{
        RenderPlanV1, VerifiedRenderOutput, VideoRenderEvent, VideoRenderStarted, MAX_SAFE_INTEGER,
    },
};

pub const VIDEO_RENDER_EVENT: &str = "video:render-event";
const MAX_RENDER_ARGUMENTS: usize = 128;
const MAX_RENDER_ARGUMENT_UTF16: usize = 32_768;

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
    pub(crate) plan: RenderPlanV1,
    pub(crate) input_path: PathBuf,
    pub(crate) output_path: PathBuf,
    pub(crate) duration_microseconds: u64,
}

#[derive(Default)]
struct RenderCompatibilityLifecycle {
    pending_terminal: Option<VideoRenderEvent>,
    emitted: bool,
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
pub async fn video_start_render<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    jobs: State<'_, MediaJobService>,
    toolchain: State<'_, MediaToolchainState>,
    plan: Value,
    overwrite: bool,
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
    start_render_with_context(
        window.label(),
        &grants,
        &jobs,
        programs,
        app_cache_dir,
        plan,
        overwrite,
        events,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_render_with_context(
    owner_label: &str,
    grants: &VideoPathGrants,
    jobs: &MediaJobService,
    programs: MediaPrograms,
    app_cache_dir: PathBuf,
    plan: Value,
    overwrite: bool,
    events: RenderEventSink,
) -> Result<VideoRenderStarted, VideoCommandError> {
    let validated = parse_and_validate_render_plan(plan, owner_label, grants)?;
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
            revision_id: Some(validated.plan.revision_id.as_str().to_owned()),
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
            }),
            created_at_ms: current_timestamp_millis(),
        })
        .await
        .map_err(map_render_job_store_error)?;
    let identity = RenderEventIdentity {
        job_id: enqueued.job.id.clone(),
        plan_id: validated.plan.plan_id.as_str().to_owned(),
        revision_id: validated.plan.revision_id.as_str().to_owned(),
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

pub(crate) fn parse_and_validate_render_plan(
    value: Value,
    owner_label: &str,
    grants: &VideoPathGrants,
) -> Result<ValidatedRenderPlan, VideoCommandError> {
    let plan: RenderPlanV1 = serde_json::from_value(value)
        .map_err(|_| VideoCommandError::invalid_render_plan("schema"))?;
    validate_render_plan(plan, owner_label, grants)
}

pub(crate) fn validate_render_plan(
    plan: RenderPlanV1,
    owner_label: &str,
    grants: &VideoPathGrants,
) -> Result<ValidatedRenderPlan, VideoCommandError> {
    if plan.schema_version != 1 {
        return Err(VideoCommandError::invalid_render_plan("schema_version"));
    }
    if plan.executable != "ffmpeg" {
        return Err(VideoCommandError::invalid_render_plan("executable"));
    }
    validate_expectation(&plan)?;
    validate_argument_text(&plan)?;

    let requested_input = Path::new(&plan.input_path);
    let requested_output = Path::new(&plan.output_path);
    let input_path = grants
        .authorize(owner_label, GrantCategory::Source, requested_input)
        .map_err(|_| VideoCommandError::invalid_render_plan("input_grant"))?;
    let output_path = grants
        .authorize(owner_label, GrantCategory::Output, requested_output)
        .map_err(|_| VideoCommandError::invalid_render_plan("output_grant"))?;
    if paths_equal(&input_path, &output_path) {
        return Err(VideoCommandError::invalid_render_plan("path_alias"));
    }
    if input_path.to_string_lossy() != plan.input_path
        || output_path.to_string_lossy() != plan.output_path
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

    if plan
        .argv
        .get(10)
        .is_none_or(|value| !is_canonical_fixed_six(value))
    {
        return Err(VideoCommandError::invalid_render_plan("source_time"));
    }
    let duration_microseconds = expected_duration_microseconds(&plan)?;
    let expected_arguments = expected_render_arguments(&plan, duration_microseconds);
    if plan.argv != expected_arguments {
        return Err(VideoCommandError::invalid_render_plan("argv_grammar"));
    }

    Ok(ValidatedRenderPlan {
        plan,
        input_path,
        output_path,
        duration_microseconds,
    })
}

fn validate_expectation(plan: &RenderPlanV1) -> Result<(), VideoCommandError> {
    let expected = &plan.expected;
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

fn validate_argument_text(plan: &RenderPlanV1) -> Result<(), VideoCommandError> {
    if !(1..=MAX_RENDER_ARGUMENTS).contains(&plan.argv.len())
        || plan.input_path.is_empty()
        || plan.output_path.is_empty()
        || [plan.input_path.as_str(), plan.output_path.as_str()]
            .into_iter()
            .any(|value| {
                value.contains('\0') || value.encode_utf16().count() > MAX_RENDER_ARGUMENT_UTF16
            })
        || plan.argv.iter().any(|argument| {
            argument.contains('\0') || argument.encode_utf16().count() > MAX_RENDER_ARGUMENT_UTF16
        })
    {
        return Err(VideoCommandError::invalid_render_plan("argument_bounds"));
    }
    Ok(())
}

pub(crate) fn expected_duration_microseconds(
    plan: &RenderPlanV1,
) -> Result<u64, VideoCommandError> {
    let numerator = u128::from(plan.expected.duration_frames)
        .checked_mul(u128::from(plan.expected.rate.denominator))
        .and_then(|value| value.checked_mul(1_000_000))
        .ok_or_else(|| VideoCommandError::invalid_render_plan("duration_overflow"))?;
    let denominator = u128::from(plan.expected.rate.numerator);
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;
    let rounded = quotient
        .checked_add(u128::from(remainder.saturating_mul(2) >= denominator))
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))
        .ok_or_else(|| VideoCommandError::invalid_render_plan("duration_overflow"))?;
    Ok(rounded)
}

fn fixed_six_seconds(microseconds: u64) -> String {
    format!(
        "{}.{:06}",
        microseconds / 1_000_000,
        microseconds % 1_000_000
    )
}

fn expected_render_arguments(plan: &RenderPlanV1, duration_microseconds: u64) -> Vec<String> {
    let expected = &plan.expected;
    let source_in = plan
        .argv
        .get(10)
        .filter(|value| is_canonical_fixed_six(value))
        .cloned()
        .unwrap_or_default();
    let filter = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease:flags=lanczos,pad={}:{}:(ow-iw)/2:(oh-ih)/2:black,fps={}/{}",
        expected.width,
        expected.height,
        expected.width,
        expected.height,
        expected.rate.numerator,
        expected.rate.denominator
    );
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
    let mut arguments = validated.plan.argv.clone();
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
    let partial = parent.join(format!(".svp-part-{}.mp4", validated.plan.plan_id.as_str()));
    if partial.parent() != Some(parent)
        || paths_equal(&partial, &validated.input_path)
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

async fn execute_render_worker(
    request: &RenderWorkerRequest,
) -> Result<VerifiedRenderOutput, VideoCommandError> {
    let partial_path = partial_render_path(&request.validated)?;
    let partial = create_owned_partial(&partial_path)?;
    let arguments = render_execution_arguments(&request.validated, &partial_path)?;
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
    let process = ProcessSpec {
        program: request.programs.verified_ffmpeg("render_video").await?,
        args: arguments.into_iter().map(OsString::from).collect(),
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
    promote_render_partial(partial, &request.validated.output_path, request.overwrite)?;

    let preview_result = prepare_render_preview(
        &request.app_cache_dir,
        &request.identity.job_id,
        &request.validated.output_path,
        &request.validated,
        &request.programs,
    )
    .await;
    let (preview_path, preview_probe) = preview_result.map_err(map_render_preview_failure)?;
    Ok(VerifiedRenderOutput {
        output_path: request.validated.output_path.to_string_lossy().into_owned(),
        preview_path: preview_path.to_string_lossy().into_owned(),
        probe: preview_probe.probe,
    })
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
    let expected = &validated.plan.expected;
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

pub(crate) fn map_render_preview_failure(error: VideoCommandError) -> VideoCommandError {
    if error.code == VideoErrorCode::ToolUnavailable {
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
        ProcessCancellation::new(),
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
    if job_id.contains(['/', '\\']) || job_id.is_empty() {
        return Err(VideoCommandError::invalid_render_plan("preview_job_id"));
    }
    ensure_directory_without_symlink(app_cache_dir)?;
    let phase_directory = app_cache_dir.join("video-phase1");
    ensure_directory_without_symlink(&phase_directory)?;
    let render_directory = phase_directory.join("render-preview");
    ensure_directory_without_symlink(&render_directory)?;
    let job_directory = render_directory.join(job_id);
    ensure_directory_without_symlink(&job_directory)?;
    if !job_directory.starts_with(app_cache_dir) {
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
