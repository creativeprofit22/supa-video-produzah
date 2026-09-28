//! Production transcription: durable GPU job wiring around the NeMo runner.
//!
//! Flow: readiness (pinned runtime folder + consent) → authorized source ingest
//! and probe → durable `transcription` job on the single GPU slot → FFmpeg audio
//! extraction + NeMo CUDA run → provider-neutral transcript artifact in the
//! managed cache. The job result is only the artifact key; the frontend loads
//! it through the existing exact-key transcript read.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    asr_runtime::{
        nemo_asr_configuration, pinned_manifest, pinned_manifest_sha256, verify_runtime_folder,
        NemoRuntimeManifest, NemoRuntimeProblem,
    },
    asr_settings::{load_settings, save_settings, AsrConsentRecordV1, AsrConsentState},
    cache::{CacheArtifactKind, CacheArtifactRegistration, MediaCacheService},
    derived::{validated_uuid_segment, MediaPrograms},
    error::{VideoCommandError, VideoErrorCode},
    grants::VideoPathGrants,
    jobs::{
        current_timestamp_millis,
        model::{
            MediaJobError, MediaJobErrorCategory, MediaJobKind, MediaJobPriority, MediaJobProgress,
            MediaJobProgressUnit, MediaJobRecoveryAction, MediaJobState, MAX_PUBLIC_JOBS,
        },
        scheduler::{MediaJobWorker, MediaWorkerFuture, MediaWorkerOutcome, SchedulerResource},
        store::{parse_timestamp_millis, MediaJobStore, MediaStateStoreError, NewMediaJob},
        MediaJobService,
    },
    media_store::{ingest_source_guarded, IngestedSource},
    nemo_transcription::{
        transcribe_nemo_cuda, NemoTranscriptionInput, TranscriptionProgress, VerifiedNemoRuntime,
    },
    probe::probe_trusted_media_with_program,
    process::ProcessCancellation,
    transcript::AsrConfigurationV1,
};

const OPERATION: &str = "start_transcription";
/// First attempt plus exactly one automatic retry for a crash or timeout.
pub(crate) const TRANSCRIPTION_MAX_ATTEMPTS: u8 = 2;

// ---------------------------------------------------------------------------
// Readiness: runtime folder + consent
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsrRuntimeStatus {
    pub(crate) runtime_folder: Option<String>,
    pub(crate) runtime: AsrRuntimeAvailability,
    pub(crate) consent: AsrConsentState,
    pub(crate) manifest_sha256: String,
    pub(crate) license: AsrLicenseSummary,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub(crate) enum AsrRuntimeAvailability {
    NotConfigured,
    Ready,
    Unavailable { problem: NemoRuntimeProblem },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsrLicenseSummary {
    pub(crate) model_id: String,
    pub(crate) model_revision: String,
    pub(crate) model_license_spdx: String,
    pub(crate) model_license_url: String,
    pub(crate) model_attribution: String,
    pub(crate) runtime_license_spdx: String,
    pub(crate) runtime_license_url: String,
    pub(crate) runtime_attribution: String,
    pub(crate) commercial_use: bool,
    pub(crate) device: String,
}

fn license_summary(manifest: &NemoRuntimeManifest) -> AsrLicenseSummary {
    AsrLicenseSummary {
        model_id: manifest
            .model
            .repository
            .trim_start_matches("https://huggingface.co/")
            .to_owned(),
        model_revision: manifest.model.revision.clone(),
        model_license_spdx: manifest.model.license.spdx.clone(),
        model_license_url: manifest.model.license.url.clone(),
        model_attribution: manifest.model.license.attribution.clone(),
        runtime_license_spdx: manifest.runtime.license.spdx.clone(),
        runtime_license_url: manifest.runtime.license.url.clone(),
        runtime_attribution: manifest.runtime.license.attribution.clone(),
        commercial_use: manifest.model.license.commercial_use
            && manifest.runtime.license.commercial_use,
        device: manifest.device.clone(),
    }
}

/// Reports runtime availability and consent. Hashes the whole runtime, so it
/// runs on a blocking thread.
pub(crate) async fn asr_runtime_status(
    config_dir: &Path,
) -> Result<AsrRuntimeStatus, VideoCommandError> {
    let config_dir = config_dir.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = pinned_manifest()?;
        let manifest_sha256 = pinned_manifest_sha256();
        let settings = load_settings(&config_dir);
        let runtime = match settings.runtime_folder.as_deref() {
            None => AsrRuntimeAvailability::NotConfigured,
            Some(folder) => match verify_runtime_folder(Path::new(folder), &manifest) {
                Ok(_) => AsrRuntimeAvailability::Ready,
                Err(problem) => AsrRuntimeAvailability::Unavailable { problem },
            },
        };
        Ok(AsrRuntimeStatus {
            runtime_folder: settings.runtime_folder.clone(),
            runtime,
            consent: settings.consent_state(&manifest_sha256),
            license: license_summary(&manifest),
            manifest_sha256,
        })
    })
    .await
    .map_err(|_| VideoCommandError::project_io("asr_runtime_status", "join"))?
}

/// Verifies and saves a runtime folder. Refused while any transcription job is
/// unsettled, because that job holds the currently verified runtime.
pub(crate) async fn set_asr_runtime_folder(
    config_dir: &Path,
    jobs: &MediaJobService,
    folder: &str,
) -> Result<AsrRuntimeStatus, VideoCommandError> {
    if has_unsettled_transcription(jobs).await? {
        return Err(runtime_in_use());
    }
    let folder_path = PathBuf::from(folder);
    if !folder_path.is_absolute() {
        return Err(VideoCommandError::invalid_path("set_asr_runtime", "folder"));
    }
    let config_dir_owned = config_dir.to_path_buf();
    let canonical = tauri::async_runtime::spawn_blocking(move || {
        let manifest = pinned_manifest()?;
        let runtime = verify_runtime_folder(&folder_path, &manifest)
            .map_err(NemoRuntimeProblem::into_command_error)?;
        let mut settings = load_settings(&config_dir_owned);
        settings.runtime_folder = Some(runtime.directory().to_string_lossy().into_owned());
        save_settings(&config_dir_owned, &settings)?;
        Ok::<_, VideoCommandError>(())
    })
    .await
    .map_err(|_| VideoCommandError::project_io("set_asr_runtime", "join"))?;
    canonical?;
    asr_runtime_status(config_dir).await
}

/// Records consent bound to the current manifest hash, or revokes it.
pub(crate) async fn set_asr_consent(
    config_dir: &Path,
    accepted: bool,
    manifest_sha256: &str,
) -> Result<AsrRuntimeStatus, VideoCommandError> {
    let current = pinned_manifest_sha256();
    if accepted && manifest_sha256 != current {
        // The user saw a different license set than the one now pinned.
        return Err(VideoCommandError::invalid_path(
            "accept_asr_consent",
            "manifest",
        ));
    }
    let manifest = pinned_manifest()?;
    let mut settings = load_settings(config_dir);
    settings.consent = accepted.then(|| AsrConsentRecordV1 {
        manifest_sha256: current,
        model_license_spdx: manifest.model.license.spdx.clone(),
        accepted_at_ms: current_timestamp_millis(),
    });
    save_settings(config_dir, &settings)?;
    asr_runtime_status(config_dir).await
}

pub(crate) struct ReadyAsrRuntime {
    pub(crate) runtime: VerifiedNemoRuntime,
    pub(crate) manifest: NemoRuntimeManifest,
    pub(crate) manifest_sha256: String,
}

/// Fails closed unless consent matches the pinned manifest and the saved
/// runtime folder verifies byte-for-byte.
pub(crate) async fn require_ready_runtime(
    config_dir: &Path,
) -> Result<ReadyAsrRuntime, VideoCommandError> {
    let config_dir = config_dir.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = pinned_manifest()?;
        let manifest_sha256 = pinned_manifest_sha256();
        let settings = load_settings(&config_dir);
        settings.require_consent(&manifest_sha256)?;
        let Some(folder) = settings.runtime_folder else {
            return Err(NemoRuntimeProblem::FolderMissing.into_command_error());
        };
        let runtime = verify_runtime_folder(Path::new(&folder), &manifest)
            .map_err(NemoRuntimeProblem::into_command_error)?;
        Ok(ReadyAsrRuntime {
            runtime,
            manifest,
            manifest_sha256,
        })
    })
    .await
    .map_err(|_| VideoCommandError::project_io(OPERATION, "join"))?
}

async fn has_unsettled_transcription(jobs: &MediaJobService) -> Result<bool, VideoCommandError> {
    let mut cursor = None;
    loop {
        let page = jobs
            .store()
            .list(MAX_PUBLIC_JOBS, false, None, cursor)
            .await
            .map_err(map_store_error)?;
        if page
            .jobs
            .iter()
            .any(|job| job.kind == MediaJobKind::Transcription)
        {
            return Ok(true);
        }
        if !page.has_more {
            return Ok(false);
        }
        let Some(last) = page.jobs.last() else {
            return Ok(false);
        };
        let Ok(updated_at_ms) = parse_timestamp_millis(&last.updated_at) else {
            return Ok(true);
        };
        cursor = Some((updated_at_ms, last.id.clone()));
    }
}

fn runtime_in_use() -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::ToolUnavailable,
        "Wait for transcription to finish before changing the speech-recognition runtime",
        serde_json::json!({
            "operation": "set_asr_runtime",
            "executable": "nemo",
            "category": "runtime_in_use",
        }),
    )
}

// ---------------------------------------------------------------------------
// Starting a job
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartTranscriptionRequest {
    pub(crate) project_id: String,
    pub(crate) asset_id: String,
    pub(crate) source_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionStarted {
    pub(crate) job_id: String,
    pub(crate) state: MediaJobState,
}

/// Durable result stored on a completed transcription job.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TranscriptionJobResult {
    pub(crate) transcript_key: String,
    pub(crate) word_count: u64,
    pub(crate) reused: bool,
}

pub(crate) struct TranscriptionStartContext<'a> {
    pub(crate) owner_label: &'a str,
    pub(crate) grants: &'a VideoPathGrants,
    pub(crate) jobs: &'a MediaJobService,
    pub(crate) programs: MediaPrograms,
    pub(crate) app_cache_root: PathBuf,
}

pub(crate) async fn start_transcription(
    context: TranscriptionStartContext<'_>,
    ready: ReadyAsrRuntime,
    request: StartTranscriptionRequest,
) -> Result<TranscriptionStarted, VideoCommandError> {
    let project_id = validated_uuid_segment(&request.project_id)
        .ok_or_else(|| VideoCommandError::invalid_path(OPERATION, "project_id"))?;
    let asset_id = validated_uuid_segment(&request.asset_id)
        .ok_or_else(|| VideoCommandError::invalid_path(OPERATION, "asset_id"))?;

    // Authorization precedes any file access, hashing or process work.
    let guarded = ingest_source_guarded(
        context.owner_label,
        context.grants,
        Path::new(&request.source_path),
        &context.app_cache_root,
    )
    .await?;
    // Lease the canonical object before releasing the ingest guard so cache
    // pressure cannot evict it while the job is queued or running.
    context
        .jobs
        .cache()
        .register_and_lease(
            CacheArtifactRegistration {
                key: guarded.source.identity.digest.clone(),
                content_digest: guarded.source.identity.digest.clone(),
                kind: CacheArtifactKind::SourceObject,
                path: guarded.source.object_path.clone(),
                profile_id: None,
                toolchain_id: None,
                recipe_id: None,
            },
            context.owner_label.to_owned(),
            Some(project_id.clone()),
        )
        .await
        .map_err(map_store_error)?;
    let source = guarded.into_source();
    let probe_operation = "transcription_source_probe";
    let inspected = probe_trusted_media_with_program(
        &source.object_path,
        context.programs.verified_ffprobe(probe_operation).await?,
        ProcessCancellation::new(),
        probe_operation,
    )
    .await?;
    if inspected.probe.audio.is_none() {
        return Err(VideoCommandError::invalid_media(
            OPERATION,
            "no_audio_stream",
        ));
    }
    let duration_us = inspected.probe.duration_microseconds;
    if duration_us == 0 {
        return Err(VideoCommandError::invalid_media(OPERATION, "duration"));
    }
    let configuration = nemo_asr_configuration(
        &ready.manifest,
        &ready.manifest_sha256,
        duration_us,
        ready.runtime.has_diarizer(),
    );
    let configuration_identity =
        super::transcript::derive_asr_configuration_identity(&configuration)
            .map_err(|_| VideoCommandError::invalid_media(OPERATION, "asr_configuration"))?;

    let enqueued = context
        .jobs
        .store()
        .enqueue(NewMediaJob {
            kind: MediaJobKind::Transcription,
            parent_id: None,
            dedupe_key: format!(
                "transcription:{}:{}",
                source.identity.digest, configuration_identity.digest
            ),
            project_id: Some(project_id.clone()),
            asset_id: Some(asset_id),
            revision_id: None,
            priority: MediaJobPriority::Interactive,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: stage_progress(0),
            max_attempts: TRANSCRIPTION_MAX_ATTEMPTS,
            summary: "Transcribe source audio".to_owned(),
            private_payload: serde_json::json!({
                "ownerLabel": context.owner_label,
                "sourceDigest": source.identity.digest,
                "configurationDigest": configuration_identity.digest,
            }),
            created_at_ms: current_timestamp_millis(),
        })
        .await
        .map_err(map_store_error)?;

    if enqueued.job.state == MediaJobState::Complete {
        // Dedupe hit: the reused transcript key is available right away via
        // `transcription_result` for this job id.
        return Ok(TranscriptionStarted {
            job_id: enqueued.job.id,
            state: MediaJobState::Complete,
        });
    }
    let worker = Arc::new(TranscriptionWorker {
        source,
        duration_us,
        configuration,
        runtime: ready.runtime,
        programs: context.programs,
        app_cache_root: context.app_cache_root,
        cache: context.jobs.cache().clone(),
        store: context.jobs.store().clone(),
    });
    let state = if enqueued.job.state == MediaJobState::Queued && !enqueued.reused {
        context
            .jobs
            .scheduler()
            .submit(
                enqueued.job.id.clone(),
                MediaJobPriority::Interactive,
                enqueued.job.attempt,
                enqueued.job.max_attempts,
                SchedulerResource::Gpu,
                worker,
            )
            .await
            .map_err(map_store_error)?;
        MediaJobState::Queued
    } else if enqueued.job.state == MediaJobState::Blocked {
        // A restart left this job blocked on source authorization; the caller
        // just re-authorized the source, so requeue it with a fresh worker.
        context
            .jobs
            .scheduler()
            .retry_with_worker(&enqueued.job.id, SchedulerResource::Gpu, worker)
            .await
            .map_err(map_store_error)?
            .state
    } else {
        enqueued.job.state
    };
    Ok(TranscriptionStarted {
        job_id: enqueued.job.id,
        state,
    })
}

fn stage_progress(completed: u64) -> MediaJobProgress {
    MediaJobProgress {
        completed,
        total: 1,
        unit: MediaJobProgressUnit::Stages,
    }
}

/// Pieces and the speaker pass are counted as items. Before the pieces are
/// planned the step count is unknown, so the job keeps its single-stage shape.
fn job_progress(progress: TranscriptionProgress) -> MediaJobProgress {
    if progress.total == 0 {
        return stage_progress(0);
    }
    MediaJobProgress {
        completed: progress.completed,
        total: progress.total,
        unit: MediaJobProgressUnit::Items,
    }
}

/// Writes runner progress to the job one update at a time, in order. Only the
/// newest update is kept while a write is in flight, so a slow store never
/// holds up transcription. The task ends once the sender is dropped.
fn spawn_progress_writer(
    store: MediaJobStore,
    job_id: String,
    mut updates: tokio::sync::watch::Receiver<Option<TranscriptionProgress>>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        while updates.changed().await.is_ok() {
            let Some(progress) = *updates.borrow_and_update() else {
                continue;
            };
            // Progress is advisory: a failed write must not fail the job.
            let _ = store
                .record_progress(
                    job_id.clone(),
                    progress.stage.code().to_owned(),
                    job_progress(progress),
                    current_timestamp_millis(),
                )
                .await;
        }
    })
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

struct TranscriptionWorker {
    source: IngestedSource,
    duration_us: u64,
    configuration: AsrConfigurationV1,
    runtime: VerifiedNemoRuntime,
    programs: MediaPrograms,
    app_cache_root: PathBuf,
    cache: MediaCacheService,
    store: MediaJobStore,
}

#[cfg(test)]
pub(crate) fn transcription_worker_for_test(
    source: IngestedSource,
    duration_us: u64,
    configuration: AsrConfigurationV1,
    runtime: VerifiedNemoRuntime,
    programs: MediaPrograms,
    app_cache_root: PathBuf,
    jobs: &MediaJobService,
) -> Arc<dyn MediaJobWorker> {
    Arc::new(TranscriptionWorker {
        source,
        duration_us,
        configuration,
        runtime,
        programs,
        app_cache_root,
        cache: jobs.cache().clone(),
        store: jobs.store().clone(),
    })
}

impl MediaJobWorker for TranscriptionWorker {
    fn run(&self, job_id: String, cancellation: ProcessCancellation) -> MediaWorkerFuture {
        let source_path = self.source.object_path.clone();
        let identity = self.source.identity.clone();
        let fingerprint = self.source.fingerprint.clone();
        let duration_us = self.duration_us;
        let configuration = self.configuration.clone();
        let runtime = self.runtime.clone();
        let programs = self.programs.clone();
        let app_cache_root = self.app_cache_root.clone();
        let cache = self.cache.clone();
        let store = self.store.clone();
        Box::pin(async move {
            let (progress_sender, progress_updates) = tokio::sync::watch::channel(None);
            let progress_writer = spawn_progress_writer(store, job_id, progress_updates);
            let on_progress = |progress: TranscriptionProgress| {
                progress_sender.send_replace(Some(progress));
            };
            let outcome = async {
                let ffmpeg = programs.verified_ffmpeg("transcription_audio").await?;
                transcribe_nemo_cuda(
                    NemoTranscriptionInput {
                        source_path: &source_path,
                        source_identity: &identity,
                        source_fingerprint: &fingerprint,
                        source_duration_us: duration_us,
                        configuration: &configuration,
                        app_cache_root: &app_cache_root,
                    },
                    PathBuf::from(ffmpeg),
                    runtime,
                    cancellation,
                    &cache,
                    &on_progress,
                )
                .await
            }
            .await;
            // Let the last progress write land before the scheduler settles
            // the job, so it cannot overwrite the final state.
            drop(progress_sender);
            let _ = progress_writer.await;
            match outcome {
                Ok(published) => MediaWorkerOutcome::Complete {
                    result: serde_json::to_value(TranscriptionJobResult {
                        transcript_key: published.artifact.identity.key.clone(),
                        word_count: published.artifact.words.len() as u64,
                        reused: published.reused,
                    })
                    .unwrap_or(Value::Null),
                    progress: stage_progress(1),
                },
                Err(error) if error.code == VideoErrorCode::ProcessCancelled => {
                    MediaWorkerOutcome::Cancelled {
                        progress: stage_progress(0),
                    }
                }
                Err(error) => MediaWorkerOutcome::Failed {
                    error: transcription_job_error(&error),
                    progress: stage_progress(0),
                },
            }
        })
    }
}

/// Maps a runner failure to a bounded public job error. Only a process crash or
/// timeout is retryable; everything else needs a user or configuration change.
pub(crate) fn transcription_job_error(error: &VideoCommandError) -> MediaJobError {
    let category = error
        .details
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (category, retryable, action, code, message) = match error.code {
        VideoErrorCode::ProcessFailed | VideoErrorCode::ProcessTimeout => (
            MediaJobErrorCategory::ProcessFailed,
            true,
            Some(MediaJobRecoveryAction::Retry),
            "transcription_process_failed",
            "The speech-recognition process stopped unexpectedly.",
        ),
        VideoErrorCode::ToolUnavailable if category == "cuda_not_proven" => (
            MediaJobErrorCategory::ToolchainUnavailable,
            false,
            Some(MediaJobRecoveryAction::VerifyToolchain),
            "cuda_not_proven",
            "The speech-recognition runtime did not run on the NVIDIA GPU.",
        ),
        VideoErrorCode::ToolUnavailable => (
            MediaJobErrorCategory::ToolchainUnavailable,
            false,
            Some(MediaJobRecoveryAction::VerifyToolchain),
            "nemo_unavailable",
            "The speech-recognition runtime is unavailable or changed.",
        ),
        VideoErrorCode::InvalidMedia if category == "transcript_artifact_invalid" => (
            MediaJobErrorCategory::InvalidMedia,
            false,
            None,
            "transcript_invalid",
            "The speech-recognition output could not be validated.",
        ),
        VideoErrorCode::InvalidMedia => (
            MediaJobErrorCategory::InvalidMedia,
            false,
            None,
            "invalid_audio",
            "The source audio could not be transcribed.",
        ),
        _ => (
            MediaJobErrorCategory::PolicyRejected,
            false,
            None,
            "transcription_failed",
            "Transcription failed.",
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

/// Returns the transcript key of a completed transcription job owned by
/// `owner_label`. Any other job, owner or state reads as not found, so job ids
/// cannot be probed across windows.
pub(crate) async fn transcription_result(
    jobs: &MediaJobService,
    owner_label: &str,
    job_id: &str,
) -> Result<TranscriptionJobResult, VideoCommandError> {
    let not_found = || VideoCommandError::project_io("transcription_result", "not_found");
    let job_id = validated_uuid_segment(job_id).ok_or_else(not_found)?;
    let stored = jobs
        .store()
        .get_private(job_id)
        .await
        .map_err(|_| not_found())?;
    let owned = stored
        .private_payload
        .get("ownerLabel")
        .and_then(Value::as_str)
        == Some(owner_label);
    if !owned
        || stored.public.kind != MediaJobKind::Transcription
        || stored.public.state != MediaJobState::Complete
    {
        return Err(not_found());
    }
    stored
        .result
        .and_then(|result| serde_json::from_value::<TranscriptionJobResult>(result).ok())
        .filter(|result| is_lower_hex_64(&result.transcript_key))
        .ok_or_else(not_found)
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn map_store_error(_error: MediaStateStoreError) -> VideoCommandError {
    #[cfg(test)]
    eprintln!("transcription job store error: {_error:?}");
    VideoCommandError::project_io(OPERATION, "media_job_state")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn runtime_folder_cannot_change_while_a_transcription_is_unsettled() {
        let workspace = tempfile::tempdir().unwrap();
        let config_dir = workspace.path().join("config");
        let jobs = MediaJobService::initialize(
            workspace.path().join("local-data"),
            workspace.path().join("cache"),
        )
        .await
        .unwrap();
        jobs.store()
            .enqueue(NewMediaJob {
                kind: MediaJobKind::Transcription,
                parent_id: None,
                dedupe_key: "held".to_owned(),
                project_id: None,
                asset_id: None,
                revision_id: None,
                priority: MediaJobPriority::Interactive,
                priority_value: 0,
                stage: "queued".to_owned(),
                progress: stage_progress(0),
                max_attempts: TRANSCRIPTION_MAX_ATTEMPTS,
                summary: "Transcribe source audio".to_owned(),
                private_payload: serde_json::json!({}),
                created_at_ms: 1,
            })
            .await
            .unwrap();
        let folder = workspace.path().to_string_lossy().into_owned();
        let error = set_asr_runtime_folder(&config_dir, &jobs, &folder)
            .await
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["details"]["category"],
            "runtime_in_use"
        );
        assert!(!config_dir
            .join(super::super::asr_settings::ASR_SETTINGS_FILE)
            .exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_fails_closed_without_consent_or_runtime() {
        let workspace = tempfile::tempdir().unwrap();
        let error = require_ready_runtime(workspace.path()).await.err().unwrap();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["details"]["category"],
            "consent_required"
        );
        let status = set_asr_consent(workspace.path(), true, &pinned_manifest_sha256())
            .await
            .unwrap();
        assert_eq!(status.consent, AsrConsentState::Accepted);
        assert_eq!(status.runtime, AsrRuntimeAvailability::NotConfigured);
        let error = require_ready_runtime(workspace.path()).await.err().unwrap();
        assert_eq!(error.code, VideoErrorCode::ToolUnavailable);
        assert_eq!(
            serde_json::to_value(&error).unwrap()["details"]["problem"]["reason"],
            "folderMissing"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn consent_for_a_different_manifest_is_rejected() {
        let workspace = tempfile::tempdir().unwrap();
        assert!(set_asr_consent(workspace.path(), true, &"0".repeat(64))
            .await
            .is_err());
        let status = set_asr_consent(workspace.path(), false, "").await.unwrap();
        assert_eq!(status.consent, AsrConsentState::Missing);
    }
}

#[cfg(test)]
#[path = "transcription_gpu_proof.rs"]
mod gpu_proof;
