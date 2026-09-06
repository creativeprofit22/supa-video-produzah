use std::{
    ffi::{OsStr, OsString},
    fs::{self, Metadata, OpenOptions},
    io,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use fs4::TryLockError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, Runtime, State, WebviewWindow};
use tempfile::{Builder as TempFileBuilder, TempPath};

use super::{
    cache::{CacheArtifactKind, CacheArtifactRegistration, MediaCacheService},
    error::{VideoCommandError, VideoErrorCode},
    grants::VideoPathGrants,
    jobs::{
        current_timestamp_millis,
        model::{
            MediaJobError, MediaJobErrorCategory, MediaJobEventType, MediaJobKind,
            MediaJobPriority, MediaJobProgress, MediaJobProgressUnit, MediaJobRecoveryAction,
            MediaJobState,
        },
        scheduler::{MediaJobWorker, MediaWorkerFuture, MediaWorkerOutcome, SchedulerResource},
        store::{MediaJobTransition, MediaStateStoreError, NewMediaJob, StoredPrivateJob},
        MediaJobService,
    },
    media_store::{
        acquire_artifact, acquire_source_lock, ingest_source_guarded, ArtifactStoreKind,
    },
    probe::{
        probe_thumbnail_artifact_with_program, probe_trusted_media_with_program, InspectedMedia,
        ThumbnailArtifactProbe,
    },
    process::{run_supervised, ProcessCancellation, ProcessFailure, ProcessSpec},
    project::service::VideoProjectService,
    toolchain::MediaToolchainState,
    types::{
        is_contract_uuid, MediaColorMetadata, MediaContentIdentityV1, MediaDisplayShape,
        MediaProbe, PreparedVideoAsset, RationalRate, MAX_SAFE_INTEGER,
    },
};

const CACHE_NAMESPACE: &str = "video-phase1";
const PROFILE_CACHE_LOCK_FILENAME: &str = ".profile.lock";
const PROFILE_CACHE_LOCK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PROFILE_CACHE_LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(50);
const MICROS_PER_SECOND: u64 = 1_000_000;
const PROXY_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const FFMPEG_STDOUT_LIMIT: usize = 16 * 1024;
const FFMPEG_STDERR_TAIL_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DerivedModelError {
    ProjectId,
    AssetId,
    SequenceRate,
    SourceIdentity,
    Fingerprint,
    Dimensions,
    Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputDimensions {
    pub(crate) width: u64,
    pub(crate) height: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ArtifactFileFacts {
    pub(crate) is_regular_file: bool,
    pub(crate) byte_len: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArtifactValidationError {
    NotRegularFile,
    EmptyFile,
    ProbeSizeMismatch,
    VideoCodec,
    Dimensions,
    FrameCount,
    PixelFormat,
    ColorMetadata,
    FrameRate,
    VariableFrameRate,
    Audio,
    Duration,
    Path,
    FileExtension,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedDerivedInput {
    pub(crate) project_segment: String,
    pub(crate) asset_segment: String,
    pub(crate) sequence_rate: RationalRate,
}

impl ValidatedDerivedInput {
    pub(crate) fn new(
        project_id: &str,
        asset_id: &str,
        sequence_rate: RationalRate,
    ) -> Result<Self, DerivedModelError> {
        let project_segment =
            validated_uuid_segment(project_id).ok_or(DerivedModelError::ProjectId)?;
        let asset_segment = validated_uuid_segment(asset_id).ok_or(DerivedModelError::AssetId)?;
        let sequence_rate =
            validated_sequence_rate(sequence_rate).ok_or(DerivedModelError::SequenceRate)?;
        Ok(Self {
            project_segment,
            asset_segment,
            sequence_rate,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceIdentity<'a> {
    pub(crate) canonical_path: &'a Path,
    pub(crate) file_size_bytes: u64,
    pub(crate) modified_unix_seconds: i64,
    pub(crate) modified_nanoseconds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DerivedArtifactPaths {
    pub(crate) profile_directory: PathBuf,
    pub(crate) proxy_path: PathBuf,
    pub(crate) thumbnail_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedCacheDirectory {
    pub(crate) profile_directory: PathBuf,
}

#[derive(Debug)]
pub(crate) struct DerivedTempArtifacts {
    pub(crate) proxy: TempPath,
    pub(crate) thumbnail: TempPath,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CacheLifecycleError {
    CacheRoot,
    Component,
    Escape,
    NotDirectory,
    LockFile,
    LockTimeout,
    TemporaryFile,
    UnsafeArtifactPath,
    TemporaryValidation,
    Promotion,
    FinalValidation,
    Cleanup,
}

#[derive(Debug)]
pub(crate) struct ProfileCacheLock {
    file: fs::File,
}

impl Drop for ProfileCacheLock {
    fn drop(&mut self) {
        // Closing alone retains the lock while a duplicated/inherited handle is open.
        let _ = fs4::FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod profile_lock_tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn dropped_profile_lock_releases_with_duplicate_handle() {
        let workspace = tempfile::tempdir().unwrap();
        let directory = ValidatedCacheDirectory {
            profile_directory: fs::canonicalize(workspace.path()).unwrap(),
        };
        let first_lock = acquire_profile_cache_lock_with(
            &directory,
            Duration::ZERO,
            Duration::from_millis(1),
            || {},
        )
        .await
        .unwrap();
        let duplicate = first_lock.file.try_clone().unwrap();
        drop(first_lock);

        let reacquired = acquire_profile_cache_lock_with(
            &directory,
            Duration::ZERO,
            Duration::from_millis(1),
            || {},
        )
        .await
        .expect("guard drop must unlock even while a duplicate handle remains open");
        drop(reacquired);
        drop(duplicate);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DerivedProfile {
    pub(crate) directory_name: &'static str,
    pub(crate) proxy_max_width: u64,
    pub(crate) proxy_max_height: u64,
    pub(crate) scale_flags: &'static str,
    pub(crate) proxy_video_encoder: &'static str,
    pub(crate) proxy_video_encoder_color_range: &'static str,
    pub(crate) proxy_preset: &'static str,
    pub(crate) proxy_crf: u8,
    pub(crate) proxy_pixel_format: &'static str,
    pub(crate) proxy_sample_aspect_ratio: &'static str,
    pub(crate) proxy_color_range: &'static str,
    pub(crate) proxy_color_space: &'static str,
    pub(crate) proxy_color_primaries: &'static str,
    pub(crate) proxy_color_transfer: &'static str,
    pub(crate) proxy_hdr_linear_transfer: &'static str,
    pub(crate) proxy_hdr_nominal_peak_luminance: &'static str,
    pub(crate) proxy_hdr_intermediate_pixel_format: &'static str,
    pub(crate) proxy_hdr_tonemap: &'static str,
    pub(crate) proxy_hdr_tonemap_desaturation: &'static str,
    pub(crate) proxy_hdr_signal_peak: &'static str,
    pub(crate) proxy_hdr_dither: &'static str,
    pub(crate) proxy_movflags: &'static str,
    pub(crate) proxy_audio_encoder: &'static str,
    pub(crate) proxy_audio_bitrate: &'static str,
    pub(crate) proxy_audio_sample_rate: u64,
    pub(crate) thumbnail_count: u64,
    pub(crate) thumbnail_cell_width: u64,
    pub(crate) thumbnail_cell_height: u64,
    pub(crate) thumbnail_pad_color: &'static str,
    pub(crate) thumbnail_tile_layout: &'static str,
    pub(crate) thumbnail_encoder: &'static str,
    pub(crate) thumbnail_quality: u8,
}

pub(crate) const PREVIEW_PROFILE: DerivedProfile = DerivedProfile {
    directory_name: "preview-v1",
    proxy_max_width: 1280,
    proxy_max_height: 720,
    scale_flags: "lanczos",
    proxy_video_encoder: "libx264",
    proxy_video_encoder_color_range: "limited",
    proxy_preset: "medium",
    proxy_crf: 23,
    proxy_pixel_format: "yuv420p",
    proxy_sample_aspect_ratio: "1",
    proxy_color_range: "tv",
    proxy_color_space: "bt709",
    proxy_color_primaries: "bt709",
    proxy_color_transfer: "bt709",
    proxy_hdr_linear_transfer: "linear",
    proxy_hdr_nominal_peak_luminance: "100",
    proxy_hdr_intermediate_pixel_format: "gbrpf32le",
    proxy_hdr_tonemap: "hable",
    proxy_hdr_tonemap_desaturation: "2",
    proxy_hdr_signal_peak: "10",
    proxy_hdr_dither: "error_diffusion",
    proxy_movflags: "+faststart",
    proxy_audio_encoder: "aac",
    proxy_audio_bitrate: "192k",
    proxy_audio_sample_rate: 48_000,
    thumbnail_count: 10,
    thumbnail_cell_width: 160,
    thumbnail_cell_height: 90,
    thumbnail_pad_color: "black",
    thumbnail_tile_layout: "10x1",
    thumbnail_encoder: "mjpeg",
    thumbnail_quality: 2,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DerivedArtifactKind {
    Proxy,
    ThumbnailTile,
}

impl DerivedArtifactKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Proxy => "proxy",
            Self::ThumbnailTile => "thumbnail_tile",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaProfileIdentityV1 {
    pub schema_version: u64,
    pub profile_id: String,
    pub profile_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedMediaIdentityV1 {
    pub schema_version: u64,
    pub artifact_kind: DerivedArtifactKind,
    pub key: String,
    pub source_identity: MediaContentIdentityV1,
    pub toolchain_id: String,
    pub profile_identity: MediaProfileIdentityV1,
    pub recipe_digest: String,
}

#[derive(Debug)]
pub(crate) struct PrepareAssetCoreRequest<'a> {
    pub(crate) owner_label: &'a str,
    pub(crate) project_id: &'a str,
    pub(crate) asset_id: &'a str,
    pub(crate) source_path: &'a Path,
    pub(crate) sequence_rate: Option<RationalRate>,
    pub(crate) expected_content_identity: Option<MediaContentIdentityV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedAssetPlan {
    cache_root: PathBuf,
    object_path: PathBuf,
    source_fingerprint: super::media_store::SourceFingerprintV1,
    source_identity: MediaContentIdentityV1,
    source_probe: MediaProbe,
    sequence_rate: RationalRate,
    profile_identity: MediaProfileIdentityV1,
    proxy_identity: DerivedMediaIdentityV1,
    thumbnail_identity: DerivedMediaIdentityV1,
    dimensions: OutputDimensions,
    source_is_hdr: bool,
    source_video_stream_index: u64,
    source_audio_stream_index: Option<u64>,
    source_has_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProxyChildResult {
    path: String,
    probe: MediaProbe,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThumbnailChildResult {
    path: String,
}

impl PreparedAssetPlan {
    fn finish(
        self,
        proxy: ProxyChildResult,
        thumbnail: ThumbnailChildResult,
    ) -> PreparedVideoAsset {
        PreparedVideoAsset {
            source_fingerprint: self.source_fingerprint,
            source_identity: self.source_identity,
            source_probe: self.source_probe,
            sequence_rate: self.sequence_rate,
            profile_identity: self.profile_identity,
            proxy_identity: self.proxy_identity,
            proxy_path: proxy.path,
            proxy_probe: proxy.probe,
            thumbnail_identity: self.thumbnail_identity,
            thumbnail_path: thumbnail.path,
        }
    }
}

struct ProxyPreparationWorker {
    plan: Arc<PreparedAssetPlan>,
    programs: MediaPrograms,
    cache: MediaCacheService,
    owner_label: String,
    project_id: String,
}

impl MediaJobWorker for ProxyPreparationWorker {
    fn run(&self, _job_id: String, cancellation: ProcessCancellation) -> MediaWorkerFuture {
        let plan = self.plan.clone();
        let programs = self.programs.clone();
        let cache = self.cache.clone();
        let owner_label = self.owner_label.clone();
        let project_id = self.project_id.clone();
        Box::pin(async move {
            match execute_proxy_child(
                &plan,
                &programs,
                cancellation,
                Some(PublicationContext {
                    cache: &cache,
                    owner_label: &owner_label,
                    project_id: &project_id,
                }),
            )
            .await
            {
                Ok(result) => MediaWorkerOutcome::Complete {
                    result: serde_json::to_value(&result).unwrap_or(serde_json::Value::Null),
                    progress: MediaJobProgress {
                        completed: 1,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                },
                Err(error) if error.code == VideoErrorCode::ProcessCancelled => {
                    MediaWorkerOutcome::Cancelled {
                        progress: MediaJobProgress {
                            completed: 0,
                            total: 1,
                            unit: MediaJobProgressUnit::Items,
                        },
                    }
                }
                Err(error) => MediaWorkerOutcome::Failed {
                    error: media_job_error_from_video(&error),
                    progress: MediaJobProgress {
                        completed: 0,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                },
            }
        })
    }
}

struct ThumbnailPreparationWorker {
    plan: Arc<PreparedAssetPlan>,
    programs: MediaPrograms,
    cache: MediaCacheService,
    owner_label: String,
    project_id: String,
}

impl MediaJobWorker for ThumbnailPreparationWorker {
    fn run(&self, _job_id: String, cancellation: ProcessCancellation) -> MediaWorkerFuture {
        let plan = self.plan.clone();
        let programs = self.programs.clone();
        let cache = self.cache.clone();
        let owner_label = self.owner_label.clone();
        let project_id = self.project_id.clone();
        Box::pin(async move {
            match execute_thumbnail_child(
                &plan,
                &programs,
                cancellation,
                Some(PublicationContext {
                    cache: &cache,
                    owner_label: &owner_label,
                    project_id: &project_id,
                }),
            )
            .await
            {
                Ok(result) => MediaWorkerOutcome::Complete {
                    result: serde_json::to_value(&result).unwrap_or(serde_json::Value::Null),
                    progress: MediaJobProgress {
                        completed: 1,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                },
                Err(error) if error.code == VideoErrorCode::ProcessCancelled => {
                    MediaWorkerOutcome::Cancelled {
                        progress: MediaJobProgress {
                            completed: 0,
                            total: 1,
                            unit: MediaJobProgressUnit::Items,
                        },
                    }
                }
                Err(error) => MediaWorkerOutcome::Failed {
                    error: media_job_error_from_video(&error),
                    progress: MediaJobProgress {
                        completed: 0,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                },
            }
        })
    }
}

struct DurablePreparationDescriptor {
    plan: Arc<PreparedAssetPlan>,
    owner_label: String,
    project_id: String,
}

fn durable_preparation_descriptor(
    stored: &StoredPrivateJob,
    expected_owner: Option<&str>,
) -> Result<DurablePreparationDescriptor, VideoCommandError> {
    if stored.payload_version != 1
        || !matches!(
            stored.public.kind,
            MediaJobKind::Proxy | MediaJobKind::ThumbnailTile
        )
        || stored
            .private_payload
            .get("canonicalObjectAvailable")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
    {
        return Err(VideoCommandError::project_io(
            "prepare_asset",
            "job_payload_version",
        ));
    }
    let owner_label = stored
        .private_payload
        .get("ownerLabel")
        .and_then(serde_json::Value::as_str)
        .filter(|owner| !owner.is_empty())
        .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "job_owner"))?
        .to_owned();
    if expected_owner.is_some_and(|expected| expected != owner_label) {
        return Err(VideoCommandError::project_io("prepare_asset", "job_owner"));
    }
    let payload_project_id = stored
        .private_payload
        .get("projectId")
        .and_then(serde_json::Value::as_str);
    let project_id = stored
        .public
        .project_id
        .as_deref()
        .filter(|project_id| Some(*project_id) == payload_project_id)
        .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "job_project"))?
        .to_owned();
    let plan = serde_json::from_value(
        stored
            .private_payload
            .get("plan")
            .cloned()
            .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "job_payload"))?,
    )
    .map_err(|_| VideoCommandError::project_io("prepare_asset", "job_payload"))?;
    Ok(DurablePreparationDescriptor {
        plan: Arc::new(plan),
        owner_label,
        project_id,
    })
}

pub(crate) fn preparation_worker_from_durable_job(
    stored: &StoredPrivateJob,
    expected_owner: &str,
    programs: MediaPrograms,
    cache: MediaCacheService,
) -> Result<Arc<dyn MediaJobWorker>, VideoCommandError> {
    let descriptor = durable_preparation_descriptor(stored, Some(expected_owner))?;
    preparation_worker(
        stored.public.kind,
        descriptor.plan,
        programs,
        cache,
        descriptor.owner_label,
        descriptor.project_id,
    )
}

fn preparation_worker(
    kind: MediaJobKind,
    plan: Arc<PreparedAssetPlan>,
    programs: MediaPrograms,
    cache: MediaCacheService,
    owner_label: String,
    project_id: String,
) -> Result<Arc<dyn MediaJobWorker>, VideoCommandError> {
    match kind {
        MediaJobKind::Proxy => Ok(Arc::new(ProxyPreparationWorker {
            plan,
            programs,
            cache,
            owner_label,
            project_id,
        })),
        MediaJobKind::ThumbnailTile => Ok(Arc::new(ThumbnailPreparationWorker {
            plan,
            programs,
            cache,
            owner_label,
            project_id,
        })),
        _ => Err(VideoCommandError::project_io("prepare_asset", "job_kind")),
    }
}

pub(crate) async fn resume_durable_preparations(
    jobs: &MediaJobService,
    programs: MediaPrograms,
) -> Result<(), VideoCommandError> {
    resume_durable_preparations_with_factory(
        jobs,
        programs,
        true,
        |kind, plan, programs, cache, owner_label, project_id| {
            preparation_worker(kind, plan, programs, cache, owner_label, project_id)
        },
    )
    .await
}

#[cfg(test)]
pub(crate) type TestPreparationWorkerFactory =
    Arc<dyn Fn(MediaJobKind) -> Arc<dyn MediaJobWorker> + Send + Sync>;

#[cfg(test)]
pub(crate) async fn resume_durable_preparations_with_test_workers(
    jobs: &MediaJobService,
    programs: MediaPrograms,
    worker_factory: TestPreparationWorkerFactory,
) -> Result<(), VideoCommandError> {
    resume_durable_preparations_with_factory(
        jobs,
        programs,
        false,
        move |kind, _plan, _programs, _cache, _owner_label, _project_id| Ok(worker_factory(kind)),
    )
    .await
}

#[cfg(test)]
pub(crate) fn prepared_asset_plan_fixture(cache_root: &Path) -> serde_json::Value {
    use super::types::{MediaAudioShape, MediaContentAlgorithm};

    let source_identity = MediaContentIdentityV1 {
        schema_version: 1,
        algorithm: MediaContentAlgorithm::Sha256,
        digest: "01".repeat(32),
        byte_length: 4_096,
    };
    let profile_identity = derive_profile_identity(&PREVIEW_PROFILE)
        .expect("test preview profile identity must derive");
    let proxy_identity = derive_media_identity(
        DerivedArtifactKind::Proxy,
        &source_identity,
        "test-recovery-toolchain",
        &profile_identity,
        &"02".repeat(32),
    )
    .expect("test proxy identity must derive");
    let thumbnail_identity = derive_media_identity(
        DerivedArtifactKind::ThumbnailTile,
        &source_identity,
        "test-recovery-toolchain",
        &profile_identity,
        &"03".repeat(32),
    )
    .expect("test thumbnail identity must derive");
    let rate = RationalRate {
        numerator: 30,
        denominator: 1,
    };
    let source_probe = MediaProbe {
        duration_microseconds: 2_000_000,
        average_frame_rate: rate.clone(),
        real_frame_rate: rate.clone(),
        variable_frame_rate: false,
        width: 320,
        height: 180,
        video_codec_name: "h264".to_owned(),
        audio: Some(MediaAudioShape {
            codec_name: "aac".to_owned(),
            channels: 2,
            sample_rate: 48_000,
        }),
        file_size_bytes: 4_096,
    };
    serde_json::to_value(PreparedAssetPlan {
        cache_root: cache_root.to_path_buf(),
        object_path: cache_root.join("recovery-object.mp4"),
        source_fingerprint: super::media_store::SourceFingerprintV1 {
            schema_version: 1,
            algorithm: MediaContentAlgorithm::Sha256,
            digest: "04".repeat(32),
            byte_length: 4_096,
            modified_unix_seconds: 1,
            modified_nanoseconds: 0,
        },
        source_identity,
        source_probe,
        sequence_rate: rate,
        profile_identity,
        proxy_identity,
        thumbnail_identity,
        dimensions: OutputDimensions {
            width: 320,
            height: 180,
        },
        source_is_hdr: false,
        source_video_stream_index: 0,
        source_audio_stream_index: Some(1),
        source_has_audio: true,
    })
    .expect("test prepared asset plan must serialize")
}

async fn resume_durable_preparations_with_factory<WorkerFactory>(
    jobs: &MediaJobService,
    programs: MediaPrograms,
    pin_source: bool,
    worker_factory: WorkerFactory,
) -> Result<(), VideoCommandError>
where
    WorkerFactory: Fn(
        MediaJobKind,
        Arc<PreparedAssetPlan>,
        MediaPrograms,
        MediaCacheService,
        String,
        String,
    ) -> Result<Arc<dyn MediaJobWorker>, VideoCommandError>,
{
    let records = jobs
        .store()
        .recovery_jobs()
        .await
        .map_err(map_job_store_error)?;
    for parent in records.iter().filter(|record| {
        record.kind == MediaJobKind::AssetPreparation && record.state == MediaJobState::Queued
    }) {
        if let Err(_error) =
            recover_durable_preparation_parent(jobs, &programs, parent, pin_source, &worker_factory)
                .await
        {
            persist_preparation_recovery_failure(jobs, &parent.id)
                .await
                .map_err(map_job_store_error)?;
            #[cfg(test)]
            eprintln!(
                "durable preview preparation recovery failed for {}: {:?}",
                parent.id, _error
            );
        }
    }
    Ok(())
}

async fn recover_durable_preparation_parent<WorkerFactory>(
    jobs: &MediaJobService,
    programs: &MediaPrograms,
    parent: &super::jobs::model::MediaJobRecord,
    pin_source: bool,
    worker_factory: &WorkerFactory,
) -> Result<(), VideoCommandError>
where
    WorkerFactory: Fn(
        MediaJobKind,
        Arc<PreparedAssetPlan>,
        MediaPrograms,
        MediaCacheService,
        String,
        String,
    ) -> Result<Arc<dyn MediaJobWorker>, VideoCommandError>,
{
    let stored = jobs
        .store()
        .get_private(parent.id.clone())
        .await
        .map_err(map_job_store_error)?;
    if stored
        .private_payload
        .get("canonicalObjectAvailable")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err(VideoCommandError::project_io(
            "prepare_asset",
            "recovery_plan_unavailable",
        ));
    }
    let plan: PreparedAssetPlan = serde_json::from_value(
        stored
            .private_payload
            .get("plan")
            .cloned()
            .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "job_payload"))?,
    )
    .map_err(|_| VideoCommandError::project_io("prepare_asset", "job_payload"))?;
    let owner_label = stored
        .private_payload
        .get("ownerLabel")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("recovered-media-job")
        .to_owned();
    let project_id = parent
        .project_id
        .clone()
        .or_else(|| {
            stored
                .private_payload
                .get("projectId")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "recovery_association"))?;
    let shared_plan = Arc::new(plan);
    if pin_source {
        lease_preparation_source(
            &shared_plan,
            PublicationContext {
                cache: jobs.cache(),
                owner_label: &owner_label,
                project_id: &project_id,
            },
        )
        .await?;
    }
    #[cfg(test)]
    programs.before_source_use().await;

    // Materialize both children before either is scheduled. Enqueue dedupe makes this
    // restart-safe at every crash boundary between parent persistence and dispatch.
    let proxy_job = enqueue_preparation_child(
        jobs,
        PreparationChildRequest {
            parent_id: &parent.id,
            kind: MediaJobKind::Proxy,
            dedupe_key: preparation_child_dedupe_key(
                MediaJobKind::Proxy,
                &shared_plan,
                &parent.id,
            )?,
            summary: "Build preview proxy",
            owner_label: owner_label.clone(),
            project_id: parent.project_id.clone(),
            asset_id: parent.asset_id.clone(),
            plan: &shared_plan,
        },
    )
    .await?;
    let thumbnail_job = enqueue_preparation_child(
        jobs,
        PreparationChildRequest {
            parent_id: &parent.id,
            kind: MediaJobKind::ThumbnailTile,
            dedupe_key: preparation_child_dedupe_key(
                MediaJobKind::ThumbnailTile,
                &shared_plan,
                &parent.id,
            )?,
            summary: "Build preview thumbnails",
            owner_label: owner_label.clone(),
            project_id: parent.project_id.clone(),
            asset_id: parent.asset_id.clone(),
            plan: &shared_plan,
        },
    )
    .await?;

    let proxy_was_complete = proxy_job.state == MediaJobState::Complete;
    let thumbnail_was_complete = thumbnail_job.state == MediaJobState::Complete;
    for child in [&proxy_job, &thumbnail_job] {
        if child.parent_id.as_deref() != Some(parent.id.as_str()) {
            return Err(VideoCommandError::project_io(
                "prepare_asset",
                "recovery_child_association",
            ));
        }
    }

    jobs.store()
        .transition(
            parent.id.clone(),
            MediaJobTransition {
                state: MediaJobState::Running,
                stage: "recovered".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 2,
                    unit: MediaJobProgressUnit::Stages,
                },
                attempt: None,
                error: None,
                retry_at_ms: None,
                result: None,
                cancellation_requested: false,
                event_type: MediaJobEventType::Recovered,
                message: Some("Preview preparation resumed after restart.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await
        .map_err(map_job_store_error)?;

    for child in [&proxy_job, &thumbnail_job] {
        if child.state == MediaJobState::Queued {
            let stored_child = jobs
                .store()
                .get_private(child.id.clone())
                .await
                .map_err(map_job_store_error)?;
            let descriptor = durable_preparation_descriptor(&stored_child, Some(&owner_label))?;
            if descriptor.project_id != project_id {
                return Err(VideoCommandError::project_io(
                    "prepare_asset",
                    "recovery_child_association",
                ));
            }
            let worker = worker_factory(
                child.kind,
                descriptor.plan,
                programs.clone(),
                jobs.cache().clone(),
                descriptor.owner_label,
                descriptor.project_id,
            )?;
            jobs.scheduler()
                .submit(
                    child.id.clone(),
                    child.priority,
                    child.attempt,
                    child.max_attempts,
                    SchedulerResource::Ffmpeg,
                    worker,
                )
                .await
                .map_err(map_job_store_error)?;
        }
    }

    let proxy = if proxy_was_complete {
        validate_recovered_proxy_artifact(jobs, &shared_plan, programs, &owner_label, &project_id)
            .await?
    } else {
        wait_for_job_result(jobs, &proxy_job.id).await?
    };
    let thumbnail = if thumbnail_was_complete {
        validate_recovered_thumbnail_artifact(
            jobs,
            &shared_plan,
            programs,
            &owner_label,
            &project_id,
        )
        .await?
    } else {
        wait_for_job_result(jobs, &thumbnail_job.id).await?
    };
    let prepared = Arc::unwrap_or_clone(shared_plan).finish(proxy, thumbnail);
    jobs.cache()
        .enforce_budget()
        .await
        .map_err(map_job_store_error)?;
    complete_recovered_preparation(jobs, &parent.id, &prepared).await
}

async fn validate_recovered_proxy_artifact(
    jobs: &MediaJobService,
    plan: &PreparedAssetPlan,
    programs: &MediaPrograms,
    owner_label: &str,
    project_id: &str,
) -> Result<ProxyChildResult, VideoCommandError> {
    execute_proxy_child(
        plan,
        programs,
        ProcessCancellation::new(),
        Some(PublicationContext {
            cache: jobs.cache(),
            owner_label,
            project_id,
        }),
    )
    .await
}

async fn validate_recovered_thumbnail_artifact(
    jobs: &MediaJobService,
    plan: &PreparedAssetPlan,
    programs: &MediaPrograms,
    owner_label: &str,
    project_id: &str,
) -> Result<ThumbnailChildResult, VideoCommandError> {
    execute_thumbnail_child(
        plan,
        programs,
        ProcessCancellation::new(),
        Some(PublicationContext {
            cache: jobs.cache(),
            owner_label,
            project_id,
        }),
    )
    .await
}

async fn complete_recovered_preparation(
    jobs: &MediaJobService,
    parent_id: &str,
    prepared: &PreparedVideoAsset,
) -> Result<(), VideoCommandError> {
    let current = jobs
        .store()
        .get_private(parent_id.to_owned())
        .await
        .map_err(map_job_store_error)?
        .public;
    if current.state == MediaJobState::Complete {
        return Ok(());
    }
    let result = serde_json::to_value(prepared)
        .map_err(|_| VideoCommandError::project_io("prepare_asset", "job_result"))?;
    jobs.store()
        .transition(
            parent_id.to_owned(),
            MediaJobTransition {
                state: MediaJobState::Complete,
                stage: "complete".to_owned(),
                progress: MediaJobProgress {
                    completed: 2,
                    total: 2,
                    unit: MediaJobProgressUnit::Stages,
                },
                attempt: None,
                error: None,
                retry_at_ms: None,
                result: Some(result),
                cancellation_requested: false,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Preview media ready after restart.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await
        .map_err(map_job_store_error)?;
    Ok(())
}

async fn persist_preparation_recovery_failure(
    jobs: &MediaJobService,
    parent_id: &str,
) -> Result<(), MediaStateStoreError> {
    let current = jobs.store().get_private(parent_id.to_owned()).await?.public;
    if current.state.is_terminal() {
        return Ok(());
    }
    jobs.store()
        .transition(
            parent_id.to_owned(),
            MediaJobTransition {
                state: MediaJobState::Failed,
                stage: "recovery_failed".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 2,
                    unit: MediaJobProgressUnit::Stages,
                },
                attempt: None,
                error: Some(MediaJobError {
                    code: "preparation_recovery_failed".to_owned(),
                    category: MediaJobErrorCategory::IntegrityFailed,
                    message: "Preview preparation could not be recovered.".to_owned(),
                    retryable: false,
                    action: Some(MediaJobRecoveryAction::Retry),
                }),
                retry_at_ms: None,
                result: None,
                cancellation_requested: false,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Preview preparation could not be recovered.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await
        .map(|_| ())
}

#[cfg(test)]
type SourceUseGate = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);

#[derive(Debug, Clone)]
pub(crate) struct MediaPrograms {
    source: MediaProgramSource,
    #[cfg(test)]
    pub(crate) source_use_gate: Arc<tokio::sync::Mutex<Option<SourceUseGate>>>,
}

#[derive(Debug, Clone)]
enum MediaProgramSource {
    Bundled(Arc<MediaToolchainState>),
    #[cfg(test)]
    Explicit {
        ffmpeg: OsString,
        ffprobe: OsString,
        toolchain_id: String,
    },
}

impl MediaPrograms {
    #[cfg(test)]
    async fn before_source_use(&self) {
        let gate = self.source_use_gate.lock().await.take();
        if let Some((entered, resume)) = gate {
            let _ = entered.send(());
            let _ = tokio::time::timeout(Duration::from_secs(30), resume).await;
        }
    }

    pub(crate) fn bundled(toolchain: MediaToolchainState) -> Self {
        Self {
            source: MediaProgramSource::Bundled(Arc::new(toolchain)),
            #[cfg(test)]
            source_use_gate: Default::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn explicit(ffmpeg: OsString, ffprobe: OsString) -> Self {
        Self::explicit_for_toolchain(ffmpeg, ffprobe, "test-explicit-programs")
    }

    #[cfg(test)]
    pub(crate) fn explicit_for_toolchain(
        ffmpeg: OsString,
        ffprobe: OsString,
        toolchain_id: impl Into<String>,
    ) -> Self {
        Self {
            source_use_gate: Default::default(),
            source: MediaProgramSource::Explicit {
                ffmpeg,
                ffprobe,
                toolchain_id: toolchain_id.into(),
            },
        }
    }

    pub(crate) fn toolchain_id(&self) -> &str {
        match &self.source {
            MediaProgramSource::Bundled(toolchain) => toolchain.toolchain_id(),
            #[cfg(test)]
            MediaProgramSource::Explicit { toolchain_id, .. } => toolchain_id,
        }
    }

    pub(crate) async fn verified_ffmpeg(
        &self,
        operation: &'static str,
    ) -> Result<OsString, VideoCommandError> {
        match &self.source {
            MediaProgramSource::Bundled(toolchain) => toolchain
                .verified_ffmpeg()
                .await
                .map(PathBuf::into_os_string)
                .map_err(|error| error.into_command_error(operation)),
            #[cfg(test)]
            MediaProgramSource::Explicit { ffmpeg, .. } => Ok(ffmpeg.clone()),
        }
    }

    pub(crate) async fn verified_ffprobe(
        &self,
        operation: &'static str,
    ) -> Result<OsString, VideoCommandError> {
        match &self.source {
            MediaProgramSource::Bundled(toolchain) => toolchain
                .verified_ffprobe()
                .await
                .map(PathBuf::into_os_string)
                .map_err(|error| error.into_command_error(operation)),
            #[cfg(test)]
            MediaProgramSource::Explicit { ffprobe, .. } => Ok(ffprobe.clone()),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ProxyValidationExpectation<'a> {
    dimensions: OutputDimensions,
    sequence_rate: &'a RationalRate,
    source_duration_microseconds: u64,
    source_has_audio: bool,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn video_prepare_asset<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    projects: State<'_, VideoProjectService>,
    toolchain: State<'_, MediaToolchainState>,
    jobs: State<'_, MediaJobService>,
    project_id: String,
    asset_id: String,
    path: String,
    sequence_rate: Option<RationalRate>,
) -> Result<PreparedVideoAsset, VideoCommandError> {
    validated_uuid_segment(&project_id)
        .ok_or_else(|| VideoCommandError::invalid_path("prepare_asset", "project_id"))?;
    validated_uuid_segment(&asset_id)
        .ok_or_else(|| VideoCommandError::invalid_path("prepare_asset", "asset_id"))?;
    let expected_content_identity =
        projects.asset_content_identity(window.label(), &project_id, &asset_id)?;
    let cache_root = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| VideoCommandError::project_io("prepare_asset", "app_cache"))?;
    let programs = MediaPrograms::bundled(toolchain.inner().clone());
    prepare_asset_durable(
        PrepareAssetCoreRequest {
            owner_label: window.label(),
            project_id: &project_id,
            asset_id: &asset_id,
            source_path: Path::new(&path),
            sequence_rate,
            expected_content_identity,
        },
        &grants,
        &cache_root,
        programs,
        &jobs,
    )
    .await
}

pub(crate) async fn prepare_asset_durable(
    request: PrepareAssetCoreRequest<'_>,
    grants: &VideoPathGrants,
    cache_root: &Path,
    programs: MediaPrograms,
    jobs: &MediaJobService,
) -> Result<PreparedVideoAsset, VideoCommandError> {
    let created_at_ms = current_timestamp_millis();
    let owner_label = request.owner_label.to_owned();
    let association_project_id = request.project_id.to_owned();
    let dedupe_key = preparation_dedupe_key(&request);
    let parent = jobs
        .store()
        .enqueue(NewMediaJob {
            kind: MediaJobKind::AssetPreparation,
            parent_id: None,
            dedupe_key,
            project_id: Some(request.project_id.to_owned()),
            asset_id: Some(request.asset_id.to_owned()),
            revision_id: None,
            priority: MediaJobPriority::Interactive,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: 2,
                unit: MediaJobProgressUnit::Stages,
            },
            max_attempts: 3,
            summary: "Prepare media asset".to_owned(),
            private_payload: serde_json::json!({
                "canonicalObjectAvailable": false,
                "ownerLabel": owner_label.clone(),
                "projectId": association_project_id.clone(),
                "sourcePath": request.source_path,
            }),
            created_at_ms,
        })
        .await
        .map_err(map_job_store_error)?;
    if parent.reused {
        match parent.job.state {
            MediaJobState::Complete => {
                match completed_prepared_asset_result(jobs, &parent.job.id, &programs).await? {
                    CompletedPreparationReuse::Ready(prepared) => return Ok(*prepared),
                    CompletedPreparationReuse::Rebuild => {
                        jobs.store()
                            .remove_stale_completed_preparation(parent.job.id)
                            .await
                            .map_err(map_job_store_error)?;
                        return Box::pin(prepare_asset_durable(
                            request, grants, cache_root, programs, jobs,
                        ))
                        .await;
                    }
                }
            }
            MediaJobState::Blocked => {
                jobs.store()
                    .transition(
                        parent.job.id.clone(),
                        MediaJobTransition {
                            state: MediaJobState::Queued,
                            stage: "queued".to_owned(),
                            progress: MediaJobProgress {
                                completed: 0,
                                total: 2,
                                unit: MediaJobProgressUnit::Stages,
                            },
                            attempt: None,
                            error: None,
                            retry_at_ms: None,
                            result: None,
                            cancellation_requested: false,
                            event_type: MediaJobEventType::StateChanged,
                            message: Some("Preparation authorization restored.".to_owned()),
                            occurred_at_ms: current_timestamp_millis(),
                        },
                    )
                    .await
                    .map_err(map_job_store_error)?;
            }
            MediaJobState::Queued => {}
            _ => return wait_for_job_result(jobs, &parent.job.id).await,
        }
    }

    jobs.store()
        .transition(
            parent.job.id.clone(),
            MediaJobTransition {
                state: MediaJobState::Probing,
                stage: "probing".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 2,
                    unit: MediaJobProgressUnit::Stages,
                },
                attempt: Some(parent.job.attempt.saturating_add(1)),
                error: None,
                retry_at_ms: None,
                result: None,
                cancellation_requested: false,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Inspecting source media.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await
        .map_err(map_job_store_error)?;

    let plan = match plan_asset_core(
        request,
        grants,
        cache_root,
        &programs,
        Some(PublicationContext {
            cache: jobs.cache(),
            owner_label: &owner_label,
            project_id: &association_project_id,
        }),
    )
    .await
    {
        Ok(plan) => plan,
        Err(error) => {
            settle_preparation_error(jobs, &parent.job.id, &error).await;
            return Err(error);
        }
    };
    jobs.store()
        .replace_private_payload(
            parent.job.id.clone(),
            serde_json::json!({
                "canonicalObjectAvailable": true,
                "ownerLabel": owner_label,
                "projectId": association_project_id,
                "plan": plan,
            }),
        )
        .await
        .map_err(map_job_store_error)?;
    jobs.store()
        .transition(
            parent.job.id.clone(),
            MediaJobTransition {
                state: MediaJobState::Running,
                stage: "derived_media".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 2,
                    unit: MediaJobProgressUnit::Stages,
                },
                attempt: None,
                error: None,
                retry_at_ms: None,
                result: None,
                cancellation_requested: false,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Preparing preview media.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await
        .map_err(map_job_store_error)?;

    let shared_plan = Arc::new(plan);
    let proxy_job = enqueue_preparation_child(
        jobs,
        PreparationChildRequest {
            parent_id: &parent.job.id,
            kind: MediaJobKind::Proxy,
            dedupe_key: preparation_child_dedupe_key(
                MediaJobKind::Proxy,
                &shared_plan,
                &parent.job.id,
            )?,
            summary: "Build preview proxy",
            owner_label: owner_label.clone(),
            project_id: parent.job.project_id.clone(),
            asset_id: parent.job.asset_id.clone(),
            plan: &shared_plan,
        },
    )
    .await?;
    if proxy_job.state == MediaJobState::Queued {
        jobs.scheduler()
            .submit(
                proxy_job.id.clone(),
                MediaJobPriority::Interactive,
                proxy_job.attempt,
                proxy_job.max_attempts,
                SchedulerResource::Ffmpeg,
                Arc::new(ProxyPreparationWorker {
                    plan: shared_plan.clone(),
                    programs: programs.clone(),
                    cache: jobs.cache().clone(),
                    owner_label: owner_label.clone(),
                    project_id: association_project_id.clone(),
                }),
            )
            .await
            .map_err(map_job_store_error)?;
    }

    let thumbnail_job = enqueue_preparation_child(
        jobs,
        PreparationChildRequest {
            parent_id: &parent.job.id,
            kind: MediaJobKind::ThumbnailTile,
            dedupe_key: preparation_child_dedupe_key(
                MediaJobKind::ThumbnailTile,
                &shared_plan,
                &parent.job.id,
            )?,
            summary: "Build preview thumbnails",
            owner_label: owner_label.clone(),
            project_id: parent.job.project_id.clone(),
            asset_id: parent.job.asset_id.clone(),
            plan: &shared_plan,
        },
    )
    .await?;
    if thumbnail_job.state == MediaJobState::Queued {
        jobs.scheduler()
            .submit(
                thumbnail_job.id.clone(),
                MediaJobPriority::Interactive,
                thumbnail_job.attempt,
                thumbnail_job.max_attempts,
                SchedulerResource::Ffmpeg,
                Arc::new(ThumbnailPreparationWorker {
                    plan: shared_plan.clone(),
                    programs: programs.clone(),
                    cache: jobs.cache().clone(),
                    owner_label: owner_label.clone(),
                    project_id: association_project_id.clone(),
                }),
            )
            .await
            .map_err(map_job_store_error)?;
    }

    let proxy: ProxyChildResult = match wait_for_job_result(jobs, &proxy_job.id).await {
        Ok(proxy) => proxy,
        Err(error) => {
            settle_preparation_error(jobs, &parent.job.id, &error).await;
            return Err(error);
        }
    };
    jobs.store()
        .transition(
            parent.job.id.clone(),
            MediaJobTransition {
                state: MediaJobState::Running,
                stage: "thumbnail".to_owned(),
                progress: MediaJobProgress {
                    completed: 1,
                    total: 2,
                    unit: MediaJobProgressUnit::Stages,
                },
                attempt: None,
                error: None,
                retry_at_ms: None,
                result: None,
                cancellation_requested: false,
                event_type: MediaJobEventType::Progress,
                message: Some("Preview proxy ready.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await
        .map_err(map_job_store_error)?;
    let thumbnail: ThumbnailChildResult = match wait_for_job_result(jobs, &thumbnail_job.id).await {
        Ok(thumbnail) => thumbnail,
        Err(error) => {
            settle_preparation_error(jobs, &parent.job.id, &error).await;
            return Err(error);
        }
    };
    let prepared = Arc::unwrap_or_clone(shared_plan).finish(proxy, thumbnail);
    jobs.cache()
        .enforce_budget()
        .await
        .map_err(map_job_store_error)?;
    let result = serde_json::to_value(&prepared)
        .map_err(|_| VideoCommandError::project_io("prepare_asset", "job_result"))?;
    jobs.store()
        .transition(
            parent.job.id,
            MediaJobTransition {
                state: MediaJobState::Complete,
                stage: "complete".to_owned(),
                progress: MediaJobProgress {
                    completed: 2,
                    total: 2,
                    unit: MediaJobProgressUnit::Stages,
                },
                attempt: None,
                error: None,
                retry_at_ms: None,
                result: Some(result),
                cancellation_requested: false,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Preview media ready.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await
        .map_err(map_job_store_error)?;
    Ok(prepared)
}

fn preparation_child_dedupe_key(
    kind: MediaJobKind,
    plan: &PreparedAssetPlan,
    parent_id: &str,
) -> Result<String, VideoCommandError> {
    match kind {
        MediaJobKind::Proxy => Ok(format!("proxy:{}:{parent_id}", plan.proxy_identity.key)),
        MediaJobKind::ThumbnailTile => Ok(format!(
            "thumbnail:{}:{parent_id}",
            plan.thumbnail_identity.key
        )),
        _ => Err(VideoCommandError::project_io("prepare_asset", "job_kind")),
    }
}

struct PreparationChildRequest<'a> {
    parent_id: &'a str,
    kind: MediaJobKind,
    dedupe_key: String,
    summary: &'a str,
    owner_label: String,
    project_id: Option<String>,
    asset_id: Option<String>,
    plan: &'a PreparedAssetPlan,
}

async fn enqueue_preparation_child(
    jobs: &MediaJobService,
    request: PreparationChildRequest<'_>,
) -> Result<super::jobs::model::MediaJobRecord, VideoCommandError> {
    jobs.store()
        .enqueue(NewMediaJob {
            kind: request.kind,
            parent_id: Some(request.parent_id.to_owned()),
            dedupe_key: request.dedupe_key,
            project_id: request.project_id.clone(),
            asset_id: request.asset_id,
            revision_id: None,
            priority: MediaJobPriority::Interactive,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: 1,
                unit: MediaJobProgressUnit::Items,
            },
            max_attempts: 3,
            summary: request.summary.to_owned(),
            private_payload: serde_json::json!({
                "canonicalObjectAvailable": true,
                "ownerLabel": request.owner_label,
                "projectId": request.project_id,
                "plan": request.plan,
            }),
            created_at_ms: current_timestamp_millis(),
        })
        .await
        .map(|outcome| outcome.job)
        .map_err(map_job_store_error)
}

pub(super) enum CompletedPreparationReuse {
    Ready(Box<PreparedVideoAsset>),
    Rebuild,
}

pub(super) async fn completed_prepared_asset_result(
    jobs: &MediaJobService,
    job_id: &str,
    programs: &MediaPrograms,
) -> Result<CompletedPreparationReuse, VideoCommandError> {
    let stored = jobs
        .store()
        .get_private(job_id.to_owned())
        .await
        .map_err(map_job_store_error)?;
    let prepared = stored
        .result
        .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "job_result"))
        .and_then(|result| {
            serde_json::from_value::<PreparedVideoAsset>(result)
                .map_err(|_| VideoCommandError::project_io("prepare_asset", "job_result"))
        })?;
    let plan = stored
        .private_payload
        .get("plan")
        .cloned()
        .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "job_payload"))
        .and_then(|plan| {
            serde_json::from_value::<PreparedAssetPlan>(plan)
                .map_err(|_| VideoCommandError::project_io("prepare_asset", "job_payload"))
        })?;
    let owner_label = stored
        .private_payload
        .get("ownerLabel")
        .and_then(serde_json::Value::as_str)
        .filter(|owner| !owner.is_empty())
        .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "job_owner"))?
        .to_owned();
    let project_id = stored
        .public
        .project_id
        .or_else(|| {
            stored
                .private_payload
                .get("projectId")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "job_project"))?;
    let registrations = [
        CacheArtifactRegistration {
            key: plan.source_identity.digest.clone(),
            content_digest: plan.source_identity.digest.clone(),
            kind: CacheArtifactKind::SourceObject,
            path: plan.object_path,
            profile_id: None,
            toolchain_id: None,
            recipe_id: None,
        },
        CacheArtifactRegistration {
            key: prepared.proxy_identity.key.clone(),
            content_digest: prepared.proxy_identity.source_identity.digest.clone(),
            kind: CacheArtifactKind::Proxy,
            path: PathBuf::from(&prepared.proxy_path),
            profile_id: Some(prepared.proxy_identity.profile_identity.profile_id.clone()),
            toolchain_id: Some(prepared.proxy_identity.toolchain_id.clone()),
            recipe_id: Some(prepared.proxy_identity.recipe_digest.clone()),
        },
        CacheArtifactRegistration {
            key: prepared.thumbnail_identity.key.clone(),
            content_digest: prepared.thumbnail_identity.source_identity.digest.clone(),
            kind: CacheArtifactKind::ThumbnailTile,
            path: PathBuf::from(&prepared.thumbnail_path),
            profile_id: Some(
                prepared
                    .thumbnail_identity
                    .profile_identity
                    .profile_id
                    .clone(),
            ),
            toolchain_id: Some(prepared.thumbnail_identity.toolchain_id.clone()),
            recipe_id: Some(prepared.thumbnail_identity.recipe_digest.clone()),
        },
    ];
    // Validation pins belong only to this attempt, never to a concurrent caller.
    let attempt_owner = format!("completed-reuse:{}", uuid::Uuid::new_v4());
    let result = async {
        for registration in registrations {
            // One existing artifact lock at a time; never wait for a lock inside a DB transaction.
            let source_lock;
            let artifact_guard;
            if registration.kind == CacheArtifactKind::SourceObject {
                source_lock = Some(acquire_source_lock(&plan.cache_root, &registration.key).await?);
                artifact_guard = None;
            } else {
                source_lock = None;
                let kind = if registration.kind == CacheArtifactKind::Proxy {
                    ArtifactStoreKind::Proxy
                } else {
                    ArtifactStoreKind::ThumbnailTile
                };
                artifact_guard =
                    Some(acquire_artifact(&plan.cache_root, kind, &registration.key).await?);
            }
            match jobs
                .cache()
                .register_and_lease(
                    registration,
                    attempt_owner.clone(),
                    Some(project_id.clone()),
                )
                .await
            {
                Ok(_) => {}
                Err(MediaStateStoreError::Io(_) | MediaStateStoreError::CorruptRecord) => {
                    return Ok(CompletedPreparationReuse::Rebuild)
                }
                Err(error) => return Err(map_job_store_error(error)),
            }
            drop(artifact_guard);
            drop(source_lock);
        }
        let cancellation = ProcessCancellation::new();
        let proxy_expectation = ProxyValidationExpectation {
            dimensions: plan.dimensions,
            sequence_rate: &plan.sequence_rate,
            source_duration_microseconds: plan.source_probe.duration_microseconds,
            source_has_audio: plan.source_has_audio,
        };
        let proxy_is_valid = cached_proxy_probe(
            Path::new(&prepared.proxy_path),
            proxy_expectation,
            programs,
            cancellation.clone(),
        )
        .await?
        .is_some();
        let thumbnail_is_valid =
            cached_thumbnail_is_valid(Path::new(&prepared.thumbnail_path), programs, cancellation)
                .await?;
        if !proxy_is_valid || !thumbnail_is_valid {
            return Ok(CompletedPreparationReuse::Rebuild);
        }
        jobs.cache()
            .transfer_attempt_leases(attempt_owner.clone(), owner_label, project_id)
            .await
            .map_err(map_job_store_error)?;
        Ok(CompletedPreparationReuse::Ready(Box::new(prepared)))
    }
    .await;
    // Covers lock, registration, probe and transfer failures as well as Rebuild.
    if !matches!(&result, Ok(CompletedPreparationReuse::Ready(_))) {
        jobs.cache()
            .release_owner(attempt_owner)
            .await
            .map_err(map_job_store_error)?;
    }
    result
}

async fn wait_for_job_result<T: serde::de::DeserializeOwned>(
    jobs: &MediaJobService,
    job_id: &str,
) -> Result<T, VideoCommandError> {
    let started = Instant::now();
    loop {
        let stored = jobs
            .store()
            .get_private(job_id.to_owned())
            .await
            .map_err(map_job_store_error)?;
        match stored.public.state {
            MediaJobState::Complete => {
                return stored
                    .result
                    .ok_or_else(|| VideoCommandError::project_io("prepare_asset", "job_result"))
                    .and_then(|result| {
                        serde_json::from_value(result).map_err(|_| {
                            VideoCommandError::project_io("prepare_asset", "job_result")
                        })
                    });
            }
            MediaJobState::Blocked | MediaJobState::Failed | MediaJobState::Cancelled => {
                return Err(VideoCommandError::new(
                    VideoErrorCode::ProcessFailed,
                    "Preview preparation did not complete",
                    serde_json::json!({ "operation": "prepare_asset", "category": "media_job" }),
                ));
            }
            _ if started.elapsed() >= PROFILE_CACHE_LOCK_TIMEOUT => {
                return Err(VideoCommandError::project_io(
                    "prepare_asset",
                    "job_timeout",
                ));
            }
            _ => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
}

async fn settle_preparation_error(
    jobs: &MediaJobService,
    parent_id: &str,
    error: &VideoCommandError,
) {
    let job_error = media_job_error_from_video(error);
    let state = if matches!(
        job_error.category,
        MediaJobErrorCategory::AuthorizationRequired
            | MediaJobErrorCategory::ToolchainUnavailable
            | MediaJobErrorCategory::CachePressure
    ) {
        MediaJobState::Blocked
    } else {
        MediaJobState::Failed
    };
    let _ = jobs
        .store()
        .transition(
            parent_id.to_owned(),
            MediaJobTransition {
                state,
                stage: if state == MediaJobState::Blocked {
                    "blocked"
                } else {
                    "failed"
                }
                .to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 2,
                    unit: MediaJobProgressUnit::Stages,
                },
                attempt: None,
                error: Some(job_error),
                retry_at_ms: None,
                result: None,
                cancellation_requested: false,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Preview preparation needs attention.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await;
}

fn preparation_dedupe_key(request: &PrepareAssetCoreRequest<'_>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"supa-video/asset-preparation-job/v1");
    hasher.update(request.project_id.as_bytes());
    hasher.update(request.asset_id.as_bytes());
    if let Some(identity) = request.expected_content_identity.as_ref() {
        hasher.update(identity.digest.as_bytes());
        hasher.update(identity.byte_length.to_le_bytes());
    } else {
        hasher.update(request.source_path.as_os_str().to_string_lossy().as_bytes());
    }
    if let Some(rate) = request.sequence_rate.as_ref() {
        hasher.update(rate.numerator.to_le_bytes());
        hasher.update(rate.denominator.to_le_bytes());
    }
    format!("asset_preparation:{}", hex_sha256(&hasher.finalize()))
}

#[derive(Clone, Copy)]
pub(crate) struct PublicationContext<'a> {
    cache: &'a MediaCacheService,
    owner_label: &'a str,
    project_id: &'a str,
}

async fn lease_preparation_source(
    plan: &PreparedAssetPlan,
    publication: PublicationContext<'_>,
) -> Result<(), VideoCommandError> {
    let guard = super::media_store::acquire_source_object(
        &plan.cache_root,
        &plan.object_path,
        &plan.source_identity,
    )
    .await?;
    publication
        .cache
        .register_and_lease(
            CacheArtifactRegistration {
                key: plan.source_identity.digest.clone(),
                content_digest: plan.source_identity.digest.clone(),
                kind: CacheArtifactKind::SourceObject,
                path: plan.object_path.clone(),
                profile_id: None,
                toolchain_id: None,
                recipe_id: None,
            },
            publication.owner_label.to_owned(),
            Some(publication.project_id.to_owned()),
        )
        .await
        .map_err(map_job_store_error)?;
    // Commit lifetime protection before releasing the source lock; never nest artifact locks.
    drop(guard);
    Ok(())
}

async fn register_derived_artifact(
    cache: &MediaCacheService,
    owner_label: &str,
    project_id: &str,
    kind: CacheArtifactKind,
    identity: &DerivedMediaIdentityV1,
    path: &Path,
) -> Result<(), MediaStateStoreError> {
    cache
        .register_and_lease(
            CacheArtifactRegistration {
                key: identity.key.clone(),
                content_digest: identity.source_identity.digest.clone(),
                kind,
                path: path.to_path_buf(),
                profile_id: Some(identity.profile_identity.profile_id.clone()),
                toolchain_id: Some(identity.toolchain_id.clone()),
                recipe_id: Some(identity.recipe_digest.clone()),
            },
            owner_label.to_owned(),
            Some(project_id.to_owned()),
        )
        .await?;
    Ok(())
}

fn media_job_error_from_video(error: &VideoCommandError) -> MediaJobError {
    let (category, retryable, action, message) = match error.code {
        VideoErrorCode::PathNotGranted => (
            MediaJobErrorCategory::AuthorizationRequired,
            false,
            Some(MediaJobRecoveryAction::ReauthorizeSource),
            "Choose the source again to continue.",
        ),
        VideoErrorCode::ToolUnavailable => (
            MediaJobErrorCategory::ToolchainUnavailable,
            false,
            Some(MediaJobRecoveryAction::VerifyToolchain),
            "The verified media tools are unavailable.",
        ),
        VideoErrorCode::ProjectIo
        | VideoErrorCode::ProcessFailed
        | VideoErrorCode::ProcessTimeout
        | VideoErrorCode::ProcessOutputLimit => (
            MediaJobErrorCategory::TransientIo,
            true,
            Some(MediaJobRecoveryAction::Retry),
            "A temporary media operation failed.",
        ),
        VideoErrorCode::InvalidMedia => (
            MediaJobErrorCategory::InvalidMedia,
            false,
            None,
            "The selected media is invalid.",
        ),
        _ => (
            MediaJobErrorCategory::PolicyRejected,
            false,
            None,
            "Preview preparation could not continue.",
        ),
    };
    MediaJobError {
        code: match category {
            MediaJobErrorCategory::AuthorizationRequired => "source_authorization_required",
            MediaJobErrorCategory::ToolchainUnavailable => "toolchain_unavailable",
            MediaJobErrorCategory::TransientIo => "temporary_media_failure",
            MediaJobErrorCategory::InvalidMedia => "invalid_media",
            _ => "preparation_failed",
        }
        .to_owned(),
        category,
        message: message.to_owned(),
        retryable,
        action,
    }
}

fn map_job_store_error(_error: MediaStateStoreError) -> VideoCommandError {
    #[cfg(test)]
    eprintln!("durable media job store error: {_error:?}");
    VideoCommandError::project_io("prepare_asset", "media_job_state")
}

pub(crate) async fn prepare_asset_core(
    request: PrepareAssetCoreRequest<'_>,
    grants: &VideoPathGrants,
    cache_root: &Path,
    programs: MediaPrograms,
) -> Result<PreparedVideoAsset, VideoCommandError> {
    let plan = plan_asset_core(request, grants, cache_root, &programs, None).await?;
    let cancellation = ProcessCancellation::new();
    let proxy = execute_proxy_child(&plan, &programs, cancellation.clone(), None).await?;
    let thumbnail = execute_thumbnail_child(&plan, &programs, cancellation, None).await?;
    Ok(plan.finish(proxy, thumbnail))
}

pub(crate) async fn plan_asset_core(
    request: PrepareAssetCoreRequest<'_>,
    grants: &VideoPathGrants,
    cache_root: &Path,
    programs: &MediaPrograms,
    publication: Option<PublicationContext<'_>>,
) -> Result<PreparedAssetPlan, VideoCommandError> {
    validated_uuid_segment(request.project_id)
        .ok_or_else(|| VideoCommandError::invalid_path("prepare_asset", "project_id"))?;
    validated_uuid_segment(request.asset_id)
        .ok_or_else(|| VideoCommandError::invalid_path("prepare_asset", "asset_id"))?;
    let requested_rate = request
        .sequence_rate
        .map(|rate| validated_sequence_rate(rate).ok_or(DerivedModelError::SequenceRate))
        .transpose()
        .map_err(map_model_error)?;

    let guarded =
        ingest_source_guarded(request.owner_label, grants, request.source_path, cache_root).await?;
    let source_probe_operation = "prepare_source_probe";
    // Preserve tool-integrity error priority after authorized ingest, before catalog work.
    // Keep the pre-spawn verification below: registration can await while tools change.
    programs.verified_ffprobe(source_probe_operation).await?;
    if let Some(context) = publication {
        let source = &guarded.source;
        context
            .cache
            .register_and_lease(
                CacheArtifactRegistration {
                    key: source.identity.digest.clone(),
                    content_digest: source.identity.digest.clone(),
                    kind: CacheArtifactKind::SourceObject,
                    path: source.object_path.clone(),
                    profile_id: None,
                    toolchain_id: None,
                    recipe_id: None,
                },
                context.owner_label.to_owned(),
                Some(context.project_id.to_owned()),
            )
            .await
            .map_err(map_job_store_error)?;
    }
    let ingested = guarded.into_source();
    let cancellation = ProcessCancellation::new();
    let source_inspected = probe_trusted_media_with_program(
        &ingested.object_path,
        programs.verified_ffprobe(source_probe_operation).await?,
        cancellation,
        source_probe_operation,
    )
    .await?;
    if request
        .expected_content_identity
        .as_ref()
        .is_some_and(|expected| expected != &ingested.identity)
    {
        return Err(VideoCommandError::invalid_media(
            "prepare_asset",
            "source_identity_mismatch",
        ));
    }

    let sequence_rate =
        requested_rate.unwrap_or_else(|| source_inspected.probe.average_frame_rate.clone());
    let input =
        ValidatedDerivedInput::new(request.project_id, request.asset_id, sequence_rate.clone())
            .map_err(map_model_error)?;
    let dimensions = fit_proxy_dimensions_for_display(
        source_inspected.probe.width,
        source_inspected.probe.height,
        &source_inspected.display_shape,
    )
    .map_err(map_model_error)?;
    let source_is_hdr = source_inspected.color.is_hdr();
    let source_video_stream_index = source_inspected.video_stream_index;
    let source_audio_stream_index = source_inspected.audio_stream_index;
    let source_probe = source_inspected.probe;
    let source_has_audio = source_probe.audio.is_some();
    let profile_identity = derive_profile_identity(&PREVIEW_PROFILE).map_err(map_model_error)?;
    let (proxy_recipe_argv, proxy_validation_policy) = proxy_recipe(
        dimensions,
        &input.sequence_rate,
        source_is_hdr,
        source_video_stream_index,
        source_audio_stream_index,
    )
    .map_err(map_model_error)?;
    let proxy_recipe_digest = derive_recipe_digest(
        DerivedArtifactKind::Proxy,
        &proxy_recipe_argv,
        &proxy_validation_policy,
    )
    .map_err(map_model_error)?;
    let proxy_identity = derive_media_identity(
        DerivedArtifactKind::Proxy,
        &ingested.identity,
        programs.toolchain_id(),
        &profile_identity,
        &proxy_recipe_digest,
    )
    .map_err(map_model_error)?;
    let (thumbnail_recipe_argv, thumbnail_validation_policy) = thumbnail_recipe(
        source_probe.duration_microseconds,
        source_video_stream_index,
    )
    .map_err(map_model_error)?;
    let thumbnail_recipe_digest = derive_recipe_digest(
        DerivedArtifactKind::ThumbnailTile,
        &thumbnail_recipe_argv,
        &thumbnail_validation_policy,
    )
    .map_err(map_model_error)?;
    let thumbnail_identity = derive_media_identity(
        DerivedArtifactKind::ThumbnailTile,
        &ingested.identity,
        programs.toolchain_id(),
        &profile_identity,
        &thumbnail_recipe_digest,
    )
    .map_err(map_model_error)?;

    Ok(PreparedAssetPlan {
        cache_root: cache_root.to_path_buf(),
        object_path: ingested.object_path,
        source_fingerprint: ingested.fingerprint,
        source_identity: ingested.identity,
        source_probe,
        sequence_rate: input.sequence_rate,
        profile_identity,
        proxy_identity,
        thumbnail_identity,
        dimensions,
        source_is_hdr,
        source_video_stream_index,
        source_audio_stream_index,
        source_has_audio,
    })
}

async fn execute_proxy_child(
    plan: &PreparedAssetPlan,
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
    publication: Option<PublicationContext<'_>>,
) -> Result<ProxyChildResult, VideoCommandError> {
    let proxy_expectation = ProxyValidationExpectation {
        dimensions: plan.dimensions,
        sequence_rate: &plan.sequence_rate,
        source_duration_microseconds: plan.source_probe.duration_microseconds,
        source_has_audio: plan.source_has_audio,
    };
    if let Some(publication) = publication {
        lease_preparation_source(plan, publication).await?;
    }
    #[cfg(test)]
    programs.before_source_use().await;
    let proxy_guard = acquire_artifact(
        &plan.cache_root,
        ArtifactStoreKind::Proxy,
        &plan.proxy_identity.key,
    )
    .await?;
    let proxy_probe = if let Some(probe) = cached_proxy_probe(
        proxy_guard.path(),
        proxy_expectation,
        programs,
        cancellation.clone(),
    )
    .await?
    {
        probe
    } else {
        let temporary = proxy_guard.temporary()?;
        let proxy_args = proxy_ffmpeg_args(
            &plan.object_path,
            temporary.path(),
            plan.dimensions,
            &plan.sequence_rate,
            plan.source_is_hdr,
            plan.source_video_stream_index,
            plan.source_audio_stream_index,
        )
        .map_err(map_model_error)?;
        run_derived_ffmpeg_with_programs(
            programs,
            proxy_args,
            "prepare_proxy",
            PROXY_TIMEOUT,
            cancellation.clone(),
        )
        .await?;
        validate_proxy_path(
            temporary.path(),
            proxy_expectation,
            programs,
            cancellation.clone(),
            "validate_proxy_temp",
        )
        .await?;
        proxy_guard.promote(temporary)?;
        match validate_proxy_path(
            proxy_guard.path(),
            proxy_expectation,
            programs,
            cancellation,
            "validate_proxy_final",
        )
        .await
        {
            Ok(probe) => probe,
            Err(error) => {
                let _ = proxy_guard.remove_exact();
                return Err(error);
            }
        }
    };
    proxy_guard.confirm_durable()?;
    if let Some(context) = publication {
        register_derived_artifact(
            context.cache,
            context.owner_label,
            context.project_id,
            CacheArtifactKind::Proxy,
            &plan.proxy_identity,
            proxy_guard.path(),
        )
        .await
        .map_err(map_job_store_error)?;
    }
    Ok(ProxyChildResult {
        path: response_path(proxy_guard.path())?,
        probe: proxy_probe,
    })
}

async fn execute_thumbnail_child(
    plan: &PreparedAssetPlan,
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
    publication: Option<PublicationContext<'_>>,
) -> Result<ThumbnailChildResult, VideoCommandError> {
    if let Some(publication) = publication {
        lease_preparation_source(plan, publication).await?;
    }
    #[cfg(test)]
    programs.before_source_use().await;
    let thumbnail_guard = acquire_artifact(
        &plan.cache_root,
        ArtifactStoreKind::ThumbnailTile,
        &plan.thumbnail_identity.key,
    )
    .await?;
    if !cached_thumbnail_is_valid(thumbnail_guard.path(), programs, cancellation.clone()).await? {
        let temporary = thumbnail_guard.temporary()?;
        let thumbnail_args = thumbnail_ffmpeg_args(
            &plan.object_path,
            temporary.path(),
            plan.source_probe.duration_microseconds,
            plan.source_video_stream_index,
        )
        .map_err(map_model_error)?;
        run_derived_ffmpeg_with_programs(
            programs,
            thumbnail_args,
            "prepare_thumbnail",
            THUMBNAIL_TIMEOUT,
            cancellation.clone(),
        )
        .await?;
        validate_thumbnail_path(
            temporary.path(),
            temporary.path(),
            programs,
            cancellation.clone(),
            "validate_thumbnail_temp",
        )
        .await?;
        thumbnail_guard.promote(temporary)?;
        if let Err(error) = validate_thumbnail_path(
            thumbnail_guard.path(),
            thumbnail_guard.path(),
            programs,
            cancellation,
            "validate_thumbnail_final",
        )
        .await
        {
            let _ = thumbnail_guard.remove_exact();
            return Err(error);
        }
    }
    thumbnail_guard.confirm_durable()?;
    if let Some(context) = publication {
        register_derived_artifact(
            context.cache,
            context.owner_label,
            context.project_id,
            CacheArtifactKind::ThumbnailTile,
            &plan.thumbnail_identity,
            thumbnail_guard.path(),
        )
        .await
        .map_err(map_job_store_error)?;
    }
    Ok(ThumbnailChildResult {
        path: response_path(thumbnail_guard.path())?,
    })
}

async fn run_derived_ffmpeg_with_programs(
    programs: &MediaPrograms,
    args: Vec<OsString>,
    operation: &'static str,
    timeout: Duration,
    cancellation: ProcessCancellation,
) -> Result<(), VideoCommandError> {
    let program = programs.verified_ffmpeg(operation).await?;
    run_derived_ffmpeg(program, args, operation, timeout, cancellation).await
}

pub(crate) async fn run_derived_ffmpeg(
    program: OsString,
    args: Vec<OsString>,
    operation: &'static str,
    timeout: Duration,
    cancellation: ProcessCancellation,
) -> Result<(), VideoCommandError> {
    let spec = ProcessSpec {
        program,
        args,
        current_dir: None,
        operation,
        timeout,
        stdout_limit: FFMPEG_STDOUT_LIMIT,
        stderr_tail_limit: FFMPEG_STDERR_TAIL_LIMIT,
    };
    run_supervised(spec, cancellation)
        .await
        .map(|_| ())
        .map_err(map_ffmpeg_failure)
}

async fn cached_proxy_probe(
    path: &Path,
    expectation: ProxyValidationExpectation<'_>,
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
) -> Result<Option<MediaProbe>, VideoCommandError> {
    match validate_proxy_path(
        path,
        expectation,
        programs,
        cancellation,
        "validate_proxy_cache",
    )
    .await
    {
        Ok(probe) => Ok(Some(probe)),
        Err(error)
            if matches!(
                error.code,
                VideoErrorCode::InvalidMedia | VideoErrorCode::ProcessFailed
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

async fn validate_proxy_path(
    path: &Path,
    expectation: ProxyValidationExpectation<'_>,
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
    operation: &'static str,
) -> Result<MediaProbe, VideoCommandError> {
    let file = artifact_file_facts(path);
    if !file.is_regular_file || file.byte_len == 0 {
        return Err(VideoCommandError::invalid_media(operation, "file"));
    }
    let ffprobe_program = programs.verified_ffprobe(operation).await?;
    let inspected =
        probe_trusted_media_with_program(path, ffprobe_program, cancellation, operation).await?;
    validate_proxy_artifact(
        file,
        &inspected,
        expectation.dimensions,
        expectation.sequence_rate,
        expectation.source_duration_microseconds,
        expectation.source_has_audio,
    )
    .map_err(|_| VideoCommandError::invalid_media(operation, "profile"))?;
    Ok(inspected.probe)
}

async fn cached_thumbnail_is_valid(
    path: &Path,
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
) -> Result<bool, VideoCommandError> {
    match validate_thumbnail_path(
        path,
        path,
        programs,
        cancellation,
        "validate_thumbnail_cache",
    )
    .await
    {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.code,
                VideoErrorCode::InvalidMedia | VideoErrorCode::ProcessFailed
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

async fn validate_thumbnail_path(
    actual_path: &Path,
    expected_path: &Path,
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
    operation: &'static str,
) -> Result<(), VideoCommandError> {
    let file = artifact_file_facts(actual_path);
    validate_thumbnail_file_shape(actual_path, expected_path, file)
        .map_err(|_| VideoCommandError::invalid_media(operation, "file"))?;
    let ffprobe_program = programs.verified_ffprobe(operation).await?;
    let inspected = probe_thumbnail_artifact_with_program(
        actual_path,
        ffprobe_program,
        cancellation,
        operation,
    )
    .await?;
    validate_thumbnail_artifact(actual_path, expected_path, file, &inspected)
        .map_err(|_| VideoCommandError::invalid_media(operation, "profile"))
}

fn source_identity<'a>(
    canonical_path: &'a Path,
    metadata: &Metadata,
) -> Result<SourceIdentity<'a>, VideoCommandError> {
    let modified = metadata
        .modified()
        .map_err(|_| VideoCommandError::invalid_media("prepare_asset", "source_modified"))?;
    let (modified_unix_seconds, modified_nanoseconds) = unix_time_parts(modified)
        .ok_or_else(|| VideoCommandError::invalid_media("prepare_asset", "source_modified"))?;
    Ok(SourceIdentity {
        canonical_path,
        file_size_bytes: metadata.len(),
        modified_unix_seconds,
        modified_nanoseconds,
    })
}

pub(crate) fn unix_time_parts(time: SystemTime) -> Option<(i64, u32)> {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => Some((
            i64::try_from(duration.as_secs()).ok()?,
            duration.subsec_nanos(),
        )),
        Err(error) => {
            let duration = error.duration();
            let seconds = i64::try_from(duration.as_secs()).ok()?;
            if duration.subsec_nanos() == 0 {
                Some((seconds.checked_neg()?, 0))
            } else {
                Some((
                    seconds.checked_add(1)?.checked_neg()?,
                    1_000_000_000 - duration.subsec_nanos(),
                ))
            }
        }
    }
}

fn artifact_file_facts(path: &Path) -> ArtifactFileFacts {
    match fs::symlink_metadata(path) {
        Ok(metadata) => ArtifactFileFacts {
            is_regular_file: metadata.is_file(),
            byte_len: metadata.len(),
        },
        Err(_) => ArtifactFileFacts {
            is_regular_file: false,
            byte_len: 0,
        },
    }
}

fn response_path(path: &Path) -> Result<String, VideoCommandError> {
    path.to_str()
        .ok_or_else(|| VideoCommandError::invalid_path("prepare_asset", "cache_encoding"))
        .map(str::to_owned)
}

fn map_model_error(error: DerivedModelError) -> VideoCommandError {
    match error {
        DerivedModelError::ProjectId => {
            VideoCommandError::invalid_path("prepare_asset", "project_id")
        }
        DerivedModelError::AssetId => VideoCommandError::invalid_path("prepare_asset", "asset_id"),
        DerivedModelError::SequenceRate => {
            VideoCommandError::phase1_limit("prepare_asset", "sequence_rate")
        }
        DerivedModelError::SourceIdentity => {
            VideoCommandError::invalid_media("prepare_asset", "source_identity")
        }
        DerivedModelError::Dimensions => {
            VideoCommandError::invalid_media("prepare_asset", "dimensions")
        }
        DerivedModelError::Fingerprint => {
            VideoCommandError::invalid_path("prepare_asset", "fingerprint")
        }
        DerivedModelError::Duration => {
            VideoCommandError::invalid_media("prepare_asset", "duration")
        }
    }
}

pub(crate) fn map_cache_error(error: CacheLifecycleError) -> VideoCommandError {
    match error {
        CacheLifecycleError::Escape | CacheLifecycleError::UnsafeArtifactPath => {
            VideoCommandError::invalid_path("prepare_asset", "cache_containment")
        }
        CacheLifecycleError::TemporaryValidation | CacheLifecycleError::FinalValidation => {
            VideoCommandError::invalid_media("prepare_asset", "cache_validation")
        }
        CacheLifecycleError::LockTimeout => {
            VideoCommandError::project_io("prepare_asset", "cache_lock_timeout")
        }
        CacheLifecycleError::LockFile => {
            VideoCommandError::project_io("prepare_asset", "cache_lock")
        }
        CacheLifecycleError::CacheRoot
        | CacheLifecycleError::Component
        | CacheLifecycleError::NotDirectory
        | CacheLifecycleError::TemporaryFile
        | CacheLifecycleError::Promotion
        | CacheLifecycleError::Cleanup => VideoCommandError::project_io("prepare_asset", "cache"),
    }
}

fn map_ffmpeg_failure(failure: ProcessFailure) -> VideoCommandError {
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

pub(crate) fn validated_uuid_segment(value: &str) -> Option<String> {
    is_contract_uuid(value).then(|| value.to_ascii_lowercase())
}

pub(crate) fn validated_sequence_rate(rate: RationalRate) -> Option<RationalRate> {
    RationalRate::checked_reduced(rate.numerator, rate.denominator)
        .filter(|reduced| *reduced == rate)
}

pub(crate) fn source_fingerprint(
    identity: &SourceIdentity<'_>,
    sequence_rate: &RationalRate,
) -> Result<String, DerivedModelError> {
    source_fingerprint_with_profile(identity, sequence_rate, &PREVIEW_PROFILE)
}

pub(crate) fn source_fingerprint_with_profile(
    identity: &SourceIdentity<'_>,
    sequence_rate: &RationalRate,
    profile: &DerivedProfile,
) -> Result<String, DerivedModelError> {
    if !is_canonical_absolute_path(identity.canonical_path)
        || identity.modified_nanoseconds >= 1_000_000_000
    {
        return Err(DerivedModelError::SourceIdentity);
    }
    let rate =
        validated_sequence_rate(sequence_rate.clone()).ok_or(DerivedModelError::SequenceRate)?;

    let mut hasher = Sha256::new();
    hash_field(&mut hasher, b"supa-video-derived-source-v1");
    hash_field(&mut hasher, &path_identity_bytes(identity.canonical_path));
    hash_u64(&mut hasher, identity.file_size_bytes);
    hash_i64(&mut hasher, identity.modified_unix_seconds);
    hash_u64(&mut hasher, u64::from(identity.modified_nanoseconds));
    hash_profile(&mut hasher, profile);
    hash_u64(&mut hasher, rate.numerator);
    hash_u64(&mut hasher, rate.denominator);

    let digest = hasher.finalize();
    let mut fingerprint = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut fingerprint, "{byte:02x}").expect("writing hexadecimal to String cannot fail");
    }
    Ok(fingerprint)
}

pub(crate) fn artifact_paths(
    cache_root: &Path,
    input: &ValidatedDerivedInput,
    fingerprint: &str,
) -> Result<DerivedArtifactPaths, DerivedModelError> {
    let profile_directory = cache_root
        .join(CACHE_NAMESPACE)
        .join(&input.project_segment)
        .join(&input.asset_segment)
        .join(PREVIEW_PROFILE.directory_name);
    artifact_paths_for_directory(profile_directory, fingerprint)
}

pub(crate) fn ensure_profile_cache_directory(
    cache_root: &Path,
    input: &ValidatedDerivedInput,
) -> Result<ValidatedCacheDirectory, CacheLifecycleError> {
    let cache_root = ensure_cache_root(cache_root)?;
    let namespace = ensure_direct_child(&cache_root, CACHE_NAMESPACE)?;
    let project = ensure_direct_child(&namespace, &input.project_segment)?;
    let asset = ensure_direct_child(&project, &input.asset_segment)?;
    let profile_directory = ensure_direct_child(&asset, PREVIEW_PROFILE.directory_name)?;
    Ok(ValidatedCacheDirectory { profile_directory })
}

async fn acquire_profile_cache_lock(
    directory: &ValidatedCacheDirectory,
) -> Result<ProfileCacheLock, CacheLifecycleError> {
    acquire_profile_cache_lock_with(
        directory,
        PROFILE_CACHE_LOCK_TIMEOUT,
        PROFILE_CACHE_LOCK_RETRY_INTERVAL,
        || {},
    )
    .await
}

pub(crate) async fn acquire_profile_cache_lock_with<OnContention>(
    directory: &ValidatedCacheDirectory,
    timeout: Duration,
    retry_interval: Duration,
    mut on_contention: OnContention,
) -> Result<ProfileCacheLock, CacheLifecycleError>
where
    OnContention: FnMut(),
{
    let file = open_profile_cache_lock_file(directory)?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(CacheLifecycleError::LockTimeout)?;

    loop {
        match fs4::FileExt::try_lock(&file) {
            Ok(()) => return Ok(ProfileCacheLock { file }),
            Err(TryLockError::WouldBlock) => {
                on_contention();
                let now = Instant::now();
                if now >= deadline {
                    return Err(CacheLifecycleError::LockTimeout);
                }
                let remaining = deadline.saturating_duration_since(now);
                let sleep_duration = retry_interval.max(Duration::from_millis(1)).min(remaining);
                tokio::time::sleep(sleep_duration).await;
            }
            Err(TryLockError::Error(_)) => return Err(CacheLifecycleError::LockFile),
        }
    }
}

fn open_profile_cache_lock_file(
    directory: &ValidatedCacheDirectory,
) -> Result<fs::File, CacheLifecycleError> {
    validate_profile_directory(directory)?;
    let lock_path = directory
        .profile_directory
        .join(PROFILE_CACHE_LOCK_FILENAME);
    match fs::symlink_metadata(&lock_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CacheLifecycleError::Escape);
        }
        Ok(metadata) if !metadata.is_file() => return Err(CacheLifecycleError::LockFile),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(CacheLifecycleError::LockFile),
    }

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|_| CacheLifecycleError::LockFile)?;
    let path_metadata =
        fs::symlink_metadata(&lock_path).map_err(|_| CacheLifecycleError::LockFile)?;
    if path_metadata.file_type().is_symlink() {
        return Err(CacheLifecycleError::Escape);
    }
    if !path_metadata.is_file()
        || !file
            .metadata()
            .map_err(|_| CacheLifecycleError::LockFile)?
            .is_file()
    {
        return Err(CacheLifecycleError::LockFile);
    }
    let canonical_lock_path =
        fs::canonicalize(&lock_path).map_err(|_| CacheLifecycleError::LockFile)?;
    if canonical_lock_path != lock_path {
        return Err(CacheLifecycleError::Escape);
    }
    Ok(file)
}

pub(crate) fn artifact_paths_in_validated_cache(
    directory: &ValidatedCacheDirectory,
    fingerprint: &str,
) -> Result<DerivedArtifactPaths, DerivedModelError> {
    artifact_paths_for_directory(directory.profile_directory.clone(), fingerprint)
}

pub(crate) fn create_temp_artifacts(
    directory: &ValidatedCacheDirectory,
) -> Result<DerivedTempArtifacts, CacheLifecycleError> {
    validate_profile_directory(directory)?;
    let proxy = TempFileBuilder::new()
        .prefix(".svp-video-proxy-")
        .suffix(".mp4")
        .tempfile_in(&directory.profile_directory)
        .map_err(|_| CacheLifecycleError::TemporaryFile)?
        .into_temp_path();
    let thumbnail = TempFileBuilder::new()
        .prefix(".svp-video-thumbnail-")
        .suffix(".jpg")
        .tempfile_in(&directory.profile_directory)
        .map_err(|_| CacheLifecycleError::TemporaryFile)?
        .into_temp_path();
    Ok(DerivedTempArtifacts { proxy, thumbnail })
}

pub(crate) fn cache_pair_is_valid_with<ProxyValidator, ThumbnailValidator>(
    directory: &ValidatedCacheDirectory,
    paths: &DerivedArtifactPaths,
    mut validate_proxy: ProxyValidator,
    mut validate_thumbnail: ThumbnailValidator,
) -> Result<bool, CacheLifecycleError>
where
    ProxyValidator: FnMut(&Path) -> bool,
    ThumbnailValidator: FnMut(&Path) -> bool,
{
    validate_profile_directory(directory)?;
    validate_owned_artifact_paths(directory, paths)?;
    Ok(validate_proxy(&paths.proxy_path) && validate_thumbnail(&paths.thumbnail_path))
}

pub(crate) fn promote_prevalidated_pair(
    directory: &ValidatedCacheDirectory,
    paths: &DerivedArtifactPaths,
    temporary: DerivedTempArtifacts,
) -> Result<(), CacheLifecycleError> {
    validate_profile_directory(directory)?;
    validate_owned_artifact_paths(directory, paths)?;
    validate_temporary_artifact_path(directory, &temporary.proxy, "mp4")?;
    validate_temporary_artifact_path(directory, &temporary.thumbnail, "jpg")?;
    let DerivedTempArtifacts { proxy, thumbnail } = temporary;
    proxy
        .persist(&paths.proxy_path)
        .map_err(|_| CacheLifecycleError::Promotion)?;
    thumbnail
        .persist(&paths.thumbnail_path)
        .map_err(|_| CacheLifecycleError::Promotion)
}

pub(crate) fn promote_validated_pair_with<ProxyValidator, ThumbnailValidator, Promoter>(
    directory: &ValidatedCacheDirectory,
    paths: &DerivedArtifactPaths,
    temporary: DerivedTempArtifacts,
    mut validate_proxy: ProxyValidator,
    mut validate_thumbnail: ThumbnailValidator,
    mut promote: Promoter,
) -> Result<(), CacheLifecycleError>
where
    ProxyValidator: FnMut(&Path) -> bool,
    ThumbnailValidator: FnMut(&Path) -> bool,
    Promoter: FnMut(TempPath, &Path) -> Result<(), TempPath>,
{
    validate_profile_directory(directory)?;
    validate_owned_artifact_paths(directory, paths)?;
    validate_temporary_artifact_path(directory, &temporary.proxy, "mp4")?;
    validate_temporary_artifact_path(directory, &temporary.thumbnail, "jpg")?;
    if !validate_proxy(&temporary.proxy) || !validate_thumbnail(&temporary.thumbnail) {
        return Err(CacheLifecycleError::TemporaryValidation);
    }

    let DerivedTempArtifacts { proxy, thumbnail } = temporary;
    if let Err(proxy) = promote(proxy, &paths.proxy_path) {
        drop(proxy);
        return Err(CacheLifecycleError::Promotion);
    }
    if let Err(thumbnail) = promote(thumbnail, &paths.thumbnail_path) {
        drop(thumbnail);
        return Err(CacheLifecycleError::Promotion);
    }
    if !validate_proxy(&paths.proxy_path) || !validate_thumbnail(&paths.thumbnail_path) {
        return Err(CacheLifecycleError::FinalValidation);
    }
    cleanup_stale_owned_artifacts(directory, paths)
}

pub(crate) fn promote_validated_pair<ProxyValidator, ThumbnailValidator>(
    directory: &ValidatedCacheDirectory,
    paths: &DerivedArtifactPaths,
    temporary: DerivedTempArtifacts,
    validate_proxy: ProxyValidator,
    validate_thumbnail: ThumbnailValidator,
) -> Result<(), CacheLifecycleError>
where
    ProxyValidator: FnMut(&Path) -> bool,
    ThumbnailValidator: FnMut(&Path) -> bool,
{
    promote_validated_pair_with(
        directory,
        paths,
        temporary,
        validate_proxy,
        validate_thumbnail,
        |temporary, destination| temporary.persist(destination).map_err(|error| error.path),
    )
}

fn artifact_paths_for_directory(
    profile_directory: PathBuf,
    fingerprint: &str,
) -> Result<DerivedArtifactPaths, DerivedModelError> {
    if !is_sha256_hex(fingerprint) {
        return Err(DerivedModelError::Fingerprint);
    }
    Ok(DerivedArtifactPaths {
        proxy_path: profile_directory.join(format!("proxy-{fingerprint}.mp4")),
        thumbnail_path: profile_directory.join(format!("thumbnail-{fingerprint}.jpg")),
        profile_directory,
    })
}

fn ensure_cache_root(cache_root: &Path) -> Result<PathBuf, CacheLifecycleError> {
    match fs::symlink_metadata(cache_root) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(cache_root).map_err(|_| CacheLifecycleError::CacheRoot)?;
        }
        Err(_) => return Err(CacheLifecycleError::CacheRoot),
    }
    let metadata = fs::symlink_metadata(cache_root).map_err(|_| CacheLifecycleError::CacheRoot)?;
    if metadata.file_type().is_symlink() {
        return Err(CacheLifecycleError::Escape);
    }
    if !metadata.is_dir() {
        return Err(CacheLifecycleError::NotDirectory);
    }
    fs::canonicalize(cache_root).map_err(|_| CacheLifecycleError::CacheRoot)
}

fn ensure_direct_child(
    canonical_parent: &Path,
    component: &str,
) -> Result<PathBuf, CacheLifecycleError> {
    let mut components = Path::new(component).components();
    if !matches!(components.next(), Some(Component::Normal(value)) if value == OsStr::new(component))
        || components.next().is_some()
    {
        return Err(CacheLifecycleError::Component);
    }
    let child = canonical_parent.join(component);
    match fs::create_dir(&child) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(CacheLifecycleError::Component),
    }
    let metadata = fs::symlink_metadata(&child).map_err(|_| CacheLifecycleError::Component)?;
    if metadata.file_type().is_symlink() {
        return Err(CacheLifecycleError::Escape);
    }
    if !metadata.is_dir() {
        return Err(CacheLifecycleError::NotDirectory);
    }
    let canonical_child = fs::canonicalize(&child).map_err(|_| CacheLifecycleError::Component)?;
    if canonical_child != child {
        return Err(CacheLifecycleError::Escape);
    }
    Ok(canonical_child)
}

fn validate_profile_directory(
    directory: &ValidatedCacheDirectory,
) -> Result<(), CacheLifecycleError> {
    let metadata = fs::symlink_metadata(&directory.profile_directory)
        .map_err(|_| CacheLifecycleError::Component)?;
    if metadata.file_type().is_symlink() {
        return Err(CacheLifecycleError::Escape);
    }
    if !metadata.is_dir() {
        return Err(CacheLifecycleError::NotDirectory);
    }
    let canonical = fs::canonicalize(&directory.profile_directory)
        .map_err(|_| CacheLifecycleError::Component)?;
    if canonical != directory.profile_directory {
        return Err(CacheLifecycleError::Escape);
    }
    Ok(())
}

fn validate_owned_artifact_paths(
    directory: &ValidatedCacheDirectory,
    paths: &DerivedArtifactPaths,
) -> Result<(), CacheLifecycleError> {
    if paths.profile_directory != directory.profile_directory
        || paths.proxy_path.parent() != Some(directory.profile_directory.as_path())
        || paths.thumbnail_path.parent() != Some(directory.profile_directory.as_path())
    {
        return Err(CacheLifecycleError::UnsafeArtifactPath);
    }
    let proxy_fingerprint = owned_fingerprint(paths.proxy_path.file_name(), "proxy-", ".mp4");
    let thumbnail_fingerprint =
        owned_fingerprint(paths.thumbnail_path.file_name(), "thumbnail-", ".jpg");
    if proxy_fingerprint.is_none() || proxy_fingerprint != thumbnail_fingerprint {
        return Err(CacheLifecycleError::UnsafeArtifactPath);
    }
    Ok(())
}

fn validate_temporary_artifact_path(
    directory: &ValidatedCacheDirectory,
    path: &Path,
    expected_extension: &str,
) -> Result<(), CacheLifecycleError> {
    if path.parent() != Some(directory.profile_directory.as_path())
        || path.extension().and_then(OsStr::to_str) != Some(expected_extension)
    {
        return Err(CacheLifecycleError::UnsafeArtifactPath);
    }
    Ok(())
}

pub(crate) fn cleanup_stale_owned_artifacts(
    directory: &ValidatedCacheDirectory,
    current: &DerivedArtifactPaths,
) -> Result<(), CacheLifecycleError> {
    for entry in
        fs::read_dir(&directory.profile_directory).map_err(|_| CacheLifecycleError::Cleanup)?
    {
        let entry = entry.map_err(|_| CacheLifecycleError::Cleanup)?;
        let path = entry.path();
        if path == current.proxy_path || path == current.thumbnail_path {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|_| CacheLifecycleError::Cleanup)?;
        if file_type.is_file() && is_owned_artifact_filename(&entry.file_name()) {
            fs::remove_file(path).map_err(|_| CacheLifecycleError::Cleanup)?;
        }
    }
    Ok(())
}

fn owned_fingerprint<'a>(
    file_name: Option<&'a OsStr>,
    prefix: &str,
    suffix: &str,
) -> Option<&'a str> {
    let file_name = file_name?.to_str()?;
    let fingerprint = file_name.strip_prefix(prefix)?.strip_suffix(suffix)?;
    is_sha256_hex(fingerprint).then_some(fingerprint)
}

fn is_owned_artifact_filename(file_name: &OsStr) -> bool {
    owned_fingerprint(Some(file_name), "proxy-", ".mp4").is_some()
        || owned_fingerprint(Some(file_name), "thumbnail-", ".jpg").is_some()
}

pub(crate) fn fit_proxy_dimensions(
    source_width: u64,
    source_height: u64,
) -> Result<OutputDimensions, DerivedModelError> {
    let display_aspect_ratio = reduced_ratio(source_width, source_height)?;
    let display_shape = MediaDisplayShape::checked(
        RationalRate {
            numerator: 1,
            denominator: 1,
        },
        display_aspect_ratio,
        0,
    )
    .ok_or(DerivedModelError::Dimensions)?;
    fit_proxy_dimensions_for_display(source_width, source_height, &display_shape)
}

pub(crate) fn fit_proxy_dimensions_for_display(
    source_width: u64,
    source_height: u64,
    display_shape: &MediaDisplayShape,
) -> Result<OutputDimensions, DerivedModelError> {
    validate_display_shape(source_width, source_height, display_shape)?;

    let quarter_turned = matches!(display_shape.rotation_degrees, 90 | 270);
    let (oriented_source_width, oriented_source_height) = if quarter_turned {
        (source_height, source_width)
    } else {
        (source_width, source_height)
    };
    let width_limit = oriented_source_width.min(PREVIEW_PROFILE.proxy_max_width);
    let height_limit = oriented_source_height.min(PREVIEW_PROFILE.proxy_max_height);
    let (aspect_numerator, aspect_denominator) = if quarter_turned {
        (
            display_shape.display_aspect_ratio.denominator,
            display_shape.display_aspect_ratio.numerator,
        )
    } else {
        (
            display_shape.display_aspect_ratio.numerator,
            display_shape.display_aspect_ratio.denominator,
        )
    };

    let (selected_width, selected_height) = if u128::from(aspect_numerator)
        * u128::from(height_limit)
        >= u128::from(width_limit) * u128::from(aspect_denominator)
    {
        (
            width_limit,
            scaled_dimension(aspect_denominator, width_limit, aspect_numerator)?,
        )
    } else {
        (
            scaled_dimension(aspect_numerator, height_limit, aspect_denominator)?,
            height_limit,
        )
    };

    let dimensions = OutputDimensions {
        width: selected_width & !1,
        height: selected_height & !1,
    };
    if dimensions.width < 2 || dimensions.height < 2 {
        return Err(DerivedModelError::Dimensions);
    }
    Ok(dimensions)
}

pub(crate) fn one_frame_tolerance_microseconds(
    sequence_rate: &RationalRate,
) -> Result<u64, DerivedModelError> {
    let rate =
        validated_sequence_rate(sequence_rate.clone()).ok_or(DerivedModelError::SequenceRate)?;
    let numerator = u128::from(MICROS_PER_SECOND) * u128::from(rate.denominator);
    let denominator = u128::from(rate.numerator);
    let tolerance = numerator.div_ceil(denominator);
    u64::try_from(tolerance)
        .ok()
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))
        .ok_or(DerivedModelError::SequenceRate)
}

pub(crate) fn duration_within_one_frame(
    source_duration_microseconds: u64,
    derived_duration_microseconds: u64,
    sequence_rate: &RationalRate,
) -> Result<bool, DerivedModelError> {
    if !(1..=MAX_SAFE_INTEGER).contains(&source_duration_microseconds)
        || !(1..=MAX_SAFE_INTEGER).contains(&derived_duration_microseconds)
    {
        return Err(DerivedModelError::Duration);
    }
    Ok(
        source_duration_microseconds.abs_diff(derived_duration_microseconds)
            <= one_frame_tolerance_microseconds(sequence_rate)?,
    )
}

fn expected_proxy_color_metadata() -> MediaColorMetadata {
    MediaColorMetadata {
        color_range: Some(PREVIEW_PROFILE.proxy_color_range.to_owned()),
        color_space: Some(PREVIEW_PROFILE.proxy_color_space.to_owned()),
        color_primaries: Some(PREVIEW_PROFILE.proxy_color_primaries.to_owned()),
        color_transfer: Some(PREVIEW_PROFILE.proxy_color_transfer.to_owned()),
    }
}

pub(crate) fn validate_proxy_artifact(
    file: ArtifactFileFacts,
    inspected: &InspectedMedia,
    expected_dimensions: OutputDimensions,
    sequence_rate: &RationalRate,
    source_duration_microseconds: u64,
    source_has_audio: bool,
) -> Result<(), ArtifactValidationError> {
    validate_nonempty_regular_file(file)?;
    if inspected.probe.file_size_bytes != file.byte_len {
        return Err(ArtifactValidationError::ProbeSizeMismatch);
    }
    if inspected.probe.video_codec_name != "h264" {
        return Err(ArtifactValidationError::VideoCodec);
    }
    if expected_dimensions.width < 2
        || expected_dimensions.height < 2
        || expected_dimensions.width > PREVIEW_PROFILE.proxy_max_width
        || expected_dimensions.height > PREVIEW_PROFILE.proxy_max_height
        || expected_dimensions.width & 1 != 0
        || expected_dimensions.height & 1 != 0
        || !display_dimensions_match(inspected, expected_dimensions)
    {
        return Err(ArtifactValidationError::Dimensions);
    }
    if inspected.pixel_format.as_deref() != Some(PREVIEW_PROFILE.proxy_pixel_format) {
        return Err(ArtifactValidationError::PixelFormat);
    }
    if inspected.color != expected_proxy_color_metadata() {
        return Err(ArtifactValidationError::ColorMetadata);
    }
    let Some(rate) = validated_sequence_rate(sequence_rate.clone()) else {
        return Err(ArtifactValidationError::FrameRate);
    };
    if inspected.probe.average_frame_rate != rate || inspected.probe.real_frame_rate != rate {
        return Err(ArtifactValidationError::FrameRate);
    }
    if inspected.probe.variable_frame_rate {
        return Err(ArtifactValidationError::VariableFrameRate);
    }
    let audio_is_valid = match (source_has_audio, inspected.probe.audio.as_ref()) {
        (true, Some(audio)) => {
            audio.codec_name == PREVIEW_PROFILE.proxy_audio_encoder
                && audio.sample_rate == PREVIEW_PROFILE.proxy_audio_sample_rate
        }
        (false, None) => true,
        _ => false,
    };
    if !audio_is_valid {
        return Err(ArtifactValidationError::Audio);
    }
    match duration_within_one_frame(
        source_duration_microseconds,
        inspected.probe.duration_microseconds,
        &rate,
    ) {
        Ok(true) => Ok(()),
        Ok(false) | Err(_) => Err(ArtifactValidationError::Duration),
    }
}

pub(crate) fn validate_thumbnail_artifact(
    actual_path: &Path,
    expected_path: &Path,
    file: ArtifactFileFacts,
    inspected: &ThumbnailArtifactProbe,
) -> Result<(), ArtifactValidationError> {
    validate_thumbnail_file_shape(actual_path, expected_path, file)?;
    if inspected.file_size_bytes != file.byte_len {
        return Err(ArtifactValidationError::ProbeSizeMismatch);
    }
    if inspected.video_codec_name != PREVIEW_PROFILE.thumbnail_encoder {
        return Err(ArtifactValidationError::VideoCodec);
    }
    if inspected.decoded_frame_count != 1 {
        return Err(ArtifactValidationError::FrameCount);
    }
    let expected_width = PREVIEW_PROFILE
        .thumbnail_count
        .checked_mul(PREVIEW_PROFILE.thumbnail_cell_width)
        .ok_or(ArtifactValidationError::Dimensions)?;
    if inspected.width != expected_width
        || inspected.height != PREVIEW_PROFILE.thumbnail_cell_height
    {
        return Err(ArtifactValidationError::Dimensions);
    }
    Ok(())
}

fn validate_thumbnail_file_shape(
    actual_path: &Path,
    expected_path: &Path,
    file: ArtifactFileFacts,
) -> Result<(), ArtifactValidationError> {
    if actual_path != expected_path {
        return Err(ArtifactValidationError::Path);
    }
    if actual_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("jpg")
    {
        return Err(ArtifactValidationError::FileExtension);
    }
    validate_nonempty_regular_file(file)
}

fn validate_nonempty_regular_file(file: ArtifactFileFacts) -> Result<(), ArtifactValidationError> {
    if !file.is_regular_file {
        return Err(ArtifactValidationError::NotRegularFile);
    }
    if file.byte_len == 0 {
        return Err(ArtifactValidationError::EmptyFile);
    }
    Ok(())
}

pub(crate) fn proxy_ffmpeg_args(
    source_path: &Path,
    destination_path: &Path,
    dimensions: OutputDimensions,
    sequence_rate: &RationalRate,
    source_is_hdr: bool,
    source_video_stream_index: u64,
    source_audio_stream_index: Option<u64>,
) -> Result<Vec<OsString>, DerivedModelError> {
    if dimensions.width < 2
        || dimensions.height < 2
        || dimensions.width > PREVIEW_PROFILE.proxy_max_width
        || dimensions.height > PREVIEW_PROFILE.proxy_max_height
        || dimensions.width & 1 != 0
        || dimensions.height & 1 != 0
    {
        return Err(DerivedModelError::Dimensions);
    }
    let rate =
        validated_sequence_rate(sequence_rate.clone()).ok_or(DerivedModelError::SequenceRate)?;
    let geometry_filter = format!(
        "scale={}:{}:flags={}:out_color_matrix={}:out_range={},setsar={},fps={}/{}",
        dimensions.width,
        dimensions.height,
        PREVIEW_PROFILE.scale_flags,
        PREVIEW_PROFILE.proxy_color_space,
        PREVIEW_PROFILE.proxy_color_range,
        PREVIEW_PROFILE.proxy_sample_aspect_ratio,
        rate.numerator,
        rate.denominator
    );
    let video_filter = if source_is_hdr {
        format!(
            "zscale=transfer={}:npl={},format={},tonemap=tonemap={}:desat={}:peak={},zscale=primaries={}:transfer={}:matrix={}:range={}:dither={},{}",
            PREVIEW_PROFILE.proxy_hdr_linear_transfer,
            PREVIEW_PROFILE.proxy_hdr_nominal_peak_luminance,
            PREVIEW_PROFILE.proxy_hdr_intermediate_pixel_format,
            PREVIEW_PROFILE.proxy_hdr_tonemap,
            PREVIEW_PROFILE.proxy_hdr_tonemap_desaturation,
            PREVIEW_PROFILE.proxy_hdr_signal_peak,
            PREVIEW_PROFILE.proxy_color_primaries,
            PREVIEW_PROFILE.proxy_color_transfer,
            PREVIEW_PROFILE.proxy_color_space,
            PREVIEW_PROFILE.proxy_color_range,
            PREVIEW_PROFILE.proxy_hdr_dither,
            geometry_filter,
        )
    } else {
        geometry_filter
    };

    let video_encoder_params = format!(
        "colorprim={}:transfer={}:colormatrix={}:range={}",
        PREVIEW_PROFILE.proxy_color_primaries,
        PREVIEW_PROFILE.proxy_color_transfer,
        PREVIEW_PROFILE.proxy_color_space,
        PREVIEW_PROFILE.proxy_video_encoder_color_range,
    );
    let mut args = common_ffmpeg_prefix(source_path);
    let video_map = format!("0:{source_video_stream_index}");
    push_tokens(&mut args, &["-map", &video_map]);
    if let Some(audio_stream_index) = source_audio_stream_index {
        let audio_map = format!("0:{audio_stream_index}");
        push_tokens(&mut args, &["-map", &audio_map]);
    }
    push_tokens(&mut args, &["-vf", &video_filter]);
    push_tokens(
        &mut args,
        &[
            "-c:v",
            PREVIEW_PROFILE.proxy_video_encoder,
            "-x264-params",
            &video_encoder_params,
            "-preset",
            PREVIEW_PROFILE.proxy_preset,
            "-crf",
            &PREVIEW_PROFILE.proxy_crf.to_string(),
            "-pix_fmt",
            PREVIEW_PROFILE.proxy_pixel_format,
            "-color_range",
            PREVIEW_PROFILE.proxy_color_range,
            "-colorspace",
            PREVIEW_PROFILE.proxy_color_space,
            "-color_primaries",
            PREVIEW_PROFILE.proxy_color_primaries,
            "-color_trc",
            PREVIEW_PROFILE.proxy_color_transfer,
        ],
    );
    if source_audio_stream_index.is_some() {
        push_tokens(
            &mut args,
            &[
                "-c:a",
                PREVIEW_PROFILE.proxy_audio_encoder,
                "-b:a",
                PREVIEW_PROFILE.proxy_audio_bitrate,
                "-ar",
                &PREVIEW_PROFILE.proxy_audio_sample_rate.to_string(),
            ],
        );
    } else {
        args.push(OsString::from("-an"));
    }
    push_tokens(
        &mut args,
        &["-movflags", PREVIEW_PROFILE.proxy_movflags, "-f", "mp4"],
    );
    args.push(destination_path.as_os_str().to_owned());
    Ok(args)
}

pub(crate) fn thumbnail_ffmpeg_args(
    source_path: &Path,
    destination_path: &Path,
    duration_microseconds: u64,
    source_video_stream_index: u64,
) -> Result<Vec<OsString>, DerivedModelError> {
    if !(1..=MAX_SAFE_INTEGER).contains(&duration_microseconds) {
        return Err(DerivedModelError::Duration);
    }
    let sampling_numerator = PREVIEW_PROFILE
        .thumbnail_count
        .checked_mul(MICROS_PER_SECOND)
        .ok_or(DerivedModelError::Duration)?;
    let video_filter = format!(
        "fps={sampling_numerator}/{duration_microseconds}:round=down:start_time=0,scale={}:{}:force_original_aspect_ratio=decrease:reset_sar=1:flags={},pad={}:{}:(ow-iw)/2:(oh-ih)/2:color={},tile={}",
        PREVIEW_PROFILE.thumbnail_cell_width,
        PREVIEW_PROFILE.thumbnail_cell_height,
        PREVIEW_PROFILE.scale_flags,
        PREVIEW_PROFILE.thumbnail_cell_width,
        PREVIEW_PROFILE.thumbnail_cell_height,
        PREVIEW_PROFILE.thumbnail_pad_color,
        PREVIEW_PROFILE.thumbnail_tile_layout
    );

    let mut args = common_ffmpeg_prefix(source_path);
    let video_map = format!("0:{source_video_stream_index}");
    push_tokens(&mut args, &["-map", &video_map, "-vf", &video_filter]);
    push_tokens(
        &mut args,
        &[
            "-frames:v",
            "1",
            "-c:v",
            PREVIEW_PROFILE.thumbnail_encoder,
            "-q:v",
            &PREVIEW_PROFILE.thumbnail_quality.to_string(),
            "-f",
            "image2",
        ],
    );
    args.push(destination_path.as_os_str().to_owned());
    Ok(args)
}

fn common_ffmpeg_prefix(source_path: &Path) -> Vec<OsString> {
    let mut args = Vec::with_capacity(32);
    push_tokens(
        &mut args,
        &["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"],
    );
    args.push(source_path.as_os_str().to_owned());
    args
}

fn push_tokens(args: &mut Vec<OsString>, tokens: &[&str]) {
    args.extend(tokens.iter().map(OsString::from));
}

fn display_dimensions_match(inspected: &InspectedMedia, expected: OutputDimensions) -> bool {
    let shape = &inspected.display_shape;
    if validate_display_shape(inspected.probe.width, inspected.probe.height, shape).is_err() {
        return false;
    }
    let sample_numerator = u128::from(shape.sample_aspect_ratio.numerator);
    let sample_denominator = u128::from(shape.sample_aspect_ratio.denominator);
    if matches!(shape.rotation_degrees, 90 | 270) {
        u128::from(inspected.probe.height) == u128::from(expected.width)
            && u128::from(inspected.probe.width) * sample_numerator
                == u128::from(expected.height) * sample_denominator
    } else {
        u128::from(inspected.probe.width) * sample_numerator
            == u128::from(expected.width) * sample_denominator
            && inspected.probe.height == expected.height
    }
}

fn validate_display_shape(
    width: u64,
    height: u64,
    shape: &MediaDisplayShape,
) -> Result<(), DerivedModelError> {
    if width == 0
        || height == 0
        || MediaDisplayShape::checked(
            shape.sample_aspect_ratio.clone(),
            shape.display_aspect_ratio.clone(),
            shape.rotation_degrees,
        )
        .as_ref()
            != Some(shape)
    {
        return Err(DerivedModelError::Dimensions);
    }
    let left = u128::from(width)
        .checked_mul(u128::from(shape.sample_aspect_ratio.numerator))
        .and_then(|value| value.checked_mul(u128::from(shape.display_aspect_ratio.denominator)))
        .ok_or(DerivedModelError::Dimensions)?;
    let right = u128::from(height)
        .checked_mul(u128::from(shape.sample_aspect_ratio.denominator))
        .and_then(|value| value.checked_mul(u128::from(shape.display_aspect_ratio.numerator)))
        .ok_or(DerivedModelError::Dimensions)?;
    (left == right)
        .then_some(())
        .ok_or(DerivedModelError::Dimensions)
}

fn reduced_ratio(numerator: u64, denominator: u64) -> Result<RationalRate, DerivedModelError> {
    RationalRate::checked_reduced(numerator, denominator).ok_or(DerivedModelError::Dimensions)
}

fn scaled_dimension(source: u64, limit: u64, source_limit: u64) -> Result<u64, DerivedModelError> {
    let value = u128::from(source) * u128::from(limit) / u128::from(source_limit);
    u64::try_from(value).map_err(|_| DerivedModelError::Dimensions)
}

fn is_canonical_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(unix)]
fn path_identity_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt as _;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn path_identity_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt as _;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

fn hash_profile(hasher: &mut Sha256, profile: &DerivedProfile) {
    hash_field(hasher, profile.directory_name.as_bytes());
    hash_u64(hasher, profile.proxy_max_width);
    hash_u64(hasher, profile.proxy_max_height);
    hash_field(hasher, profile.scale_flags.as_bytes());
    hash_field(hasher, profile.proxy_video_encoder.as_bytes());
    hash_field(hasher, profile.proxy_video_encoder_color_range.as_bytes());
    hash_field(hasher, profile.proxy_preset.as_bytes());
    hash_u64(hasher, u64::from(profile.proxy_crf));
    hash_field(hasher, profile.proxy_pixel_format.as_bytes());
    hash_field(hasher, profile.proxy_sample_aspect_ratio.as_bytes());
    hash_field(hasher, profile.proxy_color_range.as_bytes());
    hash_field(hasher, profile.proxy_color_space.as_bytes());
    hash_field(hasher, profile.proxy_color_primaries.as_bytes());
    hash_field(hasher, profile.proxy_color_transfer.as_bytes());
    hash_field(hasher, profile.proxy_hdr_linear_transfer.as_bytes());
    hash_field(hasher, profile.proxy_hdr_nominal_peak_luminance.as_bytes());
    hash_field(
        hasher,
        profile.proxy_hdr_intermediate_pixel_format.as_bytes(),
    );
    hash_field(hasher, profile.proxy_hdr_tonemap.as_bytes());
    hash_field(hasher, profile.proxy_hdr_tonemap_desaturation.as_bytes());
    hash_field(hasher, profile.proxy_hdr_signal_peak.as_bytes());
    hash_field(hasher, profile.proxy_hdr_dither.as_bytes());
    hash_field(hasher, profile.proxy_movflags.as_bytes());
    hash_field(hasher, profile.proxy_audio_encoder.as_bytes());
    hash_field(hasher, profile.proxy_audio_bitrate.as_bytes());
    hash_u64(hasher, profile.proxy_audio_sample_rate);
    hash_u64(hasher, profile.thumbnail_count);
    hash_u64(hasher, profile.thumbnail_cell_width);
    hash_u64(hasher, profile.thumbnail_cell_height);
    hash_field(hasher, profile.thumbnail_pad_color.as_bytes());
    hash_field(hasher, profile.thumbnail_tile_layout.as_bytes());
    hash_field(hasher, profile.thumbnail_encoder.as_bytes());
    hash_u64(hasher, u64::from(profile.thumbnail_quality));
}

fn hash_u64(hasher: &mut Sha256, value: u64) {
    hash_field(hasher, &value.to_le_bytes());
}

fn hash_i64(hasher: &mut Sha256, value: i64) {
    hash_field(hasher, &value.to_le_bytes());
}

fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    let length = u64::try_from(value.len()).expect("path and profile fields fit in u64");
    hasher.update(length.to_le_bytes());
    hasher.update(value);
}

#[derive(Default)]
struct IdentityEncoder {
    bytes: Vec<u8>,
}

impl IdentityEncoder {
    fn string(&mut self, value: &str) -> Result<(), DerivedModelError> {
        self.byte_slice(value.as_bytes())
    }

    fn byte_slice(&mut self, value: &[u8]) -> Result<(), DerivedModelError> {
        let length = u32::try_from(value.len()).map_err(|_| DerivedModelError::Fingerprint)?;
        self.bytes.extend_from_slice(&length.to_le_bytes());
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn safe_integer(&mut self, value: u64) -> Result<(), DerivedModelError> {
        if value > MAX_SAFE_INTEGER {
            return Err(DerivedModelError::Fingerprint);
        }
        self.bytes.extend_from_slice(&value.to_le_bytes());
        Ok(())
    }

    fn digest(self) -> String {
        let digest = Sha256::digest(self.bytes);
        hex_sha256(&digest)
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("hexadecimal String writes cannot fail");
    }
    output
}

fn decode_sha256(value: &str) -> Result<[u8; 32], DerivedModelError> {
    if !is_sha256_hex(value) {
        return Err(DerivedModelError::Fingerprint);
    }
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| DerivedModelError::Fingerprint)?;
    }
    Ok(bytes)
}

fn profile_string_field(
    encoder: &mut IdentityEncoder,
    name: &str,
    value: &str,
) -> Result<(), DerivedModelError> {
    encoder.string(name)?;
    encoder.string(value)
}

fn profile_integer_field(
    encoder: &mut IdentityEncoder,
    name: &str,
    value: u64,
) -> Result<(), DerivedModelError> {
    encoder.string(name)?;
    encoder.safe_integer(value)
}

pub(crate) fn derive_profile_identity(
    profile: &DerivedProfile,
) -> Result<MediaProfileIdentityV1, DerivedModelError> {
    let mut encoder = IdentityEncoder::default();
    encoder.string("supa-video/media-profile/v1")?;
    profile_string_field(&mut encoder, "profileId", profile.directory_name)?;
    profile_integer_field(&mut encoder, "proxyMaxWidth", profile.proxy_max_width)?;
    profile_integer_field(&mut encoder, "proxyMaxHeight", profile.proxy_max_height)?;
    profile_string_field(&mut encoder, "scaleFlags", profile.scale_flags)?;
    profile_string_field(
        &mut encoder,
        "proxyVideoEncoder",
        profile.proxy_video_encoder,
    )?;
    profile_string_field(
        &mut encoder,
        "proxyVideoEncoderColorRange",
        profile.proxy_video_encoder_color_range,
    )?;
    profile_string_field(&mut encoder, "proxyPreset", profile.proxy_preset)?;
    profile_integer_field(&mut encoder, "proxyCrf", u64::from(profile.proxy_crf))?;
    profile_string_field(&mut encoder, "proxyPixelFormat", profile.proxy_pixel_format)?;
    profile_string_field(
        &mut encoder,
        "proxySampleAspectRatio",
        profile.proxy_sample_aspect_ratio,
    )?;
    profile_string_field(&mut encoder, "proxyColorRange", profile.proxy_color_range)?;
    profile_string_field(&mut encoder, "proxyColorSpace", profile.proxy_color_space)?;
    profile_string_field(
        &mut encoder,
        "proxyColorPrimaries",
        profile.proxy_color_primaries,
    )?;
    profile_string_field(
        &mut encoder,
        "proxyColorTransfer",
        profile.proxy_color_transfer,
    )?;
    profile_string_field(
        &mut encoder,
        "proxyHdrLinearTransfer",
        profile.proxy_hdr_linear_transfer,
    )?;
    profile_string_field(
        &mut encoder,
        "proxyHdrNominalPeakLuminance",
        profile.proxy_hdr_nominal_peak_luminance,
    )?;
    profile_string_field(
        &mut encoder,
        "proxyHdrIntermediatePixelFormat",
        profile.proxy_hdr_intermediate_pixel_format,
    )?;
    profile_string_field(&mut encoder, "proxyHdrTonemap", profile.proxy_hdr_tonemap)?;
    profile_string_field(
        &mut encoder,
        "proxyHdrTonemapDesaturation",
        profile.proxy_hdr_tonemap_desaturation,
    )?;
    profile_string_field(
        &mut encoder,
        "proxyHdrSignalPeak",
        profile.proxy_hdr_signal_peak,
    )?;
    profile_string_field(&mut encoder, "proxyHdrDither", profile.proxy_hdr_dither)?;
    profile_string_field(&mut encoder, "proxyMovflags", profile.proxy_movflags)?;
    profile_string_field(
        &mut encoder,
        "proxyAudioEncoder",
        profile.proxy_audio_encoder,
    )?;
    profile_string_field(
        &mut encoder,
        "proxyAudioBitrate",
        profile.proxy_audio_bitrate,
    )?;
    profile_integer_field(
        &mut encoder,
        "proxyAudioSampleRate",
        profile.proxy_audio_sample_rate,
    )?;
    profile_integer_field(&mut encoder, "thumbnailCount", profile.thumbnail_count)?;
    profile_integer_field(
        &mut encoder,
        "thumbnailCellWidth",
        profile.thumbnail_cell_width,
    )?;
    profile_integer_field(
        &mut encoder,
        "thumbnailCellHeight",
        profile.thumbnail_cell_height,
    )?;
    profile_string_field(
        &mut encoder,
        "thumbnailPadColor",
        profile.thumbnail_pad_color,
    )?;
    profile_string_field(
        &mut encoder,
        "thumbnailTileLayout",
        profile.thumbnail_tile_layout,
    )?;
    profile_string_field(&mut encoder, "thumbnailEncoder", profile.thumbnail_encoder)?;
    profile_integer_field(
        &mut encoder,
        "thumbnailQuality",
        u64::from(profile.thumbnail_quality),
    )?;
    Ok(MediaProfileIdentityV1 {
        schema_version: 1,
        profile_id: profile.directory_name.to_owned(),
        profile_digest: encoder.digest(),
    })
}

pub(crate) fn derive_recipe_digest(
    artifact_kind: DerivedArtifactKind,
    argv: &[String],
    validation_policy: &[String],
) -> Result<String, DerivedModelError> {
    let mut encoder = IdentityEncoder::default();
    encoder.string("supa-video/derived-recipe/v1")?;
    encoder.string(artifact_kind.as_str())?;
    encoder.safe_integer(u64::try_from(argv.len()).map_err(|_| DerivedModelError::Fingerprint)?)?;
    for token in argv {
        encoder.string(token)?;
    }
    encoder.safe_integer(
        u64::try_from(validation_policy.len()).map_err(|_| DerivedModelError::Fingerprint)?,
    )?;
    for rule in validation_policy {
        encoder.string(rule)?;
    }
    Ok(encoder.digest())
}

pub(crate) fn derive_media_identity(
    artifact_kind: DerivedArtifactKind,
    source_identity: &MediaContentIdentityV1,
    toolchain_id: &str,
    profile_identity: &MediaProfileIdentityV1,
    recipe_digest: &str,
) -> Result<DerivedMediaIdentityV1, DerivedModelError> {
    if source_identity.schema_version != 1
        || source_identity.byte_length == 0
        || source_identity.byte_length > MAX_SAFE_INTEGER
        || toolchain_id.trim().is_empty()
        || profile_identity.schema_version != 1
        || profile_identity.profile_id.trim().is_empty()
    {
        return Err(DerivedModelError::Fingerprint);
    }
    let mut encoder = IdentityEncoder::default();
    encoder.string("supa-video/derived-media/v1")?;
    encoder.string(artifact_kind.as_str())?;
    encoder.byte_slice(&decode_sha256(&source_identity.digest)?)?;
    encoder.safe_integer(source_identity.byte_length)?;
    encoder.string(toolchain_id)?;
    encoder.string(&profile_identity.profile_id)?;
    encoder.byte_slice(&decode_sha256(&profile_identity.profile_digest)?)?;
    encoder.byte_slice(&decode_sha256(recipe_digest)?)?;
    let key = encoder.digest();
    Ok(DerivedMediaIdentityV1 {
        schema_version: 1,
        artifact_kind,
        key,
        source_identity: source_identity.clone(),
        toolchain_id: toolchain_id.to_owned(),
        profile_identity: profile_identity.clone(),
        recipe_digest: recipe_digest.to_owned(),
    })
}

fn os_args_to_recipe(args: Vec<OsString>) -> Result<Vec<String>, DerivedModelError> {
    args.into_iter()
        .map(|argument| {
            argument
                .into_string()
                .map_err(|_| DerivedModelError::Fingerprint)
        })
        .collect()
}

pub(crate) fn proxy_recipe(
    dimensions: OutputDimensions,
    sequence_rate: &RationalRate,
    source_is_hdr: bool,
    source_video_stream_index: u64,
    source_audio_stream_index: Option<u64>,
) -> Result<(Vec<String>, Vec<String>), DerivedModelError> {
    let argv = os_args_to_recipe(proxy_ffmpeg_args(
        Path::new("{source}"),
        Path::new("{destination}"),
        dimensions,
        sequence_rate,
        source_is_hdr,
        source_video_stream_index,
        source_audio_stream_index,
    )?)?;
    let validation = [
        "regular_nonzero",
        "probe_size_exact",
        "h264_yuv420p",
        "display_dimensions_exact",
        "bt709_sdr_tags",
        "constant_frame_rate_exact",
        "audio_presence_and_rate",
        "duration_within_one_frame",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    Ok((argv, validation))
}

pub(crate) fn thumbnail_recipe(
    duration_microseconds: u64,
    source_video_stream_index: u64,
) -> Result<(Vec<String>, Vec<String>), DerivedModelError> {
    let argv = os_args_to_recipe(thumbnail_ffmpeg_args(
        Path::new("{source}"),
        Path::new("{destination}"),
        duration_microseconds,
        source_video_stream_index,
    )?)?;
    let validation = [
        "regular_nonzero",
        "jpeg_extension",
        "probe_size_exact",
        "mjpeg_stream",
        "single_decoded_frame",
        "single_tile_exact_geometry",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    Ok((argv, validation))
}
