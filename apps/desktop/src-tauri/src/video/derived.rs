use std::{
    ffi::{OsStr, OsString},
    fs::{self, Metadata, OpenOptions},
    io,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use fs4::TryLockError;
use sha2::{Digest, Sha256};
use tauri::{Manager, Runtime, State, WebviewWindow};
use tempfile::{Builder as TempFileBuilder, TempPath};

use super::{
    error::{VideoCommandError, VideoErrorCode},
    grants::{GrantCategory, VideoPathGrants},
    probe::{probe_trusted_media_with_program, InspectedMedia},
    process::{run_supervised, ProcessCancellation, ProcessFailure, ProcessSpec},
    toolchain::MediaToolchainState,
    types::{
        is_contract_uuid, MediaColorMetadata, MediaDisplayShape, MediaProbe, PreparedVideoAsset,
        RationalRate, MAX_SAFE_INTEGER,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    _file: fs::File,
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

#[derive(Debug)]
pub(crate) struct PrepareAssetCoreRequest<'a> {
    pub(crate) owner_label: &'a str,
    pub(crate) project_id: &'a str,
    pub(crate) asset_id: &'a str,
    pub(crate) source_path: &'a Path,
    pub(crate) sequence_rate: RationalRate,
}

#[derive(Debug, Clone)]
pub(crate) struct MediaPrograms {
    source: MediaProgramSource,
}

#[derive(Debug, Clone)]
enum MediaProgramSource {
    Bundled(Arc<MediaToolchainState>),
    #[cfg(test)]
    Explicit {
        ffmpeg: OsString,
        ffprobe: OsString,
    },
}

impl MediaPrograms {
    pub(crate) fn bundled(toolchain: MediaToolchainState) -> Self {
        Self {
            source: MediaProgramSource::Bundled(Arc::new(toolchain)),
        }
    }

    #[cfg(test)]
    pub(crate) fn explicit(ffmpeg: OsString, ffprobe: OsString) -> Self {
        Self {
            source: MediaProgramSource::Explicit { ffmpeg, ffprobe },
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
pub async fn video_prepare_asset<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    toolchain: State<'_, MediaToolchainState>,
    project_id: String,
    asset_id: String,
    path: String,
    sequence_rate: RationalRate,
) -> Result<PreparedVideoAsset, VideoCommandError> {
    let cache_root = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| VideoCommandError::project_io("prepare_asset", "app_cache"))?;
    let programs = MediaPrograms::bundled(toolchain.inner().clone());
    prepare_asset_core(
        PrepareAssetCoreRequest {
            owner_label: window.label(),
            project_id: &project_id,
            asset_id: &asset_id,
            source_path: Path::new(&path),
            sequence_rate,
        },
        &grants,
        &cache_root,
        programs,
    )
    .await
}

pub(crate) async fn prepare_asset_core(
    request: PrepareAssetCoreRequest<'_>,
    grants: &VideoPathGrants,
    cache_root: &Path,
    programs: MediaPrograms,
) -> Result<PreparedVideoAsset, VideoCommandError> {
    let input =
        ValidatedDerivedInput::new(request.project_id, request.asset_id, request.sequence_rate)
            .map_err(map_model_error)?;
    let source = grants.authorize(
        request.owner_label,
        GrantCategory::Source,
        request.source_path,
    )?;
    let source_metadata = fs::metadata(&source)
        .map_err(|_| VideoCommandError::invalid_media("prepare_asset", "source_metadata"))?;
    let cancellation = ProcessCancellation::new();
    let source_probe_operation = "prepare_source_probe";
    let source_inspected = probe_trusted_media_with_program(
        &source,
        programs.verified_ffprobe(source_probe_operation).await?,
        cancellation.clone(),
        source_probe_operation,
    )
    .await?;
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
    let identity = source_identity(&source, &source_metadata)?;
    let fingerprint =
        source_fingerprint(&identity, &input.sequence_rate).map_err(map_model_error)?;
    let directory = ensure_profile_cache_directory(cache_root, &input).map_err(map_cache_error)?;
    let paths =
        artifact_paths_in_validated_cache(&directory, &fingerprint).map_err(map_model_error)?;
    let _cache_lock = acquire_profile_cache_lock(&directory)
        .await
        .map_err(map_cache_error)?;
    let source_has_audio = source_probe.audio.is_some();
    let proxy_expectation = ProxyValidationExpectation {
        dimensions,
        sequence_rate: &input.sequence_rate,
        source_duration_microseconds: source_probe.duration_microseconds,
        source_has_audio,
    };

    if let Some(proxy_probe) = cached_proxy_probe(
        &paths.proxy_path,
        proxy_expectation,
        &programs,
        cancellation.clone(),
    )
    .await?
    {
        if thumbnail_file_is_valid(&paths.thumbnail_path, &paths.thumbnail_path) {
            cleanup_stale_owned_artifacts(&directory, &paths).map_err(map_cache_error)?;
            return prepared_asset(&paths, proxy_probe);
        }
    }

    let temporary = create_temp_artifacts(&directory).map_err(map_cache_error)?;
    let proxy_args = proxy_ffmpeg_args(
        &source,
        &temporary.proxy,
        dimensions,
        &input.sequence_rate,
        source_is_hdr,
        source_video_stream_index,
        source_audio_stream_index,
    )
    .map_err(map_model_error)?;
    run_derived_ffmpeg_with_programs(
        &programs,
        proxy_args,
        "prepare_proxy",
        PROXY_TIMEOUT,
        cancellation.clone(),
    )
    .await?;
    validate_proxy_path(
        &temporary.proxy,
        proxy_expectation,
        &programs,
        cancellation.clone(),
        "validate_proxy_temp",
    )
    .await?;

    let thumbnail_args = thumbnail_ffmpeg_args(
        &source,
        &temporary.thumbnail,
        source_probe.duration_microseconds,
        source_video_stream_index,
    )
    .map_err(map_model_error)?;
    run_derived_ffmpeg_with_programs(
        &programs,
        thumbnail_args,
        "prepare_thumbnail",
        THUMBNAIL_TIMEOUT,
        cancellation.clone(),
    )
    .await?;
    if !thumbnail_file_is_valid(&temporary.thumbnail, &temporary.thumbnail) {
        return Err(VideoCommandError::invalid_media(
            "prepare_asset",
            "thumbnail_temp_validation",
        ));
    }

    promote_prevalidated_pair(&directory, &paths, temporary).map_err(map_cache_error)?;
    let proxy_probe = validate_proxy_path(
        &paths.proxy_path,
        proxy_expectation,
        &programs,
        cancellation,
        "validate_proxy_final",
    )
    .await?;
    if !thumbnail_file_is_valid(&paths.thumbnail_path, &paths.thumbnail_path) {
        return Err(VideoCommandError::invalid_media(
            "prepare_asset",
            "thumbnail_final_validation",
        ));
    }
    cleanup_stale_owned_artifacts(&directory, &paths).map_err(map_cache_error)?;
    prepared_asset(&paths, proxy_probe)
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

fn thumbnail_file_is_valid(actual_path: &Path, expected_path: &Path) -> bool {
    validate_thumbnail_artifact(actual_path, expected_path, artifact_file_facts(actual_path))
        .is_ok()
}

fn prepared_asset(
    paths: &DerivedArtifactPaths,
    proxy_probe: MediaProbe,
) -> Result<PreparedVideoAsset, VideoCommandError> {
    let proxy_path = paths
        .proxy_path
        .to_str()
        .ok_or_else(|| VideoCommandError::invalid_path("prepare_asset", "cache_encoding"))?
        .to_owned();
    let thumbnail_path = paths
        .thumbnail_path
        .to_str()
        .ok_or_else(|| VideoCommandError::invalid_path("prepare_asset", "cache_encoding"))?
        .to_owned();
    Ok(PreparedVideoAsset {
        proxy_path,
        thumbnail_path,
        proxy_probe,
    })
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
            Ok(()) => return Ok(ProfileCacheLock { _file: file }),
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
