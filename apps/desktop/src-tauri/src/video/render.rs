use std::{
    collections::{HashMap, VecDeque},
    ffi::OsString,
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::Value;
use tauri::{Emitter, Manager, Runtime, State, WebviewWindow};
use tempfile::{Builder as TempFileBuilder, TempPath};

use super::{
    derived::{duration_within_one_frame, MediaPrograms},
    error::{VideoCommandError, VideoErrorCode},
    grants::{GrantCategory, VideoPathGrants},
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

const SETTLED_TOMBSTONE_LIMIT: usize = 256;

#[derive(Debug, Clone)]
struct ActiveRenderJob {
    owner_label: String,
    plan_id: String,
    revision_id: String,
    destination: PathBuf,
    cancellation: ProcessCancellation,
    committed: bool,
}

#[derive(Debug, Clone)]
struct SettledRenderJob {
    owner_label: String,
    job_id: String,
}

#[derive(Debug, Default)]
struct RenderJobsInner {
    active: HashMap<String, ActiveRenderJob>,
    settled: VecDeque<SettledRenderJob>,
}

#[derive(Debug, Clone)]
pub struct VideoRenderJobs {
    inner: Arc<Mutex<RenderJobsInner>>,
    tombstone_limit: usize,
}

impl Default for VideoRenderJobs {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RenderJobsInner::default())),
            tombstone_limit: SETTLED_TOMBSTONE_LIMIT,
        }
    }
}

impl VideoRenderJobs {
    pub(crate) fn register(
        &self,
        owner_label: &str,
        validated: &ValidatedRenderPlan,
    ) -> Result<(RenderEventIdentity, ProcessCancellation), VideoCommandError> {
        let job_id = validated.plan.plan_id.as_str().to_owned();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VideoCommandError::invalid_render_plan("job_registry"))?;
        if inner.active.contains_key(&job_id)
            || inner.settled.iter().any(|entry| entry.job_id == job_id)
            || inner
                .active
                .values()
                .any(|entry| paths_equal(&entry.destination, &validated.output_path))
        {
            return Err(VideoCommandError::invalid_render_plan("job_conflict"));
        }
        let cancellation = ProcessCancellation::new();
        let identity = RenderEventIdentity {
            job_id: job_id.clone(),
            plan_id: job_id.clone(),
            revision_id: validated.plan.revision_id.as_str().to_owned(),
        };
        inner.active.insert(
            job_id,
            ActiveRenderJob {
                owner_label: owner_label.to_owned(),
                plan_id: identity.plan_id.clone(),
                revision_id: identity.revision_id.clone(),
                destination: validated.output_path.clone(),
                cancellation: cancellation.clone(),
                committed: false,
            },
        );
        Ok((identity, cancellation))
    }

    pub(crate) fn cancel(&self, owner_label: &str, job_id: &str) -> Result<(), VideoCommandError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| VideoCommandError::invalid_render_plan("job_registry"))?;
        if let Some(active) = inner.active.get(job_id) {
            if active.owner_label != owner_label {
                return Err(VideoCommandError::invalid_render_plan("unknown_job"));
            }
            active.cancellation.cancel();
            return Ok(());
        }
        if inner
            .settled
            .iter()
            .any(|entry| entry.job_id == job_id && entry.owner_label == owner_label)
        {
            return Ok(());
        }
        Err(VideoCommandError::invalid_render_plan("unknown_job"))
    }

    pub(crate) fn cancel_owner(&self, owner_label: &str) -> Result<(), VideoCommandError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| VideoCommandError::invalid_render_plan("job_registry"))?;
        for active in inner
            .active
            .values()
            .filter(|active| active.owner_label == owner_label)
        {
            active.cancellation.cancel();
        }
        Ok(())
    }

    pub(crate) fn cancel_all(&self) -> Result<(), VideoCommandError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| VideoCommandError::invalid_render_plan("job_registry"))?;
        for active in inner.active.values() {
            active.cancellation.cancel();
        }
        Ok(())
    }

    pub(crate) fn is_active(&self, job_id: &str) -> bool {
        self.inner
            .lock()
            .is_ok_and(|inner| inner.active.contains_key(job_id))
    }

    pub(crate) fn mark_committed(&self, job_id: &str) -> Result<bool, VideoCommandError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VideoCommandError::invalid_render_plan("job_registry"))?;
        let Some(active) = inner.active.get_mut(job_id) else {
            return Ok(false);
        };
        active.committed = true;
        Ok(true)
    }

    pub(crate) fn settle(&self, job_id: &str) -> Result<bool, VideoCommandError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VideoCommandError::invalid_render_plan("job_registry"))?;
        let Some(active) = inner.active.remove(job_id) else {
            return Ok(false);
        };
        let _ = (active.plan_id, active.revision_id, active.committed);
        inner.settled.push_back(SettledRenderJob {
            owner_label: active.owner_label,
            job_id: job_id.to_owned(),
        });
        while inner.settled.len() > self.tombstone_limit {
            inner.settled.pop_front();
        }
        Ok(true)
    }

    #[cfg(test)]
    pub(crate) fn with_tombstone_limit(tombstone_limit: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RenderJobsInner::default())),
            tombstone_limit,
        }
    }

    #[cfg(test)]
    pub(crate) fn tombstone_count(&self) -> usize {
        self.inner.lock().map_or(0, |inner| inner.settled.len())
    }

    #[cfg(all(test, feature = "tauri-ipc-test"))]
    pub(crate) fn cancellation_requested(&self, job_id: &str) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| {
                inner
                    .active
                    .get(job_id)
                    .map(|active| active.cancellation.is_cancelled())
            })
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ValidatedRenderPlan {
    pub(crate) plan: RenderPlanV1,
    pub(crate) input_path: PathBuf,
    pub(crate) output_path: PathBuf,
    pub(crate) duration_microseconds: u64,
}

#[tauri::command]
pub async fn video_start_render<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    jobs: State<'_, VideoRenderJobs>,
    toolchain: State<'_, MediaToolchainState>,
    plan: Value,
    overwrite: bool,
) -> Result<VideoRenderStarted, VideoCommandError> {
    let app_cache_dir = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| VideoCommandError::project_io("start_render", "app_cache"))?;
    let validated = parse_and_validate_render_plan(plan, window.label(), &grants)?;
    if !overwrite && validated.output_path.exists() {
        return Err(VideoCommandError::output_exists("start_render"));
    }
    toolchain
        .verified_programs()
        .await
        .map_err(|error| error.into_command_error("start_render"))?;
    let programs = MediaPrograms::bundled(toolchain.inner().clone());
    let (identity, cancellation) = jobs.register(window.label(), &validated)?;
    let response = VideoRenderStarted {
        job_id: identity.job_id.clone(),
        plan_id: identity.plan_id.clone(),
        revision_id: identity.revision_id.clone(),
    };
    let event_window = window.clone();
    let events: RenderEventSink = Arc::new(move |event| {
        event_window
            .emit(VIDEO_RENDER_EVENT, event)
            .map_err(|_| VideoCommandError::project_io("emit_render_event", "owner_window"))
    });
    let _ = events(identity.started());
    tauri::async_runtime::spawn(run_render_worker(RenderWorkerRequest {
        validated,
        overwrite,
        app_cache_dir,
        programs,
        cancellation,
        identity,
        jobs: jobs.inner().clone(),
        events,
    }));
    Ok(response)
}

#[tauri::command]
pub fn video_cancel_render<R: Runtime>(
    window: WebviewWindow<R>,
    jobs: State<'_, VideoRenderJobs>,
    job_id: String,
) -> Result<(), VideoCommandError> {
    jobs.cancel(window.label(), &job_id)
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
    pub(crate) jobs: VideoRenderJobs,
    pub(crate) events: RenderEventSink,
}

pub(crate) async fn run_render_worker(request: RenderWorkerRequest) {
    let identity = request.identity.clone();
    let jobs = request.jobs.clone();
    let events = request.events.clone();
    let result = execute_render_worker(&request).await;
    if jobs.settle(&identity.job_id).ok() != Some(true) {
        return;
    }
    let event = match result {
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
    let jobs_for_observer = request.jobs.clone();
    let cancellation_for_observer = request.cancellation.clone();
    let identity_for_observer = request.identity.clone();
    let events_for_observer = request.events.clone();
    let duration_microseconds = request.validated.duration_microseconds;
    let observer: StdoutRecordObserver = Arc::new(move |record| {
        if cancellation_for_observer.is_cancelled()
            || !jobs_for_observer.is_active(&identity_for_observer.job_id)
        {
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
    request.jobs.mark_committed(&request.identity.job_id)?;

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
