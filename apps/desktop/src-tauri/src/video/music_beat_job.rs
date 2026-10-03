//! Music beat detection as a cancellable derived-media job.
//!
//! One job decodes the asset's first audio stream to 22.05 kHz mono WAV, then
//! detects music beats with Beat This! when the managed runtime is ready, or
//! with the in-app tempo fallback otherwise. Onsets always come from the
//! in-app envelope. The `music-beats-v1` analysis is published as a
//! content-addressed `music_beats` artifact keyed by the source content
//! identity plus detector id and version, so the same asset and detector
//! reuse one analysis.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::Builder as TempDirBuilder;

use super::{
    cache::{CacheArtifactKind, CacheArtifactRegistration, MediaCacheService},
    derived::{validated_uuid_segment, MediaPrograms},
    error::{VideoCommandError, VideoErrorCode},
    grants::VideoPathGrants,
    jobs::{
        current_timestamp_millis,
        model::{
            MediaJobError, MediaJobErrorCategory, MediaJobKind, MediaJobPriority, MediaJobProgress,
            MediaJobProgressUnit, MediaJobRecoveryAction, MediaJobState,
        },
        scheduler::{MediaJobWorker, MediaWorkerFuture, MediaWorkerOutcome, SchedulerResource},
        store::{MediaJobStore, MediaStateStoreError, NewMediaJob},
        MediaJobService,
    },
    media_store::{
        acquire_artifact, ingest_source_guarded, is_reparse_or_symlink, ArtifactStoreKind,
        IngestedSource,
    },
    music_beat_runtime::{
        extract_analysis_wav, materialize_runner, run_beat_this, VerifiedMusicBeatRuntime,
    },
    music_beats::{
        detect_onsets_us, normalized_times, onset_envelope_from_wav, seconds_to_us,
        tempo_from_beats_us, track_music_beats_fallback, MusicBeatAnalysisV1,
        MusicBeatDetectorKind, MusicBeatDetectorV1, MAX_DOWNBEATS, MAX_MUSIC_BEATS,
        MAX_MUSIC_BEAT_DURATION_US, MAX_ONSETS, MUSIC_BEAT_ANALYSIS_FORMAT, TEMPO_FALLBACK_VERSION,
    },
    probe::probe_trusted_media_with_program,
    process::ProcessCancellation,
};

const OPERATION: &str = "detect_music_beats";
const OWNER_LABEL: &str = "music-beat-detection";
/// First attempt plus one automatic retry for a crash or timeout.
pub(crate) const MUSIC_BEAT_DETECTION_MAX_ATTEMPTS: u8 = 2;
/// Analyses are bounded by the time caps; 20k + 20k + 60k integers is ~1.5 MB.
const MAX_ANALYSIS_JSON_BYTES: u64 = 4 * 1024 * 1024;
const STAGES: u64 = 3;

// ---------------------------------------------------------------------------
// Detector choice and analysis key
// ---------------------------------------------------------------------------

/// The detector a job will run, fixed when the job is created.
#[derive(Clone, Debug)]
pub(crate) enum MusicBeatDetectorChoice {
    BeatThis(VerifiedMusicBeatRuntime),
    TempoFallback,
}

impl MusicBeatDetectorChoice {
    pub(crate) fn detector(&self) -> MusicBeatDetectorV1 {
        match self {
            Self::BeatThis(runtime) => MusicBeatDetectorV1 {
                kind: MusicBeatDetectorKind::BeatThis,
                version: runtime.beat_this_version.clone(),
                checkpoint_sha256: Some(runtime.checkpoint_sha256.clone()),
            },
            Self::TempoFallback => MusicBeatDetectorV1 {
                kind: MusicBeatDetectorKind::TempoFallback,
                version: TEMPO_FALLBACK_VERSION.to_owned(),
                checkpoint_sha256: None,
            },
        }
    }

    fn resource(&self) -> SchedulerResource {
        match self {
            Self::BeatThis(_) => SchedulerResource::Gpu,
            Self::TempoFallback => SchedulerResource::Ffmpeg,
        }
    }
}

/// SHA-256 over a canonical, newline-separated description of the input:
/// format, source content digest, detector kind, version and checkpoint.
pub(crate) fn music_beat_analysis_key(
    source_digest: &str,
    detector: &MusicBeatDetectorV1,
) -> String {
    let canonical = format!(
        "{MUSIC_BEAT_ANALYSIS_FORMAT}\nsource={source_digest}\ndetector={}\nversion={}\ncheckpoint={}\n",
        detector.kind.as_str(),
        detector.version,
        detector.checkpoint_sha256.as_deref().unwrap_or("-"),
    );
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

// ---------------------------------------------------------------------------
// Starting a job
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartMusicBeatDetectionRequest {
    pub(crate) project_id: String,
    pub(crate) asset_id: String,
    pub(crate) source_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicBeatDetectionStarted {
    pub(crate) job_id: String,
    pub(crate) state: MediaJobState,
}

/// Durable result stored on a completed music beat detection job.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MusicBeatDetectionResult {
    pub(crate) analysis_key: String,
    pub(crate) detector: MusicBeatDetectorKind,
    pub(crate) music_beat_count: u64,
    pub(crate) reused: bool,
}

pub(crate) struct MusicBeatStartContext<'a> {
    pub(crate) owner_label: &'a str,
    pub(crate) grants: &'a VideoPathGrants,
    pub(crate) jobs: &'a MediaJobService,
    pub(crate) programs: MediaPrograms,
    pub(crate) app_cache_root: PathBuf,
}

pub(crate) async fn start_music_beat_detection(
    context: MusicBeatStartContext<'_>,
    choice: MusicBeatDetectorChoice,
    request: StartMusicBeatDetectionRequest,
) -> Result<MusicBeatDetectionStarted, VideoCommandError> {
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
    let probe_operation = "music_beat_source_probe";
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
    if duration_us > MAX_MUSIC_BEAT_DURATION_US {
        return Err(VideoCommandError::invalid_media(
            OPERATION,
            "duration_limit",
        ));
    }
    start_for_source(context, choice, source, project_id, asset_id).await
}

async fn start_for_source(
    context: MusicBeatStartContext<'_>,
    choice: MusicBeatDetectorChoice,
    source: IngestedSource,
    project_id: String,
    asset_id: String,
) -> Result<MusicBeatDetectionStarted, VideoCommandError> {
    let detector = choice.detector();
    let analysis_key = music_beat_analysis_key(&source.identity.digest, &detector);
    let enqueued = context
        .jobs
        .store()
        .enqueue(NewMediaJob {
            kind: MediaJobKind::MusicBeatDetection,
            parent_id: None,
            dedupe_key: format!("music_beats:{analysis_key}"),
            project_id: Some(project_id),
            asset_id: Some(asset_id),
            revision_id: None,
            priority: MediaJobPriority::Interactive,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: stage_progress(0),
            max_attempts: MUSIC_BEAT_DETECTION_MAX_ATTEMPTS,
            summary: "Detect music beats".to_owned(),
            private_payload: serde_json::json!({
                "ownerLabel": context.owner_label,
                "sourceDigest": source.identity.digest,
                "analysisKey": analysis_key,
                "detector": detector.kind.as_str(),
            }),
            created_at_ms: current_timestamp_millis(),
        })
        .await
        .map_err(map_store_error)?;

    if enqueued.job.state == MediaJobState::Complete {
        return Ok(MusicBeatDetectionStarted {
            job_id: enqueued.job.id,
            state: MediaJobState::Complete,
        });
    }
    let resource = choice.resource();
    let worker = Arc::new(MusicBeatWorker {
        source,
        choice,
        analysis_key,
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
                resource,
                worker,
            )
            .await
            .map_err(map_store_error)?;
        MediaJobState::Queued
    } else if enqueued.job.state == MediaJobState::Blocked {
        context
            .jobs
            .scheduler()
            .retry_with_worker(&enqueued.job.id, resource, worker)
            .await
            .map_err(map_store_error)?
            .state
    } else {
        enqueued.job.state
    };
    Ok(MusicBeatDetectionStarted {
        job_id: enqueued.job.id,
        state,
    })
}

fn stage_progress(completed: u64) -> MediaJobProgress {
    MediaJobProgress {
        completed,
        total: STAGES,
        unit: MediaJobProgressUnit::Stages,
    }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

struct MusicBeatWorker {
    source: IngestedSource,
    choice: MusicBeatDetectorChoice,
    analysis_key: String,
    programs: MediaPrograms,
    app_cache_root: PathBuf,
    cache: MediaCacheService,
    store: MediaJobStore,
}

struct PublishedMusicBeatAnalysis {
    analysis: MusicBeatAnalysisV1,
    reused: bool,
}

impl MediaJobWorker for MusicBeatWorker {
    fn run(&self, job_id: String, cancellation: ProcessCancellation) -> MediaWorkerFuture {
        let source_path = self.source.object_path.clone();
        let choice = self.choice.clone();
        let analysis_key = self.analysis_key.clone();
        let programs = self.programs.clone();
        let app_cache_root = self.app_cache_root.clone();
        let cache = self.cache.clone();
        let store = self.store.clone();
        Box::pin(async move {
            let started = std::time::Instant::now();
            let outcome = detect_and_publish(DetectInput {
                job_id: &job_id,
                source_path: &source_path,
                choice: &choice,
                analysis_key: &analysis_key,
                programs: &programs,
                app_cache_root: &app_cache_root,
                cache: &cache,
                store: &store,
                cancellation,
            })
            .await;
            eprintln!(
                "music_beats.job detector={} ok={} elapsed_ms={}",
                choice.detector().kind.as_str(),
                outcome.is_ok(),
                started.elapsed().as_millis()
            );
            match outcome {
                Ok(published) => MediaWorkerOutcome::Complete {
                    result: serde_json::to_value(MusicBeatDetectionResult {
                        analysis_key,
                        detector: published.analysis.detector.kind,
                        music_beat_count: published.analysis.beats_us.len() as u64,
                        reused: published.reused,
                    })
                    .unwrap_or(Value::Null),
                    progress: stage_progress(STAGES),
                },
                Err(error) if error.code == VideoErrorCode::ProcessCancelled => {
                    MediaWorkerOutcome::Cancelled {
                        progress: stage_progress(0),
                    }
                }
                Err(error) => MediaWorkerOutcome::Failed {
                    error: music_beat_job_error(&error),
                    progress: stage_progress(0),
                },
            }
        })
    }
}

struct DetectInput<'a> {
    job_id: &'a str,
    source_path: &'a Path,
    choice: &'a MusicBeatDetectorChoice,
    analysis_key: &'a str,
    programs: &'a MediaPrograms,
    app_cache_root: &'a Path,
    cache: &'a MediaCacheService,
    store: &'a MediaJobStore,
    cancellation: ProcessCancellation,
}

async fn record_stage(store: &MediaJobStore, job_id: &str, stage: &str, completed: u64) {
    // Progress is advisory: a failed write must not fail the job.
    let _ = store
        .record_progress(
            job_id.to_owned(),
            stage.to_owned(),
            stage_progress(completed),
            current_timestamp_millis(),
        )
        .await;
}

fn cancelled() -> VideoCommandError {
    VideoCommandError::process_cancelled(OPERATION, "music_beats")
}

async fn detect_and_publish(
    input: DetectInput<'_>,
) -> Result<PublishedMusicBeatAnalysis, VideoCommandError> {
    let temporary = TempDirBuilder::new()
        .prefix("music-beats-")
        .tempdir_in(input.app_cache_root)
        .map_err(|_| VideoCommandError::project_io(OPERATION, "temporary_directory"))?;
    let wav_path = temporary.path().join("analysis.wav");

    record_stage(input.store, input.job_id, "extracting", 0).await;
    let ffmpeg = input.programs.verified_ffmpeg("music_beat_audio").await?;
    extract_analysis_wav(
        Path::new(&ffmpeg),
        input.source_path,
        &wav_path,
        input.cancellation.clone(),
    )
    .await?;

    record_stage(input.store, input.job_id, "detecting", 1).await;
    let envelope = {
        let wav_path = wav_path.clone();
        let cancellation = input.cancellation.clone();
        tauri::async_runtime::spawn_blocking(move || {
            onset_envelope_from_wav(&wav_path, &cancellation)
        })
        .await
        .map_err(|_| VideoCommandError::project_io(OPERATION, "analysis_task"))??
    };
    let duration_us = envelope.duration_us();
    let onsets_us = detect_onsets_us(&envelope);
    let (tempo_bpm, beats_us, downbeats_us) = match input.choice {
        MusicBeatDetectorChoice::BeatThis(runtime) => {
            runtime.recheck_checkpoint().await?;
            let runner = materialize_runner(input.app_cache_root)?;
            let output =
                run_beat_this(runtime, &runner, &wav_path, input.cancellation.clone()).await?;
            let to_times = |seconds: Vec<f64>, cap: usize| {
                seconds
                    .into_iter()
                    .map(seconds_to_us)
                    .collect::<Option<Vec<u64>>>()
                    .map(|times| normalized_times(times, duration_us, cap))
                    .ok_or_else(|| {
                        VideoCommandError::invalid_media(OPERATION, "music_beats_output")
                    })
            };
            let beats_us = to_times(output.beats, MAX_MUSIC_BEATS)?;
            let downbeats_us = to_times(output.downbeats, MAX_DOWNBEATS)?;
            (tempo_from_beats_us(&beats_us), beats_us, downbeats_us)
        }
        MusicBeatDetectorChoice::TempoFallback => {
            let cancellation = input.cancellation.clone();
            let tracked = tauri::async_runtime::spawn_blocking(move || {
                track_music_beats_fallback(&envelope, &cancellation)
            })
            .await
            .map_err(|_| VideoCommandError::project_io(OPERATION, "analysis_task"))??;
            // The fallback does not detect metre, so it reports no downbeats.
            (tracked.tempo_bpm, tracked.beats_us, Vec::new())
        }
    };
    if input.cancellation.is_cancelled() {
        return Err(cancelled());
    }
    let analysis = MusicBeatAnalysisV1 {
        schema_version: 1,
        detector: input.choice.detector(),
        duration_us,
        tempo_bpm: if beats_us.is_empty() { None } else { tempo_bpm },
        beats_us,
        downbeats_us,
        onsets_us: normalized_times(onsets_us, duration_us, MAX_ONSETS),
    };
    analysis
        .validate()
        .map_err(|_| VideoCommandError::invalid_media(OPERATION, "music_beats_invalid"))?;

    record_stage(input.store, input.job_id, "publishing", 2).await;
    publish_music_beat_analysis(
        input.app_cache_root,
        input.cache,
        input.analysis_key,
        &analysis,
    )
    .await
}

async fn publish_music_beat_analysis(
    app_cache_root: &Path,
    cache: &MediaCacheService,
    key: &str,
    analysis: &MusicBeatAnalysisV1,
) -> Result<PublishedMusicBeatAnalysis, VideoCommandError> {
    let artifact_error =
        |category: &'static str| VideoCommandError::project_io(OPERATION, category);
    let bytes = serde_json::to_vec(analysis).map_err(|_| artifact_error("serialize"))?;
    if bytes.len() as u64 > MAX_ANALYSIS_JSON_BYTES {
        return Err(VideoCommandError::invalid_media(
            OPERATION,
            "music_beats_size",
        ));
    }
    let guard = acquire_artifact(app_cache_root, ArtifactStoreKind::MusicBeats, key).await?;
    // The key names the input, not the output bytes. An existing valid
    // analysis for the same input wins, so concurrent runs converge.
    let (analysis, bytes, reused) = match read_valid_analysis(guard.path()) {
        Ok((existing, existing_bytes)) => (existing, existing_bytes, true),
        Err(_) => {
            let mut temporary = guard.temporary()?;
            temporary
                .as_file_mut()
                .write_all(&bytes)
                .and_then(|()| temporary.as_file_mut().flush())
                .and_then(|()| temporary.as_file().sync_all())
                .map_err(|_| artifact_error("temporary_write"))?;
            let (reread, _) = read_valid_analysis(temporary.path())?;
            if &reread != analysis {
                return Err(artifact_error("temporary_bytes"));
            }
            guard.promote(temporary)?;
            (analysis.clone(), bytes, false)
        }
    };
    guard.confirm_durable()?;
    cache
        .register_and_lease(
            CacheArtifactRegistration {
                key: key.to_owned(),
                content_digest: format!("{:x}", Sha256::digest(&bytes)),
                kind: CacheArtifactKind::MusicBeats,
                path: guard.path().to_path_buf(),
                profile_id: None,
                toolchain_id: Some(format!(
                    "{}:{}",
                    analysis.detector.kind.as_str(),
                    analysis.detector.version
                )),
                recipe_id: Some(MUSIC_BEAT_ANALYSIS_FORMAT.to_owned()),
            },
            OWNER_LABEL.to_owned(),
            None,
        )
        .await
        .map_err(|_| artifact_error("cache_register"))?;
    Ok(PublishedMusicBeatAnalysis { analysis, reused })
}

fn read_valid_analysis(path: &Path) -> Result<(MusicBeatAnalysisV1, Vec<u8>), VideoCommandError> {
    let invalid = || VideoCommandError::invalid_media(OPERATION, "music_beats_invalid");
    let metadata = std::fs::symlink_metadata(path).map_err(|_| invalid())?;
    if !metadata.is_file()
        || is_reparse_or_symlink(&metadata)
        || metadata.len() > MAX_ANALYSIS_JSON_BYTES
    {
        return Err(invalid());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(path)
        .map_err(|_| invalid())?
        .take(MAX_ANALYSIS_JSON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() as u64 > MAX_ANALYSIS_JSON_BYTES {
        return Err(invalid());
    }
    let analysis: MusicBeatAnalysisV1 = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    analysis.validate().map_err(|_| invalid())?;
    Ok((analysis, bytes))
}

/// Loads a published analysis by key for the frontend.
pub(crate) async fn load_music_beat_analysis(
    app_cache_root: &Path,
    key: &str,
) -> Result<MusicBeatAnalysisV1, VideoCommandError> {
    if !is_lower_hex_64(key) {
        return Err(VideoCommandError::project_io(
            "load_music_beat_analysis",
            "not_found",
        ));
    }
    let guard = acquire_artifact(app_cache_root, ArtifactStoreKind::MusicBeats, key).await?;
    if !guard.path().exists() {
        return Err(VideoCommandError::project_io(
            "load_music_beat_analysis",
            "not_found",
        ));
    }
    let (analysis, _) = read_valid_analysis(guard.path())?;
    guard.confirm_durable()?;
    Ok(analysis)
}

/// Maps a failure to a bounded public job error. Only a process crash or
/// timeout is retryable.
pub(crate) fn music_beat_job_error(error: &VideoCommandError) -> MediaJobError {
    let (category, retryable, action, code, message) = match error.code {
        VideoErrorCode::ProcessFailed | VideoErrorCode::ProcessTimeout => (
            MediaJobErrorCategory::ProcessFailed,
            true,
            Some(MediaJobRecoveryAction::Retry),
            "music_beat_process_failed",
            "The music beat detector stopped unexpectedly.",
        ),
        VideoErrorCode::ToolUnavailable => (
            MediaJobErrorCategory::ToolchainUnavailable,
            false,
            Some(MediaJobRecoveryAction::VerifyToolchain),
            "music_beat_runtime_unavailable",
            "The music beat runtime is unavailable or changed.",
        ),
        VideoErrorCode::InvalidMedia => (
            MediaJobErrorCategory::InvalidMedia,
            false,
            None,
            "music_beats_invalid",
            "The music could not be analysed for beats.",
        ),
        _ => (
            MediaJobErrorCategory::PolicyRejected,
            false,
            None,
            "music_beat_detection_failed",
            "Music beat detection failed.",
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

/// Returns the result of a completed music beat detection job owned by
/// `owner_label`. Any other job, owner or state reads as not found.
pub(crate) async fn music_beat_detection_result(
    jobs: &MediaJobService,
    owner_label: &str,
    job_id: &str,
) -> Result<MusicBeatDetectionResult, VideoCommandError> {
    let not_found = || VideoCommandError::project_io("music_beat_detection_result", "not_found");
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
        || stored.public.kind != MediaJobKind::MusicBeatDetection
        || stored.public.state != MediaJobState::Complete
    {
        return Err(not_found());
    }
    stored
        .result
        .and_then(|result| serde_json::from_value::<MusicBeatDetectionResult>(result).ok())
        .filter(|result| is_lower_hex_64(&result.analysis_key))
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
    eprintln!("music beat job store error: {_error:?}");
    VideoCommandError::project_io(OPERATION, "media_job_state")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, fs, time::Duration};

    use super::*;
    use crate::video::{
        media_store::ingest_blocking_for_test,
        music_beat_runtime::{
            fixture_manifest, runtime_folder_fixture, verify_runtime_folder, write_test_wav,
        },
        music_beats::click_track_samples,
    };

    struct Fixture {
        _workspace: tempfile::TempDir,
        workspace_path: PathBuf,
        cache_root: PathBuf,
        jobs: MediaJobService,
        source: IngestedSource,
    }

    async fn fixture() -> Fixture {
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = workspace.path().to_path_buf();
        let cache_root = workspace_path.join("cache");
        fs::create_dir_all(&cache_root).unwrap();
        let source_path = workspace_path.join("music.wav");
        write_test_wav(&source_path, &click_track_samples(120.0, 0.5, 4.0));
        let source =
            ingest_blocking_for_test(source_path.canonicalize().unwrap(), cache_root.clone())
                .unwrap();
        let jobs =
            MediaJobService::initialize(workspace_path.join("local-data"), cache_root.clone())
                .await
                .unwrap();
        Fixture {
            _workspace: workspace,
            workspace_path,
            cache_root,
            jobs,
            source,
        }
    }

    /// The test binary stands in for ffmpeg (helper mode `music_beat_ffmpeg`).
    fn fake_programs() -> MediaPrograms {
        let current = std::env::current_exe().unwrap();
        MediaPrograms::explicit(current.into_os_string(), OsString::from("ffprobe"))
    }

    async fn start(fixture: &Fixture, choice: MusicBeatDetectorChoice) -> String {
        let grants = VideoPathGrants::default();
        start_for_source(
            MusicBeatStartContext {
                owner_label: "main",
                grants: &grants,
                jobs: &fixture.jobs,
                programs: fake_programs(),
                app_cache_root: fixture.cache_root.clone(),
            },
            choice,
            fixture.source.clone(),
            "00000000-0000-4000-8000-000000000001".to_owned(),
            "00000000-0000-4000-8000-000000000002".to_owned(),
        )
        .await
        .unwrap()
        .job_id
    }

    async fn wait_settled(fixture: &Fixture, job_id: &str) -> MediaJobState {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let state = fixture
                .jobs
                .store()
                .get_private(job_id.to_owned())
                .await
                .unwrap()
                .public
                .state;
            if matches!(
                state,
                MediaJobState::Complete | MediaJobState::Failed | MediaJobState::Cancelled
            ) {
                return state;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "job stuck in {state:?}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn ready_beat_this(fixture: &Fixture) -> VerifiedMusicBeatRuntime {
        let checkpoint = b"fake final0 checkpoint";
        let folder = runtime_folder_fixture(&fixture.workspace_path, checkpoint);
        verify_runtime_folder(&folder, &fixture_manifest(checkpoint))
            .await
            .expect("fake runtime must verify")
    }

    #[test]
    fn analysis_key_depends_on_source_and_detector() {
        let fallback = MusicBeatDetectorChoice::TempoFallback.detector();
        let beat_this = MusicBeatDetectorV1 {
            kind: MusicBeatDetectorKind::BeatThis,
            version: "1.1.0".to_owned(),
            checkpoint_sha256: Some("a".repeat(64)),
        };
        let source = "b".repeat(64);
        let key = music_beat_analysis_key(&source, &fallback);
        assert!(is_lower_hex_64(&key));
        assert_eq!(key, music_beat_analysis_key(&source, &fallback));
        assert_ne!(key, music_beat_analysis_key(&source, &beat_this));
        assert_ne!(key, music_beat_analysis_key(&"c".repeat(64), &fallback));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fallback_job_completes_and_publishes_a_loadable_analysis() {
        let fixture = fixture().await;
        let job_id = start(&fixture, MusicBeatDetectorChoice::TempoFallback).await;
        assert_eq!(
            wait_settled(&fixture, &job_id).await,
            MediaJobState::Complete
        );

        let result = music_beat_detection_result(&fixture.jobs, "main", &job_id)
            .await
            .unwrap();
        assert_eq!(result.detector, MusicBeatDetectorKind::TempoFallback);
        assert!(!result.reused);
        let analysis = load_music_beat_analysis(&fixture.cache_root, &result.analysis_key)
            .await
            .unwrap();
        assert_eq!(analysis.detector.kind, MusicBeatDetectorKind::TempoFallback);
        assert_eq!(analysis.beats_us.len() as u64, result.music_beat_count);
        assert!(analysis.beats_us.len() >= 5, "{:?}", analysis.beats_us);
        assert!(!analysis.onsets_us.is_empty());
        assert!(analysis.downbeats_us.is_empty());
        let tempo = analysis.tempo_bpm.unwrap();
        assert!((tempo - 120.0).abs() <= 1.0, "tempo {tempo}");
        // Another owner cannot read the result.
        assert!(music_beat_detection_result(&fixture.jobs, "other", &job_id)
            .await
            .is_err());

        // The same source and detector reuse the completed job.
        let again = start(&fixture, MusicBeatDetectorChoice::TempoFallback).await;
        assert_eq!(again, job_id);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn beat_this_job_uses_the_runner_output_and_records_the_checkpoint() {
        let fixture = fixture().await;
        let runtime = ready_beat_this(&fixture).await;
        let checkpoint_sha256 = runtime.checkpoint_sha256.clone();
        let job_id = start(&fixture, MusicBeatDetectorChoice::BeatThis(runtime)).await;
        assert_eq!(
            wait_settled(&fixture, &job_id).await,
            MediaJobState::Complete
        );

        let result = music_beat_detection_result(&fixture.jobs, "main", &job_id)
            .await
            .unwrap();
        assert_eq!(result.detector, MusicBeatDetectorKind::BeatThis);
        let analysis = load_music_beat_analysis(&fixture.cache_root, &result.analysis_key)
            .await
            .unwrap();
        assert_eq!(
            analysis.detector.checkpoint_sha256.as_deref(),
            Some(checkpoint_sha256.as_str())
        );
        assert_eq!(
            analysis.beats_us,
            vec![500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000]
        );
        assert_eq!(analysis.downbeats_us, vec![500_000, 2_500_000]);
        assert_eq!(analysis.tempo_bpm, Some(120.0));
        assert!(!analysis.onsets_us.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn malformed_runner_output_fails_without_publishing() {
        let fixture = fixture().await;
        let runtime = ready_beat_this(&fixture).await;
        fs::write(
            runtime.checkpoint.with_file_name("fake-detect-malformed"),
            b"",
        )
        .unwrap();
        let job_id = start(&fixture, MusicBeatDetectorChoice::BeatThis(runtime)).await;
        assert_eq!(wait_settled(&fixture, &job_id).await, MediaJobState::Failed);
        let job = fixture
            .jobs
            .store()
            .get_private(job_id.clone())
            .await
            .unwrap()
            .public;
        assert_eq!(job.error.unwrap().code, "music_beats_invalid");
        assert_eq!(
            published_analysis_count(&fixture.cache_root.join("derived").join("music_beats")),
            0
        );
    }

    fn published_analysis_count(directory: &Path) -> usize {
        let Ok(entries) = fs::read_dir(directory) else {
            return 0;
        };
        entries
            .map(|entry| entry.unwrap().path())
            .map(|path| {
                if path.is_dir() {
                    published_analysis_count(&path)
                } else {
                    usize::from(
                        path.extension()
                            .is_some_and(|extension| extension == "json"),
                    )
                }
            })
            .sum()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_running_job_stops_the_runner() {
        let fixture = fixture().await;
        let runtime = ready_beat_this(&fixture).await;
        let marker_dir = runtime.checkpoint.parent().unwrap().to_path_buf();
        fs::write(marker_dir.join("fake-detect-hang"), b"").unwrap();
        let job_id = start(&fixture, MusicBeatDetectorChoice::BeatThis(runtime)).await;
        let running = marker_dir.join("fake-detect-running");
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while !running.exists() {
            assert!(std::time::Instant::now() < deadline, "runner never started");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        fixture.jobs.scheduler().cancel(&job_id).await.unwrap();
        assert_eq!(
            wait_settled(&fixture, &job_id).await,
            MediaJobState::Cancelled
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_missing_runtime_selects_the_fallback() {
        let fixture = fixture().await;
        let config_dir = fixture.workspace_path.join("config");
        let (status, verified) =
            crate::video::music_beat_runtime::music_beat_runtime_status(&config_dir).await;
        assert!(verified.is_none());
        assert_eq!(
            status.runtime,
            crate::video::music_beat_runtime::MusicBeatRuntimeAvailability::NotConfigured
        );
        let choice = verified.map_or(
            MusicBeatDetectorChoice::TempoFallback,
            MusicBeatDetectorChoice::BeatThis,
        );
        let job_id = start(&fixture, choice).await;
        assert_eq!(
            wait_settled(&fixture, &job_id).await,
            MediaJobState::Complete
        );
        let result = music_beat_detection_result(&fixture.jobs, "main", &job_id)
            .await
            .unwrap();
        assert_eq!(result.detector, MusicBeatDetectorKind::TempoFallback);
    }

    /// Makes a 120 BPM click track with ffmpeg `aevalsrc` (a 20 ms 1 kHz burst
    /// every 0.5 s for 12 s, 44.1 kHz stereo), ingests it, runs `choice` with
    /// the real ffmpeg, then loads the analysis and checks tempo and grid.
    async fn click_track_end_to_end(choice: MusicBeatDetectorChoice) -> MusicBeatAnalysisV1 {
        let workspace = tempfile::tempdir().unwrap();
        let cache_root = workspace.path().join("cache");
        fs::create_dir_all(&cache_root).unwrap();
        let click_path = workspace.path().join("click-120.wav");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                r"aevalsrc=0.8*sin(2*PI*1000*t)*lt(mod(t\,0.5)\,0.02):s=44100:d=12",
                "-ac",
                "2",
                "-c:a",
                "pcm_s16le",
                "-y",
            ])
            .arg(&click_path)
            .status()
            .expect("ffmpeg must run");
        assert!(status.success());

        let source =
            ingest_blocking_for_test(click_path.canonicalize().unwrap(), cache_root.clone())
                .unwrap();
        let jobs =
            MediaJobService::initialize(workspace.path().join("local-data"), cache_root.clone())
                .await
                .unwrap();
        let grants = VideoPathGrants::default();
        let job_id = start_for_source(
            MusicBeatStartContext {
                owner_label: "main",
                grants: &grants,
                jobs: &jobs,
                programs: MediaPrograms::explicit(
                    OsString::from("ffmpeg"),
                    OsString::from("ffprobe"),
                ),
                app_cache_root: cache_root.clone(),
            },
            choice,
            source,
            "00000000-0000-4000-8000-000000000001".to_owned(),
            "00000000-0000-4000-8000-000000000002".to_owned(),
        )
        .await
        .unwrap()
        .job_id;
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        let job = loop {
            let job = jobs
                .store()
                .get_private(job_id.clone())
                .await
                .unwrap()
                .public;
            if matches!(
                job.state,
                MediaJobState::Complete | MediaJobState::Failed | MediaJobState::Cancelled
            ) {
                break job;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert_eq!(job.state, MediaJobState::Complete, "{:?}", job.error);
        let result = music_beat_detection_result(&jobs, "main", &job_id)
            .await
            .unwrap();
        let analysis = load_music_beat_analysis(&cache_root, &result.analysis_key)
            .await
            .unwrap();
        let tempo = analysis.tempo_bpm.unwrap();
        assert!((tempo - 120.0).abs() <= 1.0, "tempo {tempo}");
        assert!(analysis.beats_us.len() >= 20, "{:?}", analysis.beats_us);
        for beat in &analysis.beats_us {
            let phase = beat % 500_000;
            let error = phase.min(500_000 - phase);
            assert!(
                error <= 20_000,
                "beat {beat} is {error} us off the click grid"
            );
        }
        eprintln!(
            "music_beats.e2e detector={} tempo_bpm={tempo} beats={} downbeats={} onsets={}",
            analysis.detector.kind.as_str(),
            analysis.beats_us.len(),
            analysis.downbeats_us.len(),
            analysis.onsets_us.len()
        );
        analysis
    }

    /// End to end with the real ffmpeg and the in-app fallback.
    /// Run with `cargo test --lib music_beat_ffmpeg_click_track -- --ignored`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "needs ffmpeg and ffprobe on PATH"]
    async fn music_beat_ffmpeg_click_track_end_to_end() {
        let analysis = click_track_end_to_end(MusicBeatDetectorChoice::TempoFallback).await;
        assert_eq!(analysis.detector.kind, MusicBeatDetectorKind::TempoFallback);
    }

    /// The real Beat This! proof: needs a runtime folder built by
    /// `scripts/setup-music-beat-runtime.ps1` (PyTorch plus the pinned
    /// checkpoint). Run with `SUPA_VIDEO_REAL_BEAT_THIS_PROOF=1
    /// SUPA_VIDEO_MUSIC_BEAT_RUNTIME=<folder> cargo test --lib
    /// music_beat_real_beat_this -- --ignored`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "needs ffmpeg, PyTorch and the Beat This! checkpoint"]
    async fn music_beat_real_beat_this_click_track_end_to_end() {
        assert_eq!(
            std::env::var(crate::video::music_beat_runtime::REAL_BEAT_THIS_PROOF_ENV).as_deref(),
            Ok("1"),
            "set SUPA_VIDEO_REAL_BEAT_THIS_PROOF=1"
        );
        let folder = std::env::var("SUPA_VIDEO_MUSIC_BEAT_RUNTIME")
            .expect("set SUPA_VIDEO_MUSIC_BEAT_RUNTIME to the runtime folder");
        let runtime = crate::video::music_beat_runtime::verify_runtime_folder(
            Path::new(&folder),
            &crate::video::music_beat_runtime::pinned_manifest(),
        )
        .await
        .expect("the runtime folder must match the pinned manifest");
        let analysis = click_track_end_to_end(MusicBeatDetectorChoice::BeatThis(runtime)).await;
        assert_eq!(analysis.detector.kind, MusicBeatDetectorKind::BeatThis);
        assert!(!analysis.downbeats_us.is_empty());
    }
}
