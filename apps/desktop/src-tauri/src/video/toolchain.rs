use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fmt,
    fs::{self, File, Metadata},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use chrono::NaiveDate;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::{watch, Mutex};

use super::{
    error::VideoCommandError,
    process::{run_supervised, ProcessCancellation, ProcessFailure, ProcessSpec},
};

const COMPILED_MANIFEST: &str = include_str!("../../media-toolchain/manifest.v1.json");
const SUPPORTED_TARGET: &str = "x86_64-pc-windows-msvc";
const PINNED_TOOLCHAIN_ID: &str = "ffmpeg-8.1.2-gyan-essentials-windows-x86_64";
const PINNED_SOURCE_COMMIT: &str = "38b88335f99e76ed89ff3c93f877fdefce736c13";
const FFMPEG_COMMIT_URL_PREFIX: &str = "https://github.com/FFmpeg/FFmpeg/commit/";
const PINNED_SOURCE_URL: &str =
    "https://github.com/FFmpeg/FFmpeg/commit/38b88335f99e76ed89ff3c93f877fdefce736c13";
const PINNED_PROVIDER_URL: &str = "https://www.gyan.dev/ffmpeg/builds/";
const PINNED_PROVIDER_BUILD_DATE: &str = "2026-06-27";
const PINNED_ARCHIVE_URL: &str = "https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip";
const PINNED_ARCHIVE_FILENAME: &str = "ffmpeg-8.1.2-essentials_build.zip";
const PINNED_ARCHIVE_BYTE_LENGTH: u64 = 109_728_040;
const PINNED_ARCHIVE_SHA256: &str =
    "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec";
const INSPECTION_TIMEOUT: Duration = Duration::from_secs(15);
const INSPECTION_STDOUT_LIMIT: usize = 1024 * 1024;
const INSPECTION_STDERR_LIMIT: usize = 64 * 1024;
const INITIALIZATION_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_MANIFEST_BYTES: usize = 128 * 1024;
const FILE_ATTRIBUTE_REPARSE_POINT_VALUE: u32 = 0x400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaToolchainProblem {
    NotFound,
    IntegrityFailed,
    IncompatibleBuild,
    TimedOut,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaToolchainError {
    problem: MediaToolchainProblem,
}

impl MediaToolchainError {
    fn new(problem: MediaToolchainProblem) -> Self {
        Self { problem }
    }

    pub(crate) fn for_status(problem: MediaToolchainProblem) -> Self {
        Self::new(problem)
    }

    #[cfg(test)]
    pub(crate) fn for_test(problem: MediaToolchainProblem) -> Self {
        Self::new(problem)
    }

    pub fn problem(&self) -> MediaToolchainProblem {
        self.problem
    }

    pub fn into_command_error(self, operation: &'static str) -> VideoCommandError {
        let (category, timed_out, failed) = match self.problem {
            MediaToolchainProblem::NotFound => ("not_found", false, false),
            MediaToolchainProblem::IntegrityFailed => ("integrity_failed", false, false),
            MediaToolchainProblem::IncompatibleBuild => ("incompatible_build", false, false),
            MediaToolchainProblem::TimedOut => ("timed_out", true, false),
            MediaToolchainProblem::Failed => ("failed", false, true),
        };
        VideoCommandError::bundled_toolchain(operation, category, timed_out, failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaToolPrograms {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

impl MediaToolPrograms {
    pub fn ffmpeg(&self) -> &Path {
        &self.ffmpeg
    }

    pub fn ffprobe(&self) -> &Path {
        &self.ffprobe
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaToolchainInspection {
    pub ffmpeg_version: Result<String, MediaToolchainError>,
    pub ffprobe_version: Result<String, MediaToolchainError>,
}

fn failed_inspection(problem: MediaToolchainProblem) -> MediaToolchainInspection {
    let error = MediaToolchainError::new(problem);
    MediaToolchainInspection {
        ffmpeg_version: Err(error.clone()),
        ffprobe_version: Err(error),
    }
}

#[derive(Debug, Clone)]
struct ResolvedBinary {
    path: PathBuf,
    resource_root: PathBuf,
    canonical_root: PathBuf,
    manifest: BinaryManifest,
}

#[derive(Debug, Clone)]
enum StoredBinary {
    Bundled(ResolvedBinary),
    #[cfg(test)]
    Explicit(PathBuf),
}

#[derive(Debug, Clone)]
struct StoredMediaPrograms {
    ffmpeg: Result<StoredBinary, MediaToolchainError>,
    ffprobe: Result<StoredBinary, MediaToolchainError>,
}

#[derive(Debug, Clone)]
pub struct MediaToolchain {
    identity: ManifestIdentity,
    programs: Result<StoredMediaPrograms, MediaToolchainError>,
    #[cfg(test)]
    inspection_override: Option<MediaToolchainInspection>,
}

#[derive(Debug, Clone)]
enum MediaToolchainPhase {
    Resolving,
    Ready(Arc<MediaToolchain>),
    Unavailable(MediaToolchainError),
}

#[derive(Clone)]
pub struct MediaToolchainState {
    identity: ManifestIdentity,
    phase: watch::Receiver<MediaToolchainPhase>,
    resolution: Arc<MediaToolchainResolution>,
}

type MediaToolchainResolver =
    dyn Fn() -> Result<MediaToolchain, MediaToolchainError> + Send + Sync + 'static;

struct MediaToolchainResolution {
    timeout: Duration,
    resolver: Arc<MediaToolchainResolver>,
    phase: watch::Sender<MediaToolchainPhase>,
    gate: Mutex<()>,
}

impl fmt::Debug for MediaToolchainState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaToolchainState")
            .field("identity", &self.identity)
            .field("phase", &*self.phase.borrow())
            .finish_non_exhaustive()
    }
}

impl MediaToolchainResolution {
    async fn resolve(&self, retry_only: bool) {
        let _guard = self.gate.lock().await;
        if retry_only && !matches!(&*self.phase.borrow(), MediaToolchainPhase::Unavailable(_)) {
            return;
        }

        self.phase.send_replace(MediaToolchainPhase::Resolving);
        let resolver = self.resolver.clone();
        let resolved = tokio::time::timeout(
            self.timeout,
            tokio::task::spawn_blocking(move || resolver()),
        )
        .await;
        let next = match resolved {
            Ok(Ok(Ok(toolchain))) => MediaToolchainPhase::Ready(Arc::new(toolchain)),
            Ok(Ok(Err(error))) => MediaToolchainPhase::Unavailable(error),
            Ok(Err(_)) => MediaToolchainPhase::Unavailable(MediaToolchainError::new(
                MediaToolchainProblem::Failed,
            )),
            Err(_) => MediaToolchainPhase::Unavailable(MediaToolchainError::new(
                MediaToolchainProblem::TimedOut,
            )),
        };
        self.phase.send_replace(next);
    }

    fn invalidate(&self, error: &MediaToolchainError) {
        if matches!(
            error.problem(),
            MediaToolchainProblem::NotFound
                | MediaToolchainProblem::IntegrityFailed
                | MediaToolchainProblem::IncompatibleBuild
        ) {
            self.phase
                .send_replace(MediaToolchainPhase::Unavailable(error.clone()));
        }
    }
}

impl MediaToolchainState {
    pub fn start_for_app<R: Runtime>(app: &AppHandle<R>) -> Self {
        let app = app.clone();
        Self::start_with_resolver(INITIALIZATION_TIMEOUT, move || {
            MediaToolchain::try_resolve_for_app(&app)
        })
    }

    fn start_with_resolver(
        timeout: Duration,
        resolver: impl Fn() -> Result<MediaToolchain, MediaToolchainError> + Send + Sync + 'static,
    ) -> Self {
        let identity = MediaToolchain::compiled_identity();
        let (phase_sender, phase) = watch::channel(MediaToolchainPhase::Resolving);
        let resolution = Arc::new(MediaToolchainResolution {
            timeout,
            resolver: Arc::new(resolver),
            phase: phase_sender,
            gate: Mutex::new(()),
        });
        let initial_resolution = resolution.clone();
        tauri::async_runtime::spawn(async move {
            initial_resolution.resolve(false).await;
        });
        Self {
            identity,
            phase,
            resolution,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_ready(toolchain: MediaToolchain) -> Self {
        let identity = toolchain.identity.clone();
        let ready = Arc::new(toolchain.clone());
        let (phase_sender, phase) = watch::channel(MediaToolchainPhase::Ready(ready));
        let resolution = Arc::new(MediaToolchainResolution {
            timeout: INITIALIZATION_TIMEOUT,
            resolver: Arc::new(move || Ok(toolchain.clone())),
            phase: phase_sender,
            gate: Mutex::new(()),
        });
        Self {
            identity,
            phase,
            resolution,
        }
    }

    #[cfg(test)]
    pub(crate) fn start_for_test(
        timeout: Duration,
        resolver: impl Fn() -> Result<MediaToolchain, MediaToolchainError> + Send + Sync + 'static,
    ) -> Self {
        Self::start_with_resolver(timeout, resolver)
    }

    async fn ready(&self) -> Result<Arc<MediaToolchain>, MediaToolchainError> {
        let mut phase = self.phase.clone();
        loop {
            let current = phase.borrow().clone();
            match current {
                MediaToolchainPhase::Resolving => {}
                MediaToolchainPhase::Ready(toolchain) => return Ok(toolchain),
                MediaToolchainPhase::Unavailable(error) => return Err(error),
            }
            phase
                .changed()
                .await
                .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::Failed))?;
        }
    }

    async fn ready_for_inspection(&self) -> Result<Arc<MediaToolchain>, MediaToolchainError> {
        if matches!(&*self.phase.borrow(), MediaToolchainPhase::Unavailable(_)) {
            self.resolution.resolve(true).await;
        }
        self.ready().await
    }

    pub fn toolchain_id(&self) -> &str {
        &self.identity.toolchain_id
    }

    pub fn short_version(&self) -> &str {
        &self.identity.short_version
    }

    pub async fn inspect(&self) -> MediaToolchainInspection {
        match self.ready_for_inspection().await {
            Ok(toolchain) => {
                let inspection = toolchain.inspect().await;
                if let Err(error) = &inspection.ffmpeg_version {
                    self.resolution.invalidate(error);
                }
                if let Err(error) = &inspection.ffprobe_version {
                    self.resolution.invalidate(error);
                }
                inspection
            }
            Err(error) => failed_inspection(error.problem()),
        }
    }

    pub async fn verified_ffmpeg(&self) -> Result<PathBuf, MediaToolchainError> {
        let result = self.ready().await?.verified_ffmpeg().await;
        if let Err(error) = &result {
            self.resolution.invalidate(error);
        }
        result
    }

    pub async fn verified_ffprobe(&self) -> Result<PathBuf, MediaToolchainError> {
        let result = self.ready().await?.verified_ffprobe().await;
        if let Err(error) = &result {
            self.resolution.invalidate(error);
        }
        result
    }

    pub async fn verified_programs(&self) -> Result<MediaToolPrograms, MediaToolchainError> {
        let result = self.ready().await?.verified_programs().await;
        if let Err(error) = &result {
            self.resolution.invalidate(error);
        }
        result
    }

    #[cfg(test)]
    pub(crate) fn phase_for_test(&self) -> MediaToolchainProblemOrPhase {
        match &*self.phase.borrow() {
            MediaToolchainPhase::Resolving => MediaToolchainProblemOrPhase::Resolving,
            MediaToolchainPhase::Ready(_) => MediaToolchainProblemOrPhase::Ready,
            MediaToolchainPhase::Unavailable(error) => {
                MediaToolchainProblemOrPhase::Unavailable(error.problem())
            }
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaToolchainProblemOrPhase {
    Resolving,
    Ready,
    Unavailable(MediaToolchainProblem),
}
impl MediaToolchain {
    fn compiled_identity() -> ManifestIdentity {
        parse_manifest(COMPILED_MANIFEST)
            .map(|manifest| manifest.identity())
            .unwrap_or_else(|_| Self::failed_manifest(ManifestError::Json).identity)
    }

    fn try_resolve_for_app<R: Runtime>(app: &AppHandle<R>) -> Result<Self, MediaToolchainError> {
        let manifest = parse_manifest(COMPILED_MANIFEST)
            .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::Failed))?;
        let identity = manifest.identity();
        let target = current_target()
            .ok_or_else(|| MediaToolchainError::new(MediaToolchainProblem::NotFound))?;
        let resource_root = app
            .path()
            .resource_dir()
            .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::NotFound))?;
        let programs = resolve_programs_from_resource_root(&manifest, target, &resource_root)?;
        Ok(Self {
            identity,
            programs: Ok(programs),
            #[cfg(test)]
            inspection_override: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn resolve_from_resource_root(resource_root: &Path) -> Self {
        let manifest = match parse_manifest(COMPILED_MANIFEST) {
            Ok(manifest) => manifest,
            Err(error) => return Self::failed_manifest(error),
        };
        let mut identity = manifest.identity();
        identity.target = SUPPORTED_TARGET.to_owned();
        let programs =
            resolve_programs_from_resource_root(&manifest, SUPPORTED_TARGET, resource_root);
        Self {
            identity,
            programs,
            inspection_override: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_test_programs(ffmpeg: PathBuf, ffprobe: PathBuf) -> Self {
        let manifest =
            parse_manifest(COMPILED_MANIFEST).expect("compiled media manifest must be valid");
        let mut identity = manifest.identity();
        identity.target = SUPPORTED_TARGET.to_owned();
        Self {
            identity,
            programs: Ok(StoredMediaPrograms {
                ffmpeg: Ok(StoredBinary::Explicit(ffmpeg)),
                ffprobe: Ok(StoredBinary::Explicit(ffprobe)),
            }),
            inspection_override: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_test_inspection(
        ffmpeg_version: Result<String, MediaToolchainError>,
        ffprobe_version: Result<String, MediaToolchainError>,
    ) -> Self {
        let mut toolchain = Self::from_test_programs(
            PathBuf::from("unused-test-ffmpeg"),
            PathBuf::from("unused-test-ffprobe"),
        );
        toolchain.inspection_override = Some(MediaToolchainInspection {
            ffmpeg_version,
            ffprobe_version,
        });
        toolchain
    }

    #[cfg(all(test, feature = "tauri-ipc-test"))]
    pub(crate) fn resolve_test_bundled_programs(
        resource_root: &Path,
        ffmpeg_bytes: &[u8],
        ffprobe_bytes: &[u8],
    ) -> Result<Self, MediaToolchainError> {
        let manifest =
            parse_manifest(COMPILED_MANIFEST).expect("compiled media manifest must be valid");
        let mut identity = manifest.identity();
        identity.target = SUPPORTED_TARGET.to_owned();
        let canonical_root = fs::canonicalize(resource_root)
            .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::NotFound))?;
        let test_manifest = |filename: &str, bytes: &[u8]| BinaryManifest {
            filename: filename.to_owned(),
            resource_path: format!("media-tools/{filename}"),
            byte_length: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        };
        let ffmpeg_manifest = test_manifest("ffmpeg.exe", ffmpeg_bytes);
        let ffprobe_manifest = test_manifest("ffprobe.exe", ffprobe_bytes);
        let ffmpeg = resolve_binary(&canonical_root, resource_root, &ffmpeg_manifest)
            .map(StoredBinary::Bundled);
        let ffprobe = resolve_binary(&canonical_root, resource_root, &ffprobe_manifest)
            .map(StoredBinary::Bundled);
        Ok(Self {
            identity,
            programs: Ok(StoredMediaPrograms { ffmpeg, ffprobe }),
            inspection_override: None,
        })
    }

    fn failed_manifest(_error: ManifestError) -> Self {
        Self {
            identity: ManifestIdentity {
                target: current_target().unwrap_or("unsupported").to_owned(),
                toolchain_id: "bundled-media-tools-invalid".to_owned(),
                short_version: "unknown".to_owned(),
                full_version: "unknown".to_owned(),
            },
            programs: Err(MediaToolchainError::new(MediaToolchainProblem::Failed)),
            #[cfg(test)]
            inspection_override: None,
        }
    }

    pub fn target(&self) -> &str {
        &self.identity.target
    }

    pub fn toolchain_id(&self) -> &str {
        &self.identity.toolchain_id
    }

    pub fn short_version(&self) -> &str {
        &self.identity.short_version
    }

    #[cfg(test)]
    pub fn programs(&self) -> Result<MediaToolPrograms, MediaToolchainError> {
        let programs = self.programs.as_ref().map_err(Clone::clone)?;
        Ok(MediaToolPrograms {
            ffmpeg: stored_path(programs.ffmpeg.as_ref().map_err(Clone::clone)?).to_owned(),
            ffprobe: stored_path(programs.ffprobe.as_ref().map_err(Clone::clone)?).to_owned(),
        })
    }

    pub async fn verified_ffmpeg(&self) -> Result<PathBuf, MediaToolchainError> {
        let programs = self.programs.as_ref().map_err(Clone::clone)?;
        verify_stored_binary(programs.ffmpeg.as_ref().map_err(Clone::clone)?.clone()).await
    }

    pub async fn verified_ffprobe(&self) -> Result<PathBuf, MediaToolchainError> {
        let programs = self.programs.as_ref().map_err(Clone::clone)?;
        verify_stored_binary(programs.ffprobe.as_ref().map_err(Clone::clone)?.clone()).await
    }

    pub async fn verified_programs(&self) -> Result<MediaToolPrograms, MediaToolchainError> {
        let (ffmpeg, ffprobe) = tokio::try_join!(self.verified_ffmpeg(), self.verified_ffprobe())?;
        Ok(MediaToolPrograms { ffmpeg, ffprobe })
    }

    pub async fn inspect(&self) -> MediaToolchainInspection {
        #[cfg(test)]
        if let Some(inspection) = &self.inspection_override {
            return inspection.clone();
        }

        let manifest = match parse_manifest(COMPILED_MANIFEST) {
            Ok(manifest) => manifest,
            Err(_) => return failed_inspection(MediaToolchainProblem::Failed),
        };
        let target = match manifest.targets.get(self.target()) {
            Some(target) => target,
            None => return failed_inspection(MediaToolchainProblem::NotFound),
        };

        let (ffmpeg_version, ffprobe_version) = tokio::join!(
            self.inspect_ffmpeg(&manifest, target),
            self.inspect_ffprobe()
        );
        MediaToolchainInspection {
            ffmpeg_version,
            ffprobe_version,
        }
    }

    async fn inspect_ffmpeg(
        &self,
        manifest: &ToolchainManifest,
        target: &TargetManifest,
    ) -> Result<String, MediaToolchainError> {
        let version = self
            .run_verified_inspection(
                MediaTool::Ffmpeg,
                &["-hide_banner", "-version"],
                "inspect_bundled_ffmpeg_version",
            )
            .await?;
        let version =
            parse_version_banner(&version, "ffmpeg version ", &self.identity.full_version)?;

        let (build_configuration, encoders, muxers, filters) = tokio::join!(
            self.run_verified_inspection(
                MediaTool::Ffmpeg,
                &["-hide_banner", "-buildconf"],
                "inspect_bundled_ffmpeg_buildconf",
            ),
            self.run_verified_inspection(
                MediaTool::Ffmpeg,
                &["-hide_banner", "-encoders"],
                "inspect_bundled_ffmpeg_encoders",
            ),
            self.run_verified_inspection(
                MediaTool::Ffmpeg,
                &["-hide_banner", "-muxers"],
                "inspect_bundled_ffmpeg_muxers",
            ),
            self.run_verified_inspection(
                MediaTool::Ffmpeg,
                &["-hide_banner", "-filters"],
                "inspect_bundled_ffmpeg_filters",
            ),
        );
        let build_configuration = text_output(build_configuration?)?;
        for flag in &manifest.ffmpeg.required_build_flags {
            if !build_configuration.lines().any(|line| line.trim() == flag) {
                return Err(MediaToolchainError::new(
                    MediaToolchainProblem::IncompatibleBuild,
                ));
            }
        }
        assert_capabilities(encoders?, &target.required_capabilities.encoders)?;
        assert_capabilities(muxers?, &target.required_capabilities.muxers)?;
        assert_capabilities(filters?, &target.required_capabilities.filters)?;
        Ok(version)
    }

    async fn inspect_ffprobe(&self) -> Result<String, MediaToolchainError> {
        let version = self
            .run_verified_inspection(
                MediaTool::Ffprobe,
                &["-hide_banner", "-version"],
                "inspect_bundled_ffprobe_version",
            )
            .await?;
        parse_version_banner(&version, "ffprobe version ", &self.identity.full_version)
    }

    async fn run_verified_inspection(
        &self,
        tool: MediaTool,
        arguments: &[&str],
        operation: &'static str,
    ) -> Result<Vec<u8>, MediaToolchainError> {
        let program = match tool {
            MediaTool::Ffmpeg => self.verified_ffmpeg().await?,
            MediaTool::Ffprobe => self.verified_ffprobe().await?,
        };
        run_inspection(&program, arguments, operation).await
    }
}

#[derive(Debug, Clone, Copy)]
enum MediaTool {
    Ffmpeg,
    Ffprobe,
}

#[derive(Debug, Clone)]
struct ManifestIdentity {
    target: String,
    toolchain_id: String,
    short_version: String,
    full_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManifestError {
    Json,
    Schema,
    Identity,
    Archive,
    Target,
    Compliance,
    Review,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolchainManifest {
    schema_version: u64,
    toolchain_id: String,
    ffmpeg: FfmpegManifest,
    archive: ArchiveManifest,
    targets: BTreeMap<String, TargetManifest>,
    compliance: ComplianceManifest,
    distribution_review: DistributionReviewManifest,
}

impl ToolchainManifest {
    fn identity(&self) -> ManifestIdentity {
        ManifestIdentity {
            target: current_target().unwrap_or("unsupported").to_owned(),
            toolchain_id: self.toolchain_id.clone(),
            short_version: self.ffmpeg.short_version.clone(),
            full_version: self.ffmpeg.version.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FfmpegManifest {
    version: String,
    short_version: String,
    release_tag: String,
    source_commit: String,
    source_url: String,
    provider: String,
    provider_url: String,
    provider_build_date: String,
    variant: String,
    declared_license_class: String,
    architecture: String,
    required_build_flags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveManifest {
    url: String,
    filename: String,
    byte_length: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetManifest {
    architecture: String,
    resource_root: String,
    binaries: BinaryManifestSet,
    required_capabilities: RequiredCapabilities,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct BinaryManifestSet {
    ffmpeg: BinaryManifest,
    ffprobe: BinaryManifest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BinaryManifest {
    filename: String,
    resource_path: String,
    byte_length: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiredCapabilities {
    encoders: Vec<String>,
    muxers: Vec<String>,
    filters: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComplianceManifest {
    third_party_notices_path: String,
    license_paths: Vec<String>,
    provider_notice_path: String,
    source_offer_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DistributionReviewStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DistributionReviewManifest {
    status: DistributionReviewStatus,
    reviewed_by: Option<String>,
    reviewed_at: Option<String>,
    reference: Option<String>,
}

fn parse_manifest(raw: &str) -> Result<ToolchainManifest, ManifestError> {
    if raw.len() > MAX_MANIFEST_BYTES {
        return Err(ManifestError::Json);
    }
    let manifest: ToolchainManifest = serde_json::from_str(raw).map_err(|_| ManifestError::Json)?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &ToolchainManifest) -> Result<(), ManifestError> {
    if manifest.schema_version != 1 {
        return Err(ManifestError::Schema);
    }
    if manifest.toolchain_id != PINNED_TOOLCHAIN_ID
        || manifest.ffmpeg.version != "8.1.2-essentials_build-www.gyan.dev"
        || manifest.ffmpeg.short_version != "8.1.2"
        || manifest.ffmpeg.release_tag != "n8.1.2"
        || manifest.ffmpeg.source_commit != PINNED_SOURCE_COMMIT
        || manifest.ffmpeg.source_url != PINNED_SOURCE_URL
        || manifest
            .ffmpeg
            .source_url
            .strip_prefix(FFMPEG_COMMIT_URL_PREFIX)
            .is_none_or(|commit| commit != manifest.ffmpeg.source_commit)
        || manifest.ffmpeg.provider != "Gyan Doshi (gyan.dev)"
        || manifest.ffmpeg.provider_url != PINNED_PROVIDER_URL
        || manifest.ffmpeg.provider_build_date != PINNED_PROVIDER_BUILD_DATE
        || manifest.ffmpeg.variant != "release essentials"
        || manifest.ffmpeg.declared_license_class != "GPL-3.0-or-later"
        || manifest.ffmpeg.architecture != "x86_64"
    {
        return Err(ManifestError::Identity);
    }
    assert_exact_values(
        &manifest.ffmpeg.required_build_flags,
        &[
            "--enable-gpl",
            "--enable-version3",
            "--enable-static",
            "--enable-libx264",
            "--enable-libx265",
            "--enable-libzimg",
        ],
    )
    .map_err(|_| ManifestError::Identity)?;

    if manifest.archive.url != PINNED_ARCHIVE_URL
        || manifest.archive.filename != PINNED_ARCHIVE_FILENAME
        || manifest.archive.byte_length != PINNED_ARCHIVE_BYTE_LENGTH
        || manifest.archive.sha256 != PINNED_ARCHIVE_SHA256
    {
        return Err(ManifestError::Archive);
    }

    if manifest.targets.len() != 1 {
        return Err(ManifestError::Target);
    }
    let target = manifest
        .targets
        .get(SUPPORTED_TARGET)
        .ok_or(ManifestError::Target)?;
    if target.architecture != "x86_64"
        || target.resource_root != "media-tools"
        || !valid_binary(
            &target.binaries.ffmpeg,
            "ffmpeg.exe",
            "media-tools/ffmpeg.exe",
            101_897_728,
        )
        || !valid_binary(
            &target.binaries.ffprobe,
            "ffprobe.exe",
            "media-tools/ffprobe.exe",
            101_692_928,
        )
    {
        return Err(ManifestError::Target);
    }
    assert_exact_values(
        &target.required_capabilities.encoders,
        &["libx264", "aac", "mjpeg"],
    )
    .and_then(|()| assert_exact_values(&target.required_capabilities.muxers, &["mp4", "image2"]))
    .and_then(|()| {
        assert_exact_values(
            &target.required_capabilities.filters,
            &["scale", "fps", "pad", "tile", "setsar", "zscale", "tonemap"],
        )
    })
    .map_err(|_| ManifestError::Target)?;

    if manifest.compliance.third_party_notices_path != "media-tools/THIRD_PARTY_NOTICES.md"
        || manifest.compliance.license_paths != ["media-tools/licenses/GPL-3.0.txt"]
        || manifest.compliance.provider_notice_path != "media-tools/licenses/GYAN-FFMPEG-README.txt"
        || manifest.compliance.source_offer_path != "media-tools/SOURCE_OFFER.md"
    {
        return Err(ManifestError::Compliance);
    }

    let review_fields = [
        manifest.distribution_review.reviewed_by.as_deref(),
        manifest.distribution_review.reviewed_at.as_deref(),
        manifest.distribution_review.reference.as_deref(),
    ];
    match manifest.distribution_review.status {
        DistributionReviewStatus::Approved => {
            if manifest
                .distribution_review
                .reviewed_by
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
                || manifest
                    .distribution_review
                    .reviewed_at
                    .as_deref()
                    .is_none_or(|value| !valid_date(value))
                || manifest
                    .distribution_review
                    .reference
                    .as_deref()
                    .is_none_or(|value| !valid_https_evidence_reference(value))
            {
                return Err(ManifestError::Review);
            }
        }
        DistributionReviewStatus::Pending | DistributionReviewStatus::Rejected => {
            if review_fields.iter().any(Option::is_some) {
                return Err(ManifestError::Review);
            }
        }
    }
    Ok(())
}

fn valid_binary(binary: &BinaryManifest, filename: &str, resource_path: &str, len: u64) -> bool {
    binary.filename == filename
        && binary.resource_path == resource_path
        && binary.byte_length == len
        && is_lower_hex(&binary.sha256, 64)
        && valid_resource_path(&binary.resource_path)
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return false;
    }
    let year = value[0..4].parse::<i32>().ok();
    let month = value[5..7].parse::<u32>().ok();
    let day = value[8..10].parse::<u32>().ok();
    year.zip(month)
        .zip(day)
        .is_some_and(|((year, month), day)| {
            year != 0 && NaiveDate::from_ymd_opt(year, month, day).is_some()
        })
}

fn valid_https_evidence_reference(value: &str) -> bool {
    if !(12..=2048).contains(&value.len()) || !value.is_ascii() {
        return false;
    }
    let Some(remainder) = value.strip_prefix("https://") else {
        return false;
    };
    let Some((host, path)) = remainder.split_once('/') else {
        return false;
    };
    let labels = host.split('.').collect::<Vec<_>>();
    if host.len() > 253
        || labels.len() < 2
        || path.is_empty()
        || path
            .bytes()
            .any(|byte| !(b'!'..=b'~').contains(&byte) || matches!(byte, b'\\' | b'#'))
    {
        return false;
    }
    if labels.iter().any(|label| {
        label.is_empty()
            || label.len() > 63
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || !label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !label
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
    }) {
        return false;
    }
    labels.last().is_some_and(|label| {
        (2..=63).contains(&label.len()) && label.bytes().all(|byte| byte.is_ascii_alphabetic())
    })
}

fn is_lower_hex(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn assert_exact_values(actual: &[String], expected: &[&str]) -> Result<(), ()> {
    if actual.len() != expected.len()
        || actual.iter().any(|value| !valid_capability(value))
        || actual.iter().collect::<BTreeSet<_>>().len() != actual.len()
        || expected
            .iter()
            .any(|expected| !actual.iter().any(|value| value == expected))
    {
        return Err(());
    }
    Ok(())
}

fn valid_capability(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn valid_resource_path(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && Path::new(value).components().all(|component| {
            matches!(component, Component::Normal(_))
                && component
                    .as_os_str()
                    .to_str()
                    .is_some_and(|part| part != "..")
        })
}

fn current_target() -> Option<&'static str> {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some(SUPPORTED_TARGET)
    } else {
        None
    }
}

fn resolve_programs_from_resource_root(
    manifest: &ToolchainManifest,
    target_name: &str,
    resource_root: &Path,
) -> Result<StoredMediaPrograms, MediaToolchainError> {
    let target = manifest
        .targets
        .get(target_name)
        .ok_or_else(|| MediaToolchainError::new(MediaToolchainProblem::NotFound))?;
    let canonical_root = fs::canonicalize(resource_root)
        .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::NotFound))?;
    let ffmpeg = resolve_binary(&canonical_root, resource_root, &target.binaries.ffmpeg)
        .map(StoredBinary::Bundled);
    let ffprobe = resolve_binary(&canonical_root, resource_root, &target.binaries.ffprobe)
        .map(StoredBinary::Bundled);
    Ok(StoredMediaPrograms { ffmpeg, ffprobe })
}

fn resolve_binary(
    canonical_root: &Path,
    resource_root: &Path,
    binary: &BinaryManifest,
) -> Result<ResolvedBinary, MediaToolchainError> {
    if !valid_resource_path(&binary.resource_path) {
        return Err(MediaToolchainError::new(
            MediaToolchainProblem::IntegrityFailed,
        ));
    }
    let candidate = resource_root.join(&binary.resource_path);
    let metadata = fs::symlink_metadata(&candidate).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => MediaToolchainError::new(MediaToolchainProblem::NotFound),
        _ => MediaToolchainError::new(MediaToolchainProblem::IntegrityFailed),
    })?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata_has_reparse_point(&metadata)
        || metadata.len() != binary.byte_length
    {
        return Err(MediaToolchainError::new(
            MediaToolchainProblem::IntegrityFailed,
        ));
    }
    reject_linked_ancestors(&candidate, resource_root)?;
    let canonical_candidate = fs::canonicalize(&candidate)
        .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::IntegrityFailed))?;
    if !canonical_candidate.starts_with(canonical_root) {
        return Err(MediaToolchainError::new(
            MediaToolchainProblem::IntegrityFailed,
        ));
    }
    let hash = hash_file_exact(&canonical_candidate, binary.byte_length)?;
    if hash != binary.sha256 {
        return Err(MediaToolchainError::new(
            MediaToolchainProblem::IntegrityFailed,
        ));
    }
    Ok(ResolvedBinary {
        path: canonical_candidate,
        resource_root: resource_root.to_owned(),
        canonical_root: canonical_root.to_owned(),
        manifest: binary.clone(),
    })
}

#[cfg(test)]
fn stored_path(binary: &StoredBinary) -> &Path {
    match binary {
        StoredBinary::Bundled(binary) => &binary.path,
        #[cfg(test)]
        StoredBinary::Explicit(path) => path,
    }
}

async fn verify_stored_binary(binary: StoredBinary) -> Result<PathBuf, MediaToolchainError> {
    match binary {
        StoredBinary::Bundled(binary) => tokio::task::spawn_blocking(move || {
            let resolved = resolve_binary(
                &binary.canonical_root,
                &binary.resource_root,
                &binary.manifest,
            )?;
            if resolved.path != binary.path {
                return Err(MediaToolchainError::new(
                    MediaToolchainProblem::IntegrityFailed,
                ));
            }
            Ok(resolved.path)
        })
        .await
        .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::Failed))?,
        #[cfg(test)]
        StoredBinary::Explicit(path) => Ok(path),
    }
}

fn reject_linked_ancestors(
    candidate: &Path,
    resource_root: &Path,
) -> Result<(), MediaToolchainError> {
    let mut current = candidate.parent();
    while let Some(path) = current {
        if path == resource_root {
            break;
        }
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::IntegrityFailed))?;
        if metadata.file_type().is_symlink() || metadata_has_reparse_point(&metadata) {
            return Err(MediaToolchainError::new(
                MediaToolchainProblem::IntegrityFailed,
            ));
        }
        current = path.parent();
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_has_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0
}

#[cfg(not(windows))]
fn metadata_has_reparse_point(_metadata: &Metadata) -> bool {
    let _ = FILE_ATTRIBUTE_REPARSE_POINT_VALUE;
    false
}

fn hash_file_exact(path: &Path, expected_len: u64) -> Result<String, MediaToolchainError> {
    let file = File::open(path)
        .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::IntegrityFailed))?;
    let mut reader = file.take(expected_len.saturating_add(1));
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::IntegrityFailed))?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > expected_len {
            return Err(MediaToolchainError::new(
                MediaToolchainProblem::IntegrityFailed,
            ));
        }
        hasher.update(&buffer[..read]);
    }
    if total != expected_len {
        return Err(MediaToolchainError::new(
            MediaToolchainProblem::IntegrityFailed,
        ));
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn run_inspection(
    program: &Path,
    arguments: &[&str],
    operation: &'static str,
) -> Result<Vec<u8>, MediaToolchainError> {
    let output = run_supervised(
        ProcessSpec {
            program: program.as_os_str().to_owned(),
            args: arguments.iter().map(OsString::from).collect(),
            operation,
            timeout: INSPECTION_TIMEOUT,
            stdout_limit: INSPECTION_STDOUT_LIMIT,
            stderr_tail_limit: INSPECTION_STDERR_LIMIT,
        },
        ProcessCancellation::new(),
    )
    .await
    .map_err(map_inspection_failure)?;
    debug_assert!(output.status.success());
    let _ = (&output.stderr_tail, output.stderr_truncated);
    Ok(output.stdout)
}

fn map_inspection_failure(failure: ProcessFailure) -> MediaToolchainError {
    match failure {
        ProcessFailure::Spawn {
            kind: io::ErrorKind::NotFound,
            ..
        } => MediaToolchainError::new(MediaToolchainProblem::NotFound),
        ProcessFailure::Timeout { .. } => MediaToolchainError::new(MediaToolchainProblem::TimedOut),
        ProcessFailure::NonZero { .. }
        | ProcessFailure::StdoutLimit { .. }
        | ProcessFailure::Spawn { .. }
        | ProcessFailure::Cancelled { .. }
        | ProcessFailure::Io { .. } => MediaToolchainError::new(MediaToolchainProblem::Failed),
    }
}

fn text_output(bytes: Vec<u8>) -> Result<String, MediaToolchainError> {
    String::from_utf8(bytes)
        .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::IncompatibleBuild))
}

fn parse_version_banner(
    bytes: &[u8],
    prefix: &str,
    expected_version: &str,
) -> Result<String, MediaToolchainError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| MediaToolchainError::new(MediaToolchainProblem::IncompatibleBuild))?;
    let line = text
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| line.len() <= 256 && line.starts_with(prefix))
        .ok_or_else(|| MediaToolchainError::new(MediaToolchainProblem::IncompatibleBuild))?;
    if line
        .strip_prefix(prefix)
        .and_then(|version| version.split_whitespace().next())
        .is_none_or(|version| version != expected_version)
    {
        return Err(MediaToolchainError::new(
            MediaToolchainProblem::IncompatibleBuild,
        ));
    }
    Ok(line.to_owned())
}

fn assert_capabilities(bytes: Vec<u8>, required: &[String]) -> Result<(), MediaToolchainError> {
    let text = text_output(bytes)?;
    let available = text
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let flags = fields.next()?;
            let name = fields.next()?;
            (flags.len() <= 8
                && flags
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte == b'.'))
            .then(|| name.to_owned())
        })
        .collect::<BTreeSet<_>>();
    if required.iter().any(|name| !available.contains(name)) {
        return Err(MediaToolchainError::new(
            MediaToolchainProblem::IncompatibleBuild,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc, Mutex as StdMutex,
        },
    };

    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;

    use super::*;

    const VALIDATOR_PARITY_CORPUS: &str =
        include_str!("../../media-toolchain/validator-parity.v1.json");

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ValidatorParityCorpus {
        schema_version: u64,
        cases: Vec<ValidatorParityCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ValidatorParityCase {
        name: String,
        expected: bool,
        mutations: Vec<ValidatorMutation>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ValidatorMutation {
        path: String,
        value: Value,
    }

    fn compiled_manifest_value() -> Value {
        serde_json::from_str(COMPILED_MANIFEST).expect("compiled manifest fixture must parse")
    }

    fn mutated_manifest(
        mutator: impl FnOnce(&mut Value),
    ) -> Result<ToolchainManifest, ManifestError> {
        let mut value = compiled_manifest_value();
        mutator(&mut value);
        parse_manifest(&serde_json::to_string(&value).expect("mutated manifest must serialize"))
    }

    #[tokio::test(flavor = "current_thread")]
    async fn initialization_failure_transitions_to_unavailable() {
        let state = MediaToolchainState::start_for_test(Duration::from_secs(1), || {
            Err(MediaToolchainError::for_test(
                MediaToolchainProblem::IntegrityFailed,
            ))
        });
        let error = tokio::time::timeout(Duration::from_secs(1), state.ready())
            .await
            .expect("failed initialization must settle")
            .expect_err("failed initialization must be unavailable");
        assert_eq!(error.problem(), MediaToolchainProblem::IntegrityFailed);
        assert_eq!(
            state.phase_for_test(),
            MediaToolchainProblemOrPhase::Unavailable(MediaToolchainProblem::IntegrityFailed)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn initialization_timeout_transitions_once_to_unavailable() {
        let (release_sender, release_receiver) = mpsc::channel();
        let release_receiver = Arc::new(StdMutex::new(release_receiver));
        let state = MediaToolchainState::start_for_test(Duration::from_millis(25), move || {
            release_receiver
                .lock()
                .expect("timed-out resolver latch must lock")
                .recv()
                .expect("timed-out resolver latch must be released");
            Ok(MediaToolchain::from_test_programs(
                PathBuf::from("ffmpeg"),
                PathBuf::from("ffprobe"),
            ))
        });
        let error = tokio::time::timeout(Duration::from_secs(1), state.ready())
            .await
            .expect("timed initialization must settle")
            .expect_err("timed initialization must be unavailable");
        assert_eq!(error.problem(), MediaToolchainProblem::TimedOut);
        assert_eq!(
            state.phase_for_test(),
            MediaToolchainProblemOrPhase::Unavailable(MediaToolchainProblem::TimedOut)
        );

        release_sender
            .send(())
            .expect("timed-out resolver must be releasable");
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(
            state.phase_for_test(),
            MediaToolchainProblemOrPhase::Unavailable(MediaToolchainProblem::TimedOut),
            "late blocking completion must not overwrite the timeout"
        );
    }

    fn failed_test_toolchain(problem: MediaToolchainProblem) -> MediaToolchain {
        let manifest =
            parse_manifest(COMPILED_MANIFEST).expect("compiled media manifest must be valid");
        let mut identity = manifest.identity();
        identity.target = SUPPORTED_TARGET.to_owned();
        MediaToolchain {
            identity,
            programs: Err(MediaToolchainError::for_test(problem)),
            inspection_override: None,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unavailable_startup_re_resolves_after_resources_are_repaired() {
        let repaired = Arc::new(AtomicBool::new(false));
        let attempts = Arc::new(AtomicUsize::new(0));
        let state = MediaToolchainState::start_for_test(Duration::from_secs(1), {
            let repaired = repaired.clone();
            let attempts = attempts.clone();
            move || {
                attempts.fetch_add(1, Ordering::SeqCst);
                if repaired.load(Ordering::SeqCst) {
                    Ok(MediaToolchain::from_test_programs(
                        PathBuf::from("repaired-ffmpeg"),
                        PathBuf::from("repaired-ffprobe"),
                    ))
                } else {
                    Err(MediaToolchainError::for_test(
                        MediaToolchainProblem::NotFound,
                    ))
                }
            }
        });

        let startup_error = state
            .ready()
            .await
            .expect_err("missing startup resources must be unavailable");
        assert_eq!(startup_error.problem(), MediaToolchainProblem::NotFound);
        repaired.store(true, Ordering::SeqCst);

        let programs = state
            .ready_for_inspection()
            .await
            .expect("status retry must re-resolve repaired resources")
            .programs()
            .expect("repaired programs must be available");
        assert_eq!(programs.ffmpeg(), Path::new("repaired-ffmpeg"));
        assert_eq!(programs.ffprobe(), Path::new("repaired-ffprobe"));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(state.phase_for_test(), MediaToolchainProblemOrPhase::Ready);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn later_integrity_failure_invalidates_readiness_and_can_recover() {
        let repaired = Arc::new(AtomicBool::new(false));
        let state = MediaToolchainState::start_for_test(Duration::from_secs(1), {
            let repaired = repaired.clone();
            move || {
                if repaired.load(Ordering::SeqCst) {
                    Ok(MediaToolchain::from_test_programs(
                        PathBuf::from("repaired-ffmpeg"),
                        PathBuf::from("repaired-ffprobe"),
                    ))
                } else {
                    Ok(failed_test_toolchain(
                        MediaToolchainProblem::IntegrityFailed,
                    ))
                }
            }
        });
        let error = state
            .verified_ffmpeg()
            .await
            .expect_err("damaged ready toolchain must fail verification");
        assert_eq!(error.problem(), MediaToolchainProblem::IntegrityFailed);
        assert_eq!(
            state.phase_for_test(),
            MediaToolchainProblemOrPhase::Unavailable(MediaToolchainProblem::IntegrityFailed)
        );

        repaired.store(true, Ordering::SeqCst);
        state
            .ready_for_inspection()
            .await
            .expect("status retry must restore readiness after integrity repair");
        assert_eq!(state.phase_for_test(), MediaToolchainProblemOrPhase::Ready);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ordinary_verification_failure_does_not_invalidate_readiness() {
        let state =
            MediaToolchainState::from_ready(failed_test_toolchain(MediaToolchainProblem::Failed));
        let error = state
            .verified_programs()
            .await
            .expect_err("ordinary verification failure must be returned");
        assert_eq!(error.problem(), MediaToolchainProblem::Failed);
        assert_eq!(state.phase_for_test(), MediaToolchainProblemOrPhase::Ready);
    }

    #[test]
    fn compiled_manifest_is_exact_and_adversarial_mutations_fail_closed() {
        let manifest = parse_manifest(COMPILED_MANIFEST).expect("compiled manifest must validate");
        assert_eq!(
            manifest.toolchain_id,
            "ffmpeg-8.1.2-gyan-essentials-windows-x86_64"
        );
        assert_eq!(manifest.targets.len(), 1);

        assert_eq!(
            mutated_manifest(|value| value["schemaVersion"] = json!(2)).unwrap_err(),
            ManifestError::Schema
        );
        assert_eq!(
            mutated_manifest(|value| value["unexpected"] = json!(true)).unwrap_err(),
            ManifestError::Json
        );
        assert_eq!(
            mutated_manifest(
                |value| value["archive"]["url"] = json!("http://example.test/build.zip")
            )
            .unwrap_err(),
            ManifestError::Archive
        );
        assert_eq!(
            mutated_manifest(|value| value["archive"]["sha256"] = json!("A".repeat(64)))
                .unwrap_err(),
            ManifestError::Archive
        );
        assert_eq!(
            mutated_manifest(|value| {
                let targets = value["targets"]
                    .as_object_mut()
                    .expect("targets must be an object");
                let target = targets
                    .remove(SUPPORTED_TARGET)
                    .expect("supported target must exist");
                targets.insert("wrong-target".to_owned(), target);
            })
            .unwrap_err(),
            ManifestError::Target
        );
        assert_eq!(
            mutated_manifest(|value| {
                value["targets"][SUPPORTED_TARGET]["requiredCapabilities"]["encoders"] =
                    json!(["libx264", "libx264", "mjpeg"]);
            })
            .unwrap_err(),
            ManifestError::Target
        );
        assert_eq!(
            mutated_manifest(|value| {
                value["targets"][SUPPORTED_TARGET]["binaries"]["ffmpeg"]["resourcePath"] =
                    json!("../ffmpeg.exe");
            })
            .unwrap_err(),
            ManifestError::Target
        );
        assert_eq!(
            mutated_manifest(|value| value["distributionReview"]["status"] = json!("approved"))
                .unwrap_err(),
            ManifestError::Review
        );
    }

    #[test]
    fn provenance_and_review_acceptance_matrix_matches_bootstrap() {
        let corpus: ValidatorParityCorpus = serde_json::from_str(VALIDATOR_PARITY_CORPUS)
            .expect("validator parity corpus must parse");
        assert_eq!(corpus.schema_version, 1);
        assert_eq!(
            corpus
                .cases
                .iter()
                .map(|case| case.name.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            corpus.cases.len(),
            "validator parity case names must be unique"
        );

        for case in corpus.cases {
            let mut candidate = compiled_manifest_value();
            for mutation in case.mutations {
                let target = candidate.pointer_mut(&mutation.path).unwrap_or_else(|| {
                    panic!(
                        "validator parity mutation path does not exist: {} ({})",
                        mutation.path, case.name
                    )
                });
                *target = mutation.value;
            }
            let accepted = parse_manifest(
                &serde_json::to_string(&candidate)
                    .expect("validator parity candidate must serialize"),
            )
            .is_ok();
            assert_eq!(
                accepted, case.expected,
                "manifest matrix case '{}' expected acceptance={}",
                case.name, case.expected
            );
        }
    }

    fn small_binary(resource_path: &str, bytes: &[u8]) -> BinaryManifest {
        BinaryManifest {
            filename: "ffmpeg.exe".to_owned(),
            resource_path: resource_path.to_owned(),
            byte_length: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    #[test]
    fn resolver_accepts_only_contained_regular_files_with_exact_hashes() {
        let workspace = tempdir().expect("resolver workspace must exist");
        let resource_root = workspace.path().join("resources");
        let media_tools = resource_root.join("media-tools");
        fs::create_dir_all(&media_tools).expect("media-tool resource directory must exist");
        let path = media_tools.join("ffmpeg.exe");
        let payload = b"small deterministic executable fixture";
        fs::write(&path, payload).expect("resolver fixture must be writable");
        let canonical_root =
            fs::canonicalize(&resource_root).expect("resource root must canonicalize");
        let binary = small_binary("media-tools/ffmpeg.exe", payload);

        let resolved = resolve_binary(&canonical_root, &resource_root, &binary)
            .expect("exact contained fixture must resolve");
        assert_eq!(
            resolved.path,
            fs::canonicalize(&path).expect("fixture must canonicalize")
        );

        fs::write(&path, b"tampered fixture with the same length!!")
            .expect("fixture must be tamperable");
        let error = resolve_binary(&canonical_root, &resource_root, &binary)
            .expect_err("tampered fixture must fail");
        assert_eq!(error.problem(), MediaToolchainProblem::IntegrityFailed);

        let missing = small_binary("media-tools/missing.exe", payload);
        let error = resolve_binary(&canonical_root, &resource_root, &missing)
            .expect_err("missing fixture must fail");
        assert_eq!(error.problem(), MediaToolchainProblem::NotFound);

        let escaped = small_binary("../outside.exe", payload);
        let error = resolve_binary(&canonical_root, &resource_root, &escaped)
            .expect_err("escaping fixture path must fail");
        assert_eq!(error.problem(), MediaToolchainProblem::IntegrityFailed);
    }

    #[test]
    fn resolver_preserves_each_binary_outcome_when_only_one_is_missing() {
        let workspace = tempdir().expect("resolver workspace must exist");
        let resource_root = workspace.path().join("resources");
        let media_tools = resource_root.join("media-tools");
        fs::create_dir_all(&media_tools).expect("media-tool resource directory must exist");
        let ffmpeg_payload = b"independent ffmpeg fixture";
        let ffprobe_payload = b"independent ffprobe fixture";
        let mut manifest =
            parse_manifest(COMPILED_MANIFEST).expect("compiled manifest must validate");
        let target = manifest
            .targets
            .get_mut(SUPPORTED_TARGET)
            .expect("supported target must exist");
        target.binaries.ffmpeg = small_binary("media-tools/ffmpeg.exe", ffmpeg_payload);
        target.binaries.ffprobe = small_binary("media-tools/ffprobe.exe", ffprobe_payload);

        fs::write(media_tools.join("ffprobe.exe"), ffprobe_payload)
            .expect("FFprobe fixture must be writable");
        let ffmpeg_missing =
            resolve_programs_from_resource_root(&manifest, SUPPORTED_TARGET, &resource_root)
                .expect("resource root must resolve");
        assert_eq!(
            ffmpeg_missing.ffmpeg.unwrap_err().problem(),
            MediaToolchainProblem::NotFound
        );
        assert!(ffmpeg_missing.ffprobe.is_ok());

        fs::remove_file(media_tools.join("ffprobe.exe"))
            .expect("FFprobe fixture must be removable");
        fs::write(media_tools.join("ffmpeg.exe"), ffmpeg_payload)
            .expect("FFmpeg fixture must be writable");
        let ffprobe_missing =
            resolve_programs_from_resource_root(&manifest, SUPPORTED_TARGET, &resource_root)
                .expect("resource root must resolve");
        assert!(ffprobe_missing.ffmpeg.is_ok());
        assert_eq!(
            ffprobe_missing.ffprobe.unwrap_err().problem(),
            MediaToolchainProblem::NotFound
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn inspection_preserves_each_binary_verification_failure() {
        let manifest = parse_manifest(COMPILED_MANIFEST).expect("compiled manifest must validate");
        let mut identity = manifest.identity();
        identity.target = SUPPORTED_TARGET.to_owned();
        let toolchain = MediaToolchain {
            identity,
            programs: Ok(StoredMediaPrograms {
                ffmpeg: Err(MediaToolchainError::for_test(
                    MediaToolchainProblem::IntegrityFailed,
                )),
                ffprobe: Err(MediaToolchainError::for_test(
                    MediaToolchainProblem::NotFound,
                )),
            }),
            inspection_override: None,
        };

        let inspection = toolchain.inspect().await;
        assert_eq!(
            inspection.ffmpeg_version.unwrap_err().problem(),
            MediaToolchainProblem::IntegrityFailed
        );
        assert_eq!(
            inspection.ffprobe_version.unwrap_err().problem(),
            MediaToolchainProblem::NotFound
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pre_spawn_verification_rejects_replaced_resolved_binaries() {
        let workspace = tempdir().expect("verification workspace must exist");
        let resource_root = workspace.path().join("resources");
        let media_tools = resource_root.join("media-tools");
        fs::create_dir_all(&media_tools).expect("media-tool resource directory must exist");
        let ffmpeg_path = media_tools.join("ffmpeg.exe");
        let ffprobe_path = media_tools.join("ffprobe.exe");
        let ffmpeg_payload = b"trusted ffmpeg payload";
        let ffprobe_payload = b"trusted ffprobe payload";
        fs::write(&ffmpeg_path, ffmpeg_payload).expect("FFmpeg fixture must be writable");
        fs::write(&ffprobe_path, ffprobe_payload).expect("FFprobe fixture must be writable");
        let canonical_root =
            fs::canonicalize(&resource_root).expect("resource root must canonicalize");
        let ffmpeg = resolve_binary(
            &canonical_root,
            &resource_root,
            &small_binary("media-tools/ffmpeg.exe", ffmpeg_payload),
        )
        .expect("trusted FFmpeg must resolve");
        let ffprobe = resolve_binary(
            &canonical_root,
            &resource_root,
            &small_binary("media-tools/ffprobe.exe", ffprobe_payload),
        )
        .expect("trusted FFprobe must resolve");
        let manifest = parse_manifest(COMPILED_MANIFEST).expect("compiled manifest must validate");
        let mut identity = manifest.identity();
        identity.target = SUPPORTED_TARGET.to_owned();
        let toolchain = MediaToolchain {
            identity,
            programs: Ok(StoredMediaPrograms {
                ffmpeg: Ok(StoredBinary::Bundled(ffmpeg)),
                ffprobe: Ok(StoredBinary::Bundled(ffprobe)),
            }),
            inspection_override: None,
        };
        toolchain
            .verified_programs()
            .await
            .expect("unchanged resolved programs must reverify");

        fs::write(&ffmpeg_path, b"hostile ffmpeg payload")
            .expect("FFmpeg fixture must be replaceable");
        fs::write(&ffprobe_path, b"hostile ffprobe payload")
            .expect("FFprobe fixture must be replaceable");

        for error in [
            toolchain.verified_ffmpeg().await.unwrap_err(),
            toolchain.verified_ffprobe().await.unwrap_err(),
            toolchain.verified_programs().await.unwrap_err(),
        ] {
            assert_eq!(error.problem(), MediaToolchainProblem::IntegrityFailed);
        }
        let inspection = toolchain.inspect().await;
        assert_eq!(
            inspection.ffmpeg_version.unwrap_err().problem(),
            MediaToolchainProblem::IntegrityFailed
        );
        assert_eq!(
            inspection.ffprobe_version.unwrap_err().problem(),
            MediaToolchainProblem::IntegrityFailed
        );
        assert!(
            !workspace.path().join("replacement-started").exists(),
            "a replacement must never be spawned after integrity verification fails"
        );
    }

    #[test]
    fn unavailable_resource_root_and_wrong_target_are_not_found() {
        let workspace = tempdir().expect("resolver workspace must exist");
        let toolchain =
            MediaToolchain::resolve_from_resource_root(&workspace.path().join("missing"));
        assert_eq!(
            toolchain.programs().unwrap_err().problem(),
            MediaToolchainProblem::NotFound
        );
        let manifest = parse_manifest(COMPILED_MANIFEST).expect("compiled manifest must validate");
        let error =
            resolve_programs_from_resource_root(&manifest, "wrong-target", workspace.path())
                .expect_err("unknown target must fail closed");
        assert_eq!(error.problem(), MediaToolchainProblem::NotFound);
    }

    #[test]
    fn version_and_capability_inspection_rejects_incompatible_output() {
        let banner = b"ffmpeg version 8.1.2-essentials_build-www.gyan.dev Copyright\n";
        assert_eq!(
            parse_version_banner(
                banner,
                "ffmpeg version ",
                "8.1.2-essentials_build-www.gyan.dev"
            )
            .expect("exact version must parse"),
            "ffmpeg version 8.1.2-essentials_build-www.gyan.dev Copyright"
        );
        assert_eq!(
            parse_version_banner(b"ffmpeg version latest\n", "ffmpeg version ", "8.1.2")
                .unwrap_err()
                .problem(),
            MediaToolchainProblem::IncompatibleBuild
        );
        assert_eq!(
            parse_version_banner(b"ffmpeg version 8.1.2\n", "ffprobe version ", "8.1.2")
                .unwrap_err()
                .problem(),
            MediaToolchainProblem::IncompatibleBuild
        );

        let required = vec!["libx264".to_owned(), "aac".to_owned()];
        assert_capabilities(
            b" V....D libx264 encoder\n A....D aac encoder\n".to_vec(),
            &required,
        )
        .expect("required capabilities must be recognized");
        assert_eq!(
            assert_capabilities(b" V....D libx264 encoder\n".to_vec(), &required)
                .unwrap_err()
                .problem(),
            MediaToolchainProblem::IncompatibleBuild
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolver_rejects_symlinked_binary() {
        use std::os::unix::fs::symlink;

        let workspace = tempdir().expect("symlink workspace must exist");
        let resource_root = workspace.path().join("resources");
        let media_tools = resource_root.join("media-tools");
        fs::create_dir_all(&media_tools).expect("media-tool directory must exist");
        let outside = workspace.path().join("outside.exe");
        let payload = b"outside fixture";
        fs::write(&outside, payload).expect("outside fixture must be writable");
        symlink(&outside, media_tools.join("ffmpeg.exe")).expect("test symlink must be created");
        let canonical_root =
            fs::canonicalize(&resource_root).expect("resource root must canonicalize");
        let error = resolve_binary(
            &canonical_root,
            &resource_root,
            &small_binary("media-tools/ffmpeg.exe", payload),
        )
        .expect_err("symlinked binary must fail");
        assert_eq!(error.problem(), MediaToolchainProblem::IntegrityFailed);
    }

    #[cfg(windows)]
    #[test]
    fn resolver_rejects_symlinked_binary_when_creation_is_permitted() {
        use std::os::windows::fs::symlink_file;

        let workspace = tempdir().expect("symlink workspace must exist");
        let resource_root = workspace.path().join("resources");
        let media_tools = resource_root.join("media-tools");
        fs::create_dir_all(&media_tools).expect("media-tool directory must exist");
        let outside = workspace.path().join("outside.exe");
        let payload = b"outside fixture";
        fs::write(&outside, payload).expect("outside fixture must be writable");
        if symlink_file(&outside, media_tools.join("ffmpeg.exe")).is_err() {
            return;
        }
        let canonical_root =
            fs::canonicalize(&resource_root).expect("resource root must canonicalize");
        let error = resolve_binary(
            &canonical_root,
            &resource_root,
            &small_binary("media-tools/ffmpeg.exe", payload),
        )
        .expect_err("symlinked binary must fail");
        assert_eq!(error.problem(), MediaToolchainProblem::IntegrityFailed);
    }
}
