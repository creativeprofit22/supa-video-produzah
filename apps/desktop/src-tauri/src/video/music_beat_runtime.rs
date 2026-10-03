//! The managed music-beat runtime: a user-chosen folder holding the pinned Beat This! ONNX
//! models and, optionally, a GPU pack (ONNX Runtime with CUDA). Detection itself runs in the
//! bundled `supa-beat-detect` sidecar (ADR 0004).
//!
//! The folder is checked against the embedded manifest (SHA-256 and size of every file) and the
//! sidecar is probed once on it. Models are re-hashed right before each run; the GPU pack is
//! rechecked by size and modification time, and a pack that changed runs that job on the CPU.
//! When the runtime is not ready, music beat detection uses the in-app tempo fallback instead.

use std::{
    ffi::OsString,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    error::VideoCommandError,
    media_store::is_reparse_or_symlink,
    process::{ProcessCancellation, ProcessFailure, ProcessSpec, SupervisedOutput},
};

const OPERATION: &str = "detect_music_beats";
const MANIFEST_JSON: &str = include_str!("beat-detect-runtime-manifest.json");
const MANIFEST_SCHEMA_VERSION: u8 = 2;
/// File names the sidecar loads from the models folder, by manifest role.
const MEL_MODEL_FILE: &str = "mel_spectrogram.onnx";
const BEAT_MODEL_FILE: &str = "beat_this.onnx";
/// Executable name used in process errors.
const SIDECAR_NAME: &str = "supa-beat-detect";
pub(crate) const MUSIC_BEAT_SETTINGS_FILE: &str = "music-beat-settings.json";
const MAX_SETTINGS_BYTES: u64 = 16 * 1024;
const MAX_RUNTIME_PATH_CHARS: usize = 1_024;
const HASH_BUFFER_BYTES: usize = 1 << 20;
/// Loading the GPU pack from a cold disk cache takes ~20 s on the development machine.
const PROBE_TIMEOUT: Duration = Duration::from_secs(180);
const PROBE_STDOUT_LIMIT: usize = 4 * 1024;
/// An hour of audio takes ~5 minutes on the CPU; the limit leaves wide headroom.
const DETECT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const DETECT_STDOUT_LIMIT: usize = 4 * 1024 * 1024;
const STDERR_TAIL_LIMIT: usize = 8 * 1024;
/// Sidecar exit code for bad input (arguments or WAV); anything else may be device-related.
const SIDECAR_EXIT_BAD_INPUT: i32 = 2;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MusicBeatRuntimeManifest {
    pub(crate) schema_version: u8,
    pub(crate) detector: ManifestDetector,
    pub(crate) models: ManifestModels,
    pub(crate) gpu_pack: ManifestGpuPack,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestDetector {
    pub(crate) kind: String,
    /// Detector identity recorded in analyses (`rs-<crate version>`).
    pub(crate) version: String,
    #[serde(rename = "crate")]
    pub(crate) crate_name: String,
    /// The `beat-this` crate version the sidecar must report from `probe`.
    pub(crate) crate_version: String,
    pub(crate) source_repository: String,
    pub(crate) source_revision: String,
    pub(crate) reference_repository: String,
    pub(crate) reference_revision: String,
    pub(crate) reference_checkpoint: ManifestReferenceCheckpoint,
    pub(crate) license: ManifestLicense,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestReferenceCheckpoint {
    pub(crate) name: String,
    pub(crate) file: String,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestLicense {
    pub(crate) spdx: String,
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) attribution: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestModels {
    pub(crate) folder: String,
    pub(crate) files: Vec<ManifestModelFile>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestModelFile {
    pub(crate) role: String,
    pub(crate) file: String,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
    pub(crate) url: String,
    pub(crate) license: ManifestLicense,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestGpuPack {
    pub(crate) folder: String,
    pub(crate) archives: Vec<ManifestArchive>,
    pub(crate) files: Vec<ManifestPackFile>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestArchive {
    pub(crate) id: String,
    pub(crate) url: String,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
    pub(crate) license: ManifestLicense,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestPackFile {
    pub(crate) file: String,
    pub(crate) archive: String,
    pub(crate) archive_path: String,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
}

impl MusicBeatRuntimeManifest {
    fn model(&self, role: &str) -> Option<&ManifestModelFile> {
        self.models.files.iter().find(|model| model.role == role)
    }

    fn beat_model_sha256(&self) -> &str {
        self.model("beat").map_or("", |model| model.sha256.as_str())
    }
}

/// The embedded manifest. It is a compile-time constant, so a parse failure
/// is a build defect caught by `pinned_manifest_is_valid`.
pub(crate) fn pinned_manifest() -> MusicBeatRuntimeManifest {
    serde_json::from_str(MANIFEST_JSON).unwrap_or_else(|_| unreachable!("embedded manifest"))
}

pub(crate) fn pinned_manifest_sha256() -> String {
    format!("{:x}", Sha256::digest(MANIFEST_JSON.as_bytes()))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A single plain file or folder name: no separators, traversal or roots.
fn is_plain_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn is_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_+".contains(&byte))
}

pub(crate) fn validate_manifest(manifest: &MusicBeatRuntimeManifest) -> bool {
    let pinned_file = |sha256: &str, byte_length: u64, file: &str| {
        is_sha256(sha256) && byte_length > 0 && is_plain_name(file)
    };
    let model_ok = |role: &str, expected_file: &str| {
        manifest
            .models
            .files
            .iter()
            .filter(|model| model.role == role)
            .count()
            == 1
            && manifest.model(role).is_some_and(|model| {
                model.file == expected_file
                    && pinned_file(&model.sha256, model.byte_length, &model.file)
            })
    };
    manifest.schema_version == MANIFEST_SCHEMA_VERSION
        && manifest.detector.kind == "beat_this"
        && is_version(&manifest.detector.version)
        && manifest.detector.version == format!("rs-{}", manifest.detector.crate_version)
        && manifest.models.files.len() == 2
        && model_ok("mel", MEL_MODEL_FILE)
        && model_ok("beat", BEAT_MODEL_FILE)
        && is_plain_name(&manifest.models.folder)
        && is_plain_name(&manifest.gpu_pack.folder)
        && manifest.models.folder != manifest.gpu_pack.folder
        && !manifest.gpu_pack.files.is_empty()
        && manifest
            .gpu_pack
            .files
            .iter()
            .all(|file| pinned_file(&file.sha256, file.byte_length, &file.file))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MusicBeatSettingsV1 {
    pub(crate) schema_version: u8,
    pub(crate) runtime_folder: Option<String>,
}

fn default_settings() -> MusicBeatSettingsV1 {
    MusicBeatSettingsV1 {
        schema_version: 1,
        runtime_folder: None,
    }
}

fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(MUSIC_BEAT_SETTINGS_FILE)
}

fn valid_runtime_folder(folder: &str) -> bool {
    !folder.is_empty()
        && folder.chars().count() <= MAX_RUNTIME_PATH_CHARS
        && Path::new(folder).is_absolute()
        && !folder.chars().any(char::is_control)
}

/// A missing, corrupt or oversized file reads as "not configured", which
/// selects the in-app fallback rather than blocking detection.
pub(crate) fn load_settings(config_dir: &Path) -> MusicBeatSettingsV1 {
    let path = settings_path(config_dir);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return default_settings();
    };
    if !metadata.is_file() || metadata.len() > MAX_SETTINGS_BYTES {
        return default_settings();
    }
    let Ok(bytes) = fs::read(&path) else {
        return default_settings();
    };
    match serde_json::from_slice::<MusicBeatSettingsV1>(&bytes) {
        Ok(settings)
            if settings.schema_version == 1
                && settings
                    .runtime_folder
                    .as_deref()
                    .is_none_or(valid_runtime_folder) =>
        {
            settings
        }
        _ => default_settings(),
    }
}

fn settings_io(category: &'static str) -> VideoCommandError {
    VideoCommandError::project_io("set_music_beat_runtime", category)
}

pub(crate) fn save_settings(
    config_dir: &Path,
    settings: &MusicBeatSettingsV1,
) -> Result<(), VideoCommandError> {
    if settings.schema_version != 1
        || !settings
            .runtime_folder
            .as_deref()
            .is_none_or(valid_runtime_folder)
    {
        return Err(settings_io("invalid"));
    }
    fs::create_dir_all(config_dir).map_err(|_| settings_io("create_dir"))?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| settings_io("serialize"))?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(config_dir).map_err(|_| settings_io("temporary"))?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| settings_io("write"))?;
    temporary
        .persist(settings_path(config_dir))
        .map_err(|_| settings_io("publish"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Verification and status
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub(crate) enum MusicBeatRuntimeProblem {
    FolderMissing,
    LinkedPath,
    ModelMissing,
    ModelMismatch,
    /// This build does not include the `supa-beat-detect` sidecar.
    DetectorMissing,
    /// The detector could not load the models.
    ProbeFailed,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum MusicBeatRuntimeAvailability {
    NotConfigured,
    Ready,
    Unavailable { problem: MusicBeatRuntimeProblem },
}

/// Why a ready runtime runs on the CPU.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MusicBeatCpuReason {
    NoGpuPack,
    GpuPackMismatch,
    CudaInitFailed,
}

/// The device a ready runtime will run on.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum MusicBeatAccelerator {
    Cuda,
    Cpu { reason: MusicBeatCpuReason },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicBeatRuntimeStatus {
    pub(crate) runtime_folder: Option<String>,
    pub(crate) runtime: MusicBeatRuntimeAvailability,
    /// Set when `runtime` is ready.
    pub(crate) accelerator: Option<MusicBeatAccelerator>,
    pub(crate) manifest_sha256: String,
    /// Detector version recorded in analyses (`rs-1.1.0`).
    pub(crate) beat_this_version: String,
    /// SHA-256 of the beat model (`beat_this.onnx`) that runs.
    pub(crate) checkpoint_sha256: String,
}

/// A model file whose digest matched the manifest at verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedModelFile {
    pub(crate) path: PathBuf,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
}

/// A GPU pack file as it was when its digest matched the manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GpuPackFileSnapshot {
    pub(crate) path: PathBuf,
    pub(crate) byte_length: u64,
    pub(crate) modified: SystemTime,
}

/// A runtime folder whose files matched the manifest and on which the sidecar's probe succeeded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedMusicBeatRuntime {
    pub(crate) sidecar: PathBuf,
    pub(crate) models_dir: PathBuf,
    pub(crate) models: Vec<VerifiedModelFile>,
    /// The verified GPU pack, only when the probe ran on CUDA with it.
    pub(crate) gpu_pack: Option<(PathBuf, Vec<GpuPackFileSnapshot>)>,
    pub(crate) accelerator: MusicBeatAccelerator,
    pub(crate) detector_version: String,
    pub(crate) beat_model_sha256: String,
}

impl VerifiedMusicBeatRuntime {
    /// Re-hashes the models right before a run, so a file swapped after verification is never
    /// loaded. Returns the GPU pack folder to use, or `None` (CPU) when the pack changed since
    /// verification by size or modification time.
    pub(crate) async fn recheck_before_run(&self) -> Result<Option<PathBuf>, VideoCommandError> {
        let models = self.models.clone();
        let gpu_pack = self.gpu_pack.clone();
        let (models_match, gpu_pack) = tauri::async_runtime::spawn_blocking(move || {
            let models_match = models.iter().all(|model| {
                file_digest(&model.path, model.byte_length)
                    .is_ok_and(|digest| digest == model.sha256)
            });
            let gpu_pack = gpu_pack.and_then(|(folder, files)| {
                let unchanged = files.iter().all(|file| {
                    fs::symlink_metadata(&file.path).is_ok_and(|metadata| {
                        metadata.is_file()
                            && !is_reparse_or_symlink(&metadata)
                            && metadata.len() == file.byte_length
                            && metadata
                                .modified()
                                .is_ok_and(|modified| modified == file.modified)
                    })
                });
                if !unchanged {
                    eprintln!("music_beats.gpu_pack_changed folder={folder:?} fallback=cpu");
                }
                unchanged.then_some(folder)
            });
            (models_match, gpu_pack)
        })
        .await
        .unwrap_or((false, None));
        if models_match {
            Ok(gpu_pack)
        } else {
            Err(VideoCommandError::tool_unavailable(OPERATION, "beat_this"))
        }
    }
}

/// Streams `path` through SHA-256, failing when it is not a plain file of `expected_len` bytes.
fn file_digest(path: &Path, expected_len: u64) -> Result<String, FileCheck> {
    let metadata = fs::symlink_metadata(path).map_err(|_| FileCheck::Missing)?;
    if is_reparse_or_symlink(&metadata) {
        return Err(FileCheck::Linked);
    }
    if !metadata.is_file() {
        return Err(FileCheck::Missing);
    }
    if metadata.len() != expected_len {
        return Err(FileCheck::Mismatch);
    }
    let file = File::open(path).map_err(|_| FileCheck::Missing)?;
    let mut reader = file.take(expected_len.saturating_add(1));
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut total = 0_u64;
    loop {
        let read = reader.read(&mut buffer).map_err(|_| FileCheck::Missing)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
    }
    if total != expected_len {
        return Err(FileCheck::Mismatch);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileCheck {
    Missing,
    Linked,
    Mismatch,
}

/// Checks that `path` is a real (non-linked) directory.
fn plain_directory(path: &Path) -> Result<(), FileCheck> {
    let metadata = fs::symlink_metadata(path).map_err(|_| FileCheck::Missing)?;
    if is_reparse_or_symlink(&metadata) {
        return Err(FileCheck::Linked);
    }
    if metadata.is_dir() {
        Ok(())
    } else {
        Err(FileCheck::Missing)
    }
}

/// Result of checking the folder's files (blocking file work).
#[derive(Debug)]
struct VerifiedFiles {
    models_dir: PathBuf,
    models: Vec<VerifiedModelFile>,
    gpu_pack: Result<(PathBuf, Vec<GpuPackFileSnapshot>), MusicBeatCpuReason>,
}

fn verify_runtime_files(
    folder: &Path,
    manifest: &MusicBeatRuntimeManifest,
) -> Result<VerifiedFiles, MusicBeatRuntimeProblem> {
    plain_directory(folder).map_err(|check| match check {
        FileCheck::Linked => MusicBeatRuntimeProblem::LinkedPath,
        _ => MusicBeatRuntimeProblem::FolderMissing,
    })?;
    let folder = fs::canonicalize(folder).map_err(|_| MusicBeatRuntimeProblem::FolderMissing)?;

    let models_dir = folder.join(&manifest.models.folder);
    plain_directory(&models_dir).map_err(|check| match check {
        FileCheck::Linked => MusicBeatRuntimeProblem::LinkedPath,
        _ => MusicBeatRuntimeProblem::ModelMissing,
    })?;
    let mut models = Vec::with_capacity(manifest.models.files.len());
    for model in &manifest.models.files {
        let path = models_dir.join(&model.file);
        let digest = file_digest(&path, model.byte_length).map_err(|check| match check {
            FileCheck::Missing => MusicBeatRuntimeProblem::ModelMissing,
            FileCheck::Linked => MusicBeatRuntimeProblem::LinkedPath,
            FileCheck::Mismatch => MusicBeatRuntimeProblem::ModelMismatch,
        })?;
        if digest != model.sha256 {
            return Err(MusicBeatRuntimeProblem::ModelMismatch);
        }
        models.push(VerifiedModelFile {
            path,
            byte_length: model.byte_length,
            sha256: digest,
        });
    }

    Ok(VerifiedFiles {
        models_dir,
        models,
        gpu_pack: verify_gpu_pack(&folder.join(&manifest.gpu_pack.folder), manifest),
    })
}

fn verify_gpu_pack(
    pack: &Path,
    manifest: &MusicBeatRuntimeManifest,
) -> Result<(PathBuf, Vec<GpuPackFileSnapshot>), MusicBeatCpuReason> {
    match plain_directory(pack) {
        Ok(()) => {}
        Err(FileCheck::Missing) => return Err(MusicBeatCpuReason::NoGpuPack),
        Err(_) => return Err(MusicBeatCpuReason::GpuPackMismatch),
    }
    let mut snapshots = Vec::with_capacity(manifest.gpu_pack.files.len());
    for file in &manifest.gpu_pack.files {
        let path = pack.join(&file.file);
        let modified = fs::symlink_metadata(&path)
            .and_then(|metadata| metadata.modified())
            .map_err(|_| MusicBeatCpuReason::GpuPackMismatch)?;
        let digest = file_digest(&path, file.byte_length)
            .map_err(|_| MusicBeatCpuReason::GpuPackMismatch)?;
        if digest != file.sha256 {
            return Err(MusicBeatCpuReason::GpuPackMismatch);
        }
        snapshots.push(GpuPackFileSnapshot {
            path,
            byte_length: file.byte_length,
            modified,
        });
    }
    Ok((pack.to_path_buf(), snapshots))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeOutput {
    version: String,
    device: SidecarDevice,
    cuda_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SidecarDevice {
    Cuda,
    Cpu,
}

impl SidecarDevice {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Cuda => "cuda",
            Self::Cpu => "cpu",
        }
    }
}

fn sidecar_args(command: &str, models_dir: &Path, gpu_pack: Option<&Path>) -> Vec<OsString> {
    let mut args = vec![
        OsString::from(command),
        OsString::from("--models"),
        models_dir.as_os_str().to_owned(),
    ];
    if let Some(pack) = gpu_pack {
        args.push(OsString::from("--cuda"));
        args.push(pack.as_os_str().to_owned());
    }
    args
}

async fn probe_once(
    sidecar: &Path,
    models_dir: &Path,
    gpu_pack: Option<&Path>,
) -> Result<ProbeOutput, MusicBeatRuntimeProblem> {
    let output = run_music_beat_process(
        ProcessSpec {
            program: sidecar.as_os_str().to_owned(),
            args: sidecar_args("probe", models_dir, gpu_pack),
            current_dir: None,
            operation: OPERATION,
            timeout: PROBE_TIMEOUT,
            stdout_limit: PROBE_STDOUT_LIMIT,
            stderr_tail_limit: STDERR_TAIL_LIMIT,
        },
        ProcessCancellation::new(),
        "probe",
    )
    .await
    .map_err(|_| MusicBeatRuntimeProblem::ProbeFailed)?;
    serde_json::from_slice(&output.stdout).map_err(|_| MusicBeatRuntimeProblem::ProbeFailed)
}

/// Loads both models in the sidecar (CUDA when a verified pack is given) and runs one second of
/// silence. A pack whose CUDA setup crashes the process is retried without it.
async fn probe_sidecar(
    sidecar: &Path,
    models_dir: &Path,
    gpu_pack: Option<&Path>,
    manifest: &MusicBeatRuntimeManifest,
) -> Result<SidecarDevice, MusicBeatRuntimeProblem> {
    let probed = match probe_once(sidecar, models_dir, gpu_pack).await {
        Err(_) if gpu_pack.is_some() => {
            eprintln!("music_beats.probe_cuda_crashed retry=cpu");
            probe_once(sidecar, models_dir, None).await?
        }
        result => result?,
    };
    if probed.version != manifest.detector.crate_version {
        return Err(MusicBeatRuntimeProblem::ProbeFailed);
    }
    if let Some(error) = probed.cuda_error.as_deref() {
        eprintln!(
            "music_beats.probe_cuda_failed error={:?}",
            error.chars().take(512).collect::<String>()
        );
    }
    Ok(probed.device)
}

pub(crate) async fn verify_runtime_folder(
    folder: &Path,
    sidecar: Option<&Path>,
    manifest: &MusicBeatRuntimeManifest,
) -> Result<VerifiedMusicBeatRuntime, MusicBeatRuntimeProblem> {
    // Paths below are joined from manifest values, so an invalid manifest
    // fails closed before any file access.
    if !validate_manifest(manifest) {
        return Err(MusicBeatRuntimeProblem::FolderMissing);
    }
    let started = std::time::Instant::now();
    let owned_folder = folder.to_path_buf();
    let owned_manifest = manifest.clone();
    let files = tauri::async_runtime::spawn_blocking(move || {
        verify_runtime_files(&owned_folder, &owned_manifest)
    })
    .await
    .map_err(|_| MusicBeatRuntimeProblem::FolderMissing)??;
    let sidecar = sidecar
        .filter(|path| path.is_file())
        .ok_or(MusicBeatRuntimeProblem::DetectorMissing)?;
    let pack_folder = files
        .gpu_pack
        .as_ref()
        .ok()
        .map(|(folder, _)| folder.as_path());
    let device = probe_sidecar(sidecar, &files.models_dir, pack_folder, manifest).await?;
    let (accelerator, gpu_pack) = match (files.gpu_pack, device) {
        (Ok(pack), SidecarDevice::Cuda) => (MusicBeatAccelerator::Cuda, Some(pack)),
        (Ok(_), SidecarDevice::Cpu) => (
            MusicBeatAccelerator::Cpu {
                reason: MusicBeatCpuReason::CudaInitFailed,
            },
            None,
        ),
        (Err(reason), _) => (MusicBeatAccelerator::Cpu { reason }, None),
    };
    eprintln!(
        "music_beats.runtime_verify ready=true accelerator={accelerator:?} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    Ok(VerifiedMusicBeatRuntime {
        sidecar: sidecar.to_path_buf(),
        models_dir: files.models_dir,
        models: files.models,
        gpu_pack,
        accelerator,
        detector_version: manifest.detector.version.clone(),
        beat_model_sha256: manifest.beat_model_sha256().to_owned(),
    })
}

/// Status plus the verified runtime when ready.
pub(crate) async fn runtime_status_with(
    config_dir: &Path,
    sidecar: Option<&Path>,
    manifest: &MusicBeatRuntimeManifest,
    manifest_sha256: &str,
) -> (MusicBeatRuntimeStatus, Option<VerifiedMusicBeatRuntime>) {
    let settings = load_settings(config_dir);
    let (runtime, verified) = match settings.runtime_folder.as_deref() {
        None => (MusicBeatRuntimeAvailability::NotConfigured, None),
        Some(folder) => match verify_runtime_folder(Path::new(folder), sidecar, manifest).await {
            Ok(verified) => (MusicBeatRuntimeAvailability::Ready, Some(verified)),
            Err(problem) => {
                eprintln!("music_beats.runtime_verify ready=false problem={problem:?}");
                (MusicBeatRuntimeAvailability::Unavailable { problem }, None)
            }
        },
    };
    (
        MusicBeatRuntimeStatus {
            runtime_folder: settings.runtime_folder,
            runtime,
            accelerator: verified.as_ref().map(|verified| verified.accelerator),
            manifest_sha256: manifest_sha256.to_owned(),
            beat_this_version: manifest.detector.version.clone(),
            checkpoint_sha256: manifest.beat_model_sha256().to_owned(),
        },
        verified,
    )
}

pub(crate) async fn music_beat_runtime_status(
    config_dir: &Path,
    sidecar: Option<&Path>,
) -> (MusicBeatRuntimeStatus, Option<VerifiedMusicBeatRuntime>) {
    runtime_status_with(
        config_dir,
        sidecar,
        &pinned_manifest(),
        &pinned_manifest_sha256(),
    )
    .await
}

pub(crate) async fn set_music_beat_runtime_folder(
    config_dir: &Path,
    sidecar: Option<&Path>,
    folder: &str,
) -> Result<MusicBeatRuntimeStatus, VideoCommandError> {
    if !valid_runtime_folder(folder) {
        return Err(settings_io("invalid"));
    }
    save_settings(
        config_dir,
        &MusicBeatSettingsV1 {
            schema_version: 1,
            runtime_folder: Some(folder.to_owned()),
        },
    )?;
    Ok(music_beat_runtime_status(config_dir, sidecar).await.0)
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Raw sidecar output in seconds, before bounds and conversion.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BeatDetectorOutput {
    pub(crate) beats: Vec<f64>,
    pub(crate) downbeats: Vec<f64>,
    pub(crate) device: SidecarDevice,
    pub(crate) cuda_error: Option<String>,
    pub(crate) timing: BeatDetectorTiming,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BeatDetectorTiming {
    pub(crate) mel_ms: u64,
    pub(crate) inference_ms: u64,
}

async fn detect_once(
    runtime: &VerifiedMusicBeatRuntime,
    gpu_pack: Option<&Path>,
    wav_path: &Path,
    cancellation: ProcessCancellation,
) -> Result<SupervisedOutput, ProcessFailure> {
    let mut args = sidecar_args("detect", &runtime.models_dir, gpu_pack);
    args.extend([
        OsString::from("--device"),
        OsString::from("auto"),
        wav_path.as_os_str().to_owned(),
    ]);
    run_music_beat_process(
        ProcessSpec {
            program: runtime.sidecar.as_os_str().to_owned(),
            args,
            current_dir: None,
            operation: OPERATION,
            timeout: DETECT_TIMEOUT,
            stdout_limit: DETECT_STDOUT_LIMIT,
            stderr_tail_limit: STDERR_TAIL_LIMIT,
        },
        cancellation,
        "detect",
    )
    .await
}

/// Runs the sidecar on the analysis WAV. `gpu_pack` comes from
/// [`VerifiedMusicBeatRuntime::recheck_before_run`]. The sidecar itself reruns on the CPU after
/// a CUDA error; a process that dies with the GPU pack loaded is retried once without it.
pub(crate) async fn run_beat_detector(
    runtime: &VerifiedMusicBeatRuntime,
    gpu_pack: Option<&Path>,
    wav_path: &Path,
    cancellation: ProcessCancellation,
) -> Result<BeatDetectorOutput, VideoCommandError> {
    let started = std::time::Instant::now();
    let mut output = detect_once(runtime, gpu_pack, wav_path, cancellation.clone()).await;
    if gpu_pack.is_some() {
        if let Err(ProcessFailure::NonZero { exit_code, .. }) = &output {
            if *exit_code != Some(SIDECAR_EXIT_BAD_INPUT) {
                eprintln!("music_beats.beat_detect_cuda_crashed exit_code={exit_code:?} retry=cpu");
                output = detect_once(runtime, None, wav_path, cancellation).await;
            }
        }
    }
    let output = output.map_err(|failure| map_process_failure(failure, SIDECAR_NAME))?;
    let parsed = serde_json::from_slice::<BeatDetectorOutput>(&output.stdout)
        .map_err(|_| VideoCommandError::invalid_media(OPERATION, "music_beats_output"));
    match &parsed {
        Ok(result) => eprintln!(
            "music_beats.beat_detect_run ok=true device={} mel_ms={} inference_ms={} elapsed_ms={} cuda_error={:?}",
            result.device.as_str(),
            result.timing.mel_ms,
            result.timing.inference_ms,
            started.elapsed().as_millis(),
            result
                .cuda_error
                .as_deref()
                .map(|error| error.chars().take(512).collect::<String>())
                .unwrap_or_default(),
        ),
        Err(_) => eprintln!(
            "music_beats.beat_detect_run ok=false elapsed_ms={}",
            started.elapsed().as_millis()
        ),
    }
    parsed
}

const FFMPEG_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const FFMPEG_STDOUT_LIMIT: usize = 64 * 1024;

/// Decodes the first audio stream to 22.05 kHz mono 16-bit PCM WAV, the input
/// of both Beat This! and the in-app fallback. Audio past the analysis limit
/// is not decoded.
pub(crate) async fn extract_analysis_wav(
    ffmpeg: &Path,
    source_path: &Path,
    wav_path: &Path,
    cancellation: ProcessCancellation,
) -> Result<(), VideoCommandError> {
    let limit_seconds = super::music_beats::MAX_MUSIC_BEAT_DURATION_US / 1_000_000;
    let args = [
        OsString::from("-nostdin"),
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        source_path.as_os_str().to_owned(),
        OsString::from("-map"),
        OsString::from("0:a:0"),
        OsString::from("-vn"),
        OsString::from("-t"),
        OsString::from(limit_seconds.to_string()),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from(super::music_beats::MUSIC_BEAT_SAMPLE_RATE.to_string()),
        OsString::from("-c:a"),
        OsString::from("pcm_s16le"),
        OsString::from("-f"),
        OsString::from("wav"),
        OsString::from("-y"),
        wav_path.as_os_str().to_owned(),
    ];
    run_music_beat_process(
        ProcessSpec {
            program: ffmpeg.as_os_str().to_owned(),
            args: args.into(),
            current_dir: None,
            operation: OPERATION,
            timeout: FFMPEG_TIMEOUT,
            stdout_limit: FFMPEG_STDOUT_LIMIT,
            stderr_tail_limit: STDERR_TAIL_LIMIT,
        },
        cancellation,
        "ffmpeg",
    )
    .await
    .map(|_| ())
    .map_err(|failure| map_process_failure(failure, "ffmpeg"))
}

fn map_process_failure(failure: ProcessFailure, executable: &'static str) -> VideoCommandError {
    match failure {
        ProcessFailure::Spawn {
            kind: std::io::ErrorKind::NotFound,
            ..
        } => VideoCommandError::tool_unavailable(OPERATION, executable),
        ProcessFailure::Timeout { .. } => VideoCommandError::process_timeout(OPERATION, executable),
        ProcessFailure::Cancelled { .. } => {
            VideoCommandError::process_cancelled(OPERATION, executable)
        }
        ProcessFailure::StdoutLimit { limit, .. } => {
            VideoCommandError::process_output_limit(OPERATION, executable, limit)
        }
        ProcessFailure::NonZero { exit_code, .. } => {
            VideoCommandError::process_failed(OPERATION, executable, exit_code)
        }
        ProcessFailure::Spawn { .. } | ProcessFailure::Io { .. } => {
            VideoCommandError::process_failed(OPERATION, executable, None)
        }
    }
}

#[cfg(not(test))]
async fn run_music_beat_process(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    _helper_kind: &'static str,
) -> Result<SupervisedOutput, ProcessFailure> {
    super::process::run_supervised(spec, cancellation).await
}

/// Set to `1` to run the real sidecar (and real ffmpeg) in the ignored end-to-end proof.
#[cfg(test)]
pub(crate) const REAL_BEAT_DETECT_PROOF_ENV: &str = "SUPA_VIDEO_REAL_BEAT_DETECT_PROOF";
#[cfg(test)]
const HELPER_ARGUMENTS_ENV: &str = "SUPA_VIDEO_MUSIC_BEAT_HELPER_ARGUMENTS";

/// Tests swap the sidecar for the test binary's helper mode; the ignored real
/// proof opts back into the production path.
#[cfg(test)]
async fn run_music_beat_process(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    helper_kind: &'static str,
) -> Result<SupervisedOutput, ProcessFailure> {
    use super::process::run_supervised_with_test_environment;

    let current_executable = std::env::current_exe().map_err(|_| ProcessFailure::Io {
        operation: OPERATION,
    })?;
    // A real ffmpeg (anything but this test binary) and the opt-in real
    // sidecar proof run unmodified.
    let real_ffmpeg = helper_kind == "ffmpeg" && Path::new(&spec.program) != current_executable;
    if real_ffmpeg || std::env::var_os(REAL_BEAT_DETECT_PROOF_ENV).is_some_and(|value| value == "1")
    {
        return super::process::run_supervised(spec, cancellation).await;
    }
    let original: Vec<String> = std::iter::once(spec.program.clone())
        .chain(spec.args.iter().cloned())
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    let mut helper_spec = spec;
    helper_spec.program = current_executable.into_os_string();
    helper_spec.args = [
        "--exact",
        "video::tests::supervised_process_helper",
        "--nocapture",
        "--test-threads=1",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    let mut output = run_supervised_with_test_environment(
        helper_spec,
        cancellation,
        vec![
            (
                OsString::from("SUPA_VIDEO_PROCESS_HELPER_MODE"),
                Some(OsString::from(format!("music_beat_{helper_kind}"))),
            ),
            (
                OsString::from(HELPER_ARGUMENTS_ENV),
                Some(OsString::from(
                    serde_json::to_string(&original).unwrap_or_default(),
                )),
            ),
        ],
    )
    .await?;
    if helper_kind == "ffmpeg" {
        return Ok(output);
    }
    // The test harness writes its own lines around the helper's JSON.
    let start = output.stdout.iter().position(|byte| *byte == b'{');
    let end = output.stdout.iter().rposition(|byte| *byte == b'}');
    output.stdout = match (start, end) {
        (Some(start), Some(end)) if start <= end => output.stdout[start..=end].to_vec(),
        _ => b"malformed".to_vec(),
    };
    Ok(output)
}

#[cfg(test)]
fn helper_arguments() -> Vec<String> {
    serde_json::from_str(&std::env::var(HELPER_ARGUMENTS_ENV).unwrap_or_default())
        .expect("music beat helper arguments must be JSON")
}

/// Fake ffmpeg: writes a 4 s, 120 BPM click track (first click at 0.5 s) as
/// 22.05 kHz mono PCM WAV to the output path. A `fake-ffmpeg-fail` marker next
/// to the source exits non-zero.
#[cfg(test)]
pub(crate) fn music_beat_ffmpeg_helper() {
    let arguments = helper_arguments();
    let source = Path::new(&arguments[6]);
    if source.with_file_name("fake-ffmpeg-fail").exists() {
        eprintln!("Invalid data found when processing input");
        std::process::exit(1);
    }
    let output = Path::new(arguments.last().expect("ffmpeg output path"));
    let samples = super::music_beats::click_track_samples(120.0, 0.5, 4.0);
    write_test_wav(output, &samples);
}

#[cfg(test)]
pub(crate) fn write_test_wav(path: &Path, samples: &[i16]) {
    let rate = super::music_beats::MUSIC_BEAT_SAMPLE_RATE;
    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    fs::write(path, bytes).expect("test wav must write");
}

/// Parsed fake-sidecar command line: `<program> <command> --models <dir> [--cuda <dir>] ...`.
#[cfg(test)]
struct FakeSidecarCall {
    runtime_folder: PathBuf,
    models_dir: PathBuf,
    cuda: Option<PathBuf>,
    rest: Vec<String>,
}

#[cfg(test)]
fn fake_sidecar_call(expected_command: &str) -> FakeSidecarCall {
    let arguments = helper_arguments();
    assert_eq!(arguments[1], expected_command);
    assert_eq!(arguments[2], "--models");
    let models_dir = PathBuf::from(&arguments[3]);
    assert!(
        models_dir.join(MEL_MODEL_FILE).is_file(),
        "mel model must exist"
    );
    assert!(
        models_dir.join(BEAT_MODEL_FILE).is_file(),
        "beat model must exist"
    );
    let (cuda, rest) = if arguments.get(4).is_some_and(|flag| flag == "--cuda") {
        (Some(PathBuf::from(&arguments[5])), arguments[6..].to_vec())
    } else {
        (None, arguments[4..].to_vec())
    };
    if let Some(cuda) = &cuda {
        assert!(cuda.is_dir(), "GPU pack folder must exist");
    }
    let runtime_folder = models_dir
        .parent()
        .expect("models live inside the runtime folder")
        .to_path_buf();
    // Record the call so tests can check which device the app asked for.
    fs::write(
        runtime_folder.join(format!("fake-{expected_command}-args.json")),
        serde_json::to_vec(&arguments).expect("arguments serialize"),
    )
    .expect("argument record must write");
    FakeSidecarCall {
        runtime_folder,
        models_dir,
        cuda,
        rest,
    }
}

/// Fake `supa-beat-detect probe`. Markers in the runtime folder: `fake-probe-fail` exits 3,
/// `fake-probe-version` overrides the reported version, `fake-cuda-fail` reports a CPU run with
/// a CUDA error, `fake-cuda-crash` exits 3 whenever `--cuda` is given.
#[cfg(test)]
pub(crate) fn music_beat_probe_helper() {
    let call = fake_sidecar_call("probe");
    assert!(call.rest.is_empty(), "probe takes no further arguments");
    let folder = &call.runtime_folder;
    if folder.join("fake-probe-fail").exists()
        || (call.cuda.is_some() && folder.join("fake-cuda-crash").exists())
    {
        eprintln!("supa-beat-detect: could not load the models");
        std::process::exit(3);
    }
    let version = fs::read_to_string(folder.join("fake-probe-version"))
        .map(|version| version.trim().to_owned())
        .unwrap_or_else(|_| pinned_manifest().detector.crate_version);
    let cuda_fails = folder.join("fake-cuda-fail").exists();
    let (device, cuda_error) = match (&call.cuda, cuda_fails) {
        (Some(_), false) => ("cuda", None),
        (Some(_), true) => ("cpu", Some("CUDA driver version is insufficient")),
        (None, _) => ("cpu", None),
    };
    println!(
        "{}",
        serde_json::json!({ "version": version, "device": device, "cudaError": cuda_error })
    );
}

/// Fake `supa-beat-detect detect`. Markers in the runtime folder: `fake-detect-hang` writes
/// `fake-detect-running` and sleeps, `fake-detect-malformed` prints invalid output,
/// `fake-cuda-crash` exits 3 whenever `--cuda` is given. Otherwise it reports a music beat every
/// 0.5 s from 0.5 s and downbeats at 0.5 s and 2.5 s.
#[cfg(test)]
pub(crate) fn music_beat_detect_helper() {
    let call = fake_sidecar_call("detect");
    assert_eq!(call.rest.len(), 3, "detect takes --device auto <wav>");
    assert_eq!(call.rest[..2], ["--device", "auto"]);
    assert!(Path::new(&call.rest[2]).is_file(), "audio must exist");
    assert!(call.models_dir.is_dir());
    let folder = &call.runtime_folder;
    if call.cuda.is_some() && folder.join("fake-cuda-crash").exists() {
        std::process::exit(3);
    }
    if folder.join("fake-detect-hang").exists() {
        fs::write(folder.join("fake-detect-running"), b"1").expect("marker must write");
        std::thread::sleep(Duration::from_secs(30));
    }
    if folder.join("fake-detect-malformed").exists() {
        println!("{{\"beats\": \"soon\"}}");
        return;
    }
    let beats: Vec<f64> = (1..=7).map(|index| f64::from(index) * 0.5).collect();
    let device = if call.cuda.is_some() { "cuda" } else { "cpu" };
    println!(
        "{}",
        serde_json::json!({
            "beats": beats,
            "downbeats": [0.5, 2.5],
            "device": device,
            "cudaError": null,
            "timing": { "melMs": 1, "inferenceMs": 2 },
        })
    );
}

#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use tests::{
    fake_sidecar_path, fixture_manifest, runtime_folder_fixture, RuntimeFixture,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// File contents for a fake runtime folder; the fixture manifest pins exactly these bytes.
    pub(crate) struct RuntimeFixture {
        pub(crate) mel: &'static [u8],
        pub(crate) beat: &'static [u8],
        pub(crate) gpu_pack: Option<&'static [(&'static str, &'static [u8])]>,
    }

    pub(crate) const FAKE_GPU_PACK: &[(&str, &[u8])] = &[
        ("onnxruntime.dll", b"fake onnxruntime"),
        ("cudart64_12.dll", b"fake cudart"),
    ];

    impl RuntimeFixture {
        pub(crate) const CPU_ONLY: Self = Self {
            mel: b"fake mel model",
            beat: b"fake beat model",
            gpu_pack: None,
        };
        pub(crate) const WITH_GPU_PACK: Self = Self {
            mel: b"fake mel model",
            beat: b"fake beat model",
            gpu_pack: Some(FAKE_GPU_PACK),
        };
    }

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    pub(crate) fn fixture_manifest(fixture: &RuntimeFixture) -> MusicBeatRuntimeManifest {
        let mut manifest = pinned_manifest();
        for model in &mut manifest.models.files {
            let bytes = if model.role == "mel" {
                fixture.mel
            } else {
                fixture.beat
            };
            model.byte_length = bytes.len() as u64;
            model.sha256 = sha256(bytes);
        }
        let template = manifest.gpu_pack.files[0].clone();
        manifest.gpu_pack.files = FAKE_GPU_PACK
            .iter()
            .map(|(name, bytes)| ManifestPackFile {
                file: (*name).to_owned(),
                byte_length: bytes.len() as u64,
                sha256: sha256(bytes),
                ..template.clone()
            })
            .collect();
        manifest
    }

    pub(crate) fn runtime_folder_fixture(root: &Path, fixture: &RuntimeFixture) -> PathBuf {
        let folder = root.join("beat-runtime");
        let models = folder.join("models");
        fs::create_dir_all(&models).unwrap();
        fs::write(models.join(MEL_MODEL_FILE), fixture.mel).unwrap();
        fs::write(models.join(BEAT_MODEL_FILE), fixture.beat).unwrap();
        if let Some(files) = fixture.gpu_pack {
            let pack = folder.join("cuda");
            fs::create_dir_all(&pack).unwrap();
            for (name, bytes) in files {
                fs::write(pack.join(name), bytes).unwrap();
            }
        }
        folder
    }

    /// Any existing file stands in for the sidecar: tests replace it with the helper mode.
    pub(crate) fn fake_sidecar_path() -> PathBuf {
        std::env::current_exe().unwrap()
    }

    fn configure(config_dir: &Path, folder: &Path) {
        save_settings(
            config_dir,
            &MusicBeatSettingsV1 {
                schema_version: 1,
                runtime_folder: Some(folder.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
    }

    async fn verify(
        folder: &Path,
        fixture: &RuntimeFixture,
    ) -> Result<VerifiedMusicBeatRuntime, MusicBeatRuntimeProblem> {
        let sidecar = fake_sidecar_path();
        verify_runtime_folder(folder, Some(&sidecar), &fixture_manifest(fixture)).await
    }

    fn recorded_args(folder: &Path, command: &str) -> Vec<String> {
        serde_json::from_slice(&fs::read(folder.join(format!("fake-{command}-args.json"))).unwrap())
            .unwrap()
    }

    #[test]
    fn pinned_manifest_is_valid() {
        let manifest = pinned_manifest();

        assert!(validate_manifest(&manifest));
        assert_eq!(manifest.detector.version, "rs-1.1.0");
        assert_eq!(manifest.detector.crate_version, "1.1.0");
        assert_eq!(
            manifest.detector.reference_checkpoint.byte_length,
            81_058_141
        );
        assert_eq!(manifest.detector.license.spdx, "MIT");
        assert_eq!(
            manifest.beat_model_sha256(),
            "5f810debe53459b559127fb55bbad40035bb47cc567b20e501670f968c770f02"
        );
        assert!(is_sha256(&pinned_manifest_sha256()));
        // Every GPU pack file comes from a pinned archive.
        for file in &manifest.gpu_pack.files {
            assert!(
                manifest
                    .gpu_pack
                    .archives
                    .iter()
                    .any(|archive| archive.id == file.archive && is_sha256(&archive.sha256)),
                "{} has no pinned archive",
                file.file
            );
        }
    }

    #[test]
    fn manifests_with_unsafe_or_unexpected_paths_fail_validation() {
        let fixture = RuntimeFixture::CPU_ONLY;
        type Mutation = fn(&mut MusicBeatRuntimeManifest);
        let cases: [(&str, Mutation); 6] = [
            ("model traversal", |m| {
                m.models.files[0].file = "../beat_this.onnx".to_owned()
            }),
            ("models folder traversal", |m| {
                m.models.folder = "..".to_owned()
            }),
            ("pack file path", |m| {
                m.gpu_pack.files[0].file = "sub/onnxruntime.dll".to_owned()
            }),
            ("renamed beat model", |m| {
                m.models.files[1].file = "other.onnx".to_owned()
            }),
            ("duplicate role", |m| {
                m.models.files[1].role = "mel".to_owned()
            }),
            ("version not tied to crate", |m| {
                m.detector.version = "rs-9.9.9".to_owned()
            }),
        ];
        for (name, mutate) in cases {
            let mut manifest = fixture_manifest(&fixture);
            mutate(&mut manifest);

            assert!(!validate_manifest(&manifest), "{name} must be rejected");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_invalid_manifest_fails_closed_before_touching_files() {
        let workspace = tempfile::tempdir().unwrap();
        let fixture = RuntimeFixture::CPU_ONLY;
        let folder = runtime_folder_fixture(workspace.path(), &fixture);
        let mut manifest = fixture_manifest(&fixture);
        manifest.models.files[0].file = "../mel_spectrogram.onnx".to_owned();

        let result = verify_runtime_folder(&folder, Some(&fake_sidecar_path()), &manifest).await;

        assert_eq!(result.unwrap_err(), MusicBeatRuntimeProblem::FolderMissing);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_is_not_configured_without_a_folder() {
        let config = tempfile::tempdir().unwrap();

        let (status, verified) =
            music_beat_runtime_status(config.path(), Some(&fake_sidecar_path())).await;

        assert_eq!(status.runtime, MusicBeatRuntimeAvailability::NotConfigured);
        assert_eq!(status.accelerator, None);
        assert!(verified.is_none());
        assert_eq!(status.runtime_folder, None);
    }

    #[test]
    fn the_bundled_sidecar_resolves_only_when_the_file_exists() {
        use crate::video::{
            derived::MediaPrograms,
            toolchain::{MediaToolchain, MediaToolchainState},
        };
        let resources = tempfile::tempdir().unwrap();
        let sidecar = resources
            .path()
            .join(crate::video::toolchain::BEAT_DETECTOR_RESOURCE);
        let programs = |path: &Path| {
            MediaPrograms::bundled(
                MediaToolchainState::from_ready(MediaToolchain::resolve_from_resource_root(
                    resources.path(),
                ))
                .with_beat_detector(path.to_path_buf()),
            )
        };

        assert_eq!(programs(&sidecar).beat_detector(), None);
        fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        fs::write(&sidecar, b"exe").unwrap();
        assert_eq!(programs(&sidecar).beat_detector(), Some(sidecar.clone()));
        assert_eq!(
            programs(sidecar.parent().unwrap()).beat_detector(),
            None,
            "a folder is not the sidecar"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn setting_a_folder_saves_it_and_reports_its_status() {
        let workspace = tempfile::tempdir().unwrap();
        let config = workspace.path().join("config");
        let folder = workspace.path().join("missing-runtime");

        let rejected =
            set_music_beat_runtime_folder(&config, Some(&fake_sidecar_path()), "relative").await;
        let status = set_music_beat_runtime_folder(
            &config,
            Some(&fake_sidecar_path()),
            folder.to_str().unwrap(),
        )
        .await
        .unwrap();

        assert!(rejected.is_err());
        assert_eq!(status.runtime_folder.as_deref(), folder.to_str());
        assert_eq!(
            status.runtime,
            MusicBeatRuntimeAvailability::Unavailable {
                problem: MusicBeatRuntimeProblem::FolderMissing
            }
        );
        assert_eq!(
            load_settings(&config).runtime_folder.as_deref(),
            folder.to_str()
        );
    }

    #[test]
    fn status_serializes_to_the_ipc_shape() {
        let status = |runtime, accelerator| MusicBeatRuntimeStatus {
            runtime_folder: Some("C:\\beats".to_owned()),
            runtime,
            accelerator,
            manifest_sha256: "a".repeat(64),
            beat_this_version: "rs-1.1.0".to_owned(),
            checkpoint_sha256: "b".repeat(64),
        };

        let ready = serde_json::to_value(status(
            MusicBeatRuntimeAvailability::Ready,
            Some(MusicBeatAccelerator::Cpu {
                reason: MusicBeatCpuReason::GpuPackMismatch,
            }),
        ))
        .unwrap();
        let unavailable = serde_json::to_value(status(
            MusicBeatRuntimeAvailability::Unavailable {
                problem: MusicBeatRuntimeProblem::ModelMismatch,
            },
            None,
        ))
        .unwrap();
        let cuda = serde_json::to_value(MusicBeatAccelerator::Cuda).unwrap();

        assert_eq!(
            ready,
            serde_json::json!({
                "runtimeFolder": "C:\\beats",
                "runtime": { "state": "ready" },
                "accelerator": { "kind": "cpu", "reason": "gpuPackMismatch" },
                "manifestSha256": "a".repeat(64),
                "beatThisVersion": "rs-1.1.0",
                "checkpointSha256": "b".repeat(64),
            })
        );
        assert_eq!(
            unavailable["runtime"],
            serde_json::json!({ "state": "unavailable", "problem": { "reason": "modelMismatch" } })
        );
        assert_eq!(unavailable["accelerator"], serde_json::Value::Null);
        assert_eq!(cuda, serde_json::json!({ "kind": "cuda" }));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_folder_with_a_matching_gpu_pack_is_ready_on_cuda() {
        let workspace = tempfile::tempdir().unwrap();
        let fixture = RuntimeFixture::WITH_GPU_PACK;
        let folder = runtime_folder_fixture(workspace.path(), &fixture);
        configure(workspace.path(), &folder);
        let manifest = fixture_manifest(&fixture);

        let (status, verified) =
            runtime_status_with(workspace.path(), Some(&fake_sidecar_path()), &manifest, "a").await;

        assert_eq!(status.runtime, MusicBeatRuntimeAvailability::Ready);
        assert_eq!(status.accelerator, Some(MusicBeatAccelerator::Cuda));
        assert_eq!(status.checkpoint_sha256, sha256(fixture.beat));
        let verified = verified.expect("ready runtime");
        assert_eq!(verified.detector_version, "rs-1.1.0");
        assert_eq!(verified.beat_model_sha256, sha256(fixture.beat));
        let probe = recorded_args(&folder, "probe");
        assert_eq!(probe[1..3], ["probe", "--models"]);
        assert_eq!(probe[4], "--cuda");
        assert!(verified.recheck_before_run().await.unwrap().is_some());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_accelerator_explains_every_cpu_case() {
        let workspace = tempfile::tempdir().unwrap();
        let cpu = |reason| Some(MusicBeatAccelerator::Cpu { reason });
        let accelerator_of = |name: &'static str, fixture: RuntimeFixture, prepare: fn(&Path)| {
            let root = workspace.path().join(name);
            async move {
                let folder = runtime_folder_fixture(&root, &fixture);
                prepare(&folder);
                let verified = verify(&folder, &fixture).await.expect("ready runtime");
                (verified.accelerator, verified.gpu_pack.is_some())
            }
        };

        let no_pack = accelerator_of("no-pack", RuntimeFixture::CPU_ONLY, |_| {}).await;
        let changed = accelerator_of("changed", RuntimeFixture::WITH_GPU_PACK, |folder| {
            fs::write(folder.join("cuda/cudart64_12.dll"), b"fake cudarX").unwrap();
        })
        .await;
        let missing_file = accelerator_of("missing", RuntimeFixture::WITH_GPU_PACK, |folder| {
            fs::remove_file(folder.join("cuda/onnxruntime.dll")).unwrap();
        })
        .await;
        let init_failed = accelerator_of("init", RuntimeFixture::WITH_GPU_PACK, |folder| {
            fs::write(folder.join("fake-cuda-fail"), b"1").unwrap();
        })
        .await;
        let crashed = accelerator_of("crash", RuntimeFixture::WITH_GPU_PACK, |folder| {
            fs::write(folder.join("fake-cuda-crash"), b"1").unwrap();
        })
        .await;

        assert_eq!(
            no_pack,
            (cpu(MusicBeatCpuReason::NoGpuPack).unwrap(), false)
        );
        assert_eq!(
            changed,
            (cpu(MusicBeatCpuReason::GpuPackMismatch).unwrap(), false)
        );
        assert_eq!(
            missing_file,
            (cpu(MusicBeatCpuReason::GpuPackMismatch).unwrap(), false)
        );
        assert_eq!(
            init_failed,
            (cpu(MusicBeatCpuReason::CudaInitFailed).unwrap(), false)
        );
        assert_eq!(
            crashed,
            (cpu(MusicBeatCpuReason::CudaInitFailed).unwrap(), false)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_reports_each_problem() {
        let workspace = tempfile::tempdir().unwrap();
        let fixture = RuntimeFixture::CPU_ONLY;
        let manifest = fixture_manifest(&fixture);
        let sidecar = fake_sidecar_path();
        let status_of = |folder: PathBuf, sidecar: Option<PathBuf>| {
            let config = workspace.path().join("config");
            let manifest = manifest.clone();
            async move {
                configure(&config, &folder);
                runtime_status_with(&config, sidecar.as_deref(), &manifest, "a")
                    .await
                    .0
                    .runtime
            }
        };
        let unavailable = |problem| MusicBeatRuntimeAvailability::Unavailable { problem };
        let fresh = |name: &str| runtime_folder_fixture(&workspace.path().join(name), &fixture);

        assert_eq!(
            status_of(workspace.path().join("missing"), Some(sidecar.clone())).await,
            unavailable(MusicBeatRuntimeProblem::FolderMissing)
        );
        let folder = fresh("no-model");
        fs::remove_file(folder.join("models").join(BEAT_MODEL_FILE)).unwrap();
        assert_eq!(
            status_of(folder, Some(sidecar.clone())).await,
            unavailable(MusicBeatRuntimeProblem::ModelMissing)
        );
        let folder = fresh("no-models-folder");
        fs::remove_dir_all(folder.join("models")).unwrap();
        assert_eq!(
            status_of(folder, Some(sidecar.clone())).await,
            unavailable(MusicBeatRuntimeProblem::ModelMissing)
        );
        let folder = fresh("wrong-hash");
        fs::write(
            folder.join("models").join(MEL_MODEL_FILE),
            b"fake mel modeX",
        )
        .unwrap();
        assert_eq!(
            status_of(folder, Some(sidecar.clone())).await,
            unavailable(MusicBeatRuntimeProblem::ModelMismatch)
        );
        assert_eq!(
            status_of(fresh("no-sidecar"), None).await,
            unavailable(MusicBeatRuntimeProblem::DetectorMissing)
        );
        let folder = fresh("probe-fails");
        fs::write(folder.join("fake-probe-fail"), b"1").unwrap();
        assert_eq!(
            status_of(folder, Some(sidecar.clone())).await,
            unavailable(MusicBeatRuntimeProblem::ProbeFailed)
        );
        let folder = fresh("old-crate");
        fs::write(folder.join("fake-probe-version"), b"1.0.0").unwrap();
        assert_eq!(
            status_of(folder, Some(sidecar.clone())).await,
            unavailable(MusicBeatRuntimeProblem::ProbeFailed)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn recheck_rejects_a_swapped_model() {
        let workspace = tempfile::tempdir().unwrap();
        let fixture = RuntimeFixture::CPU_ONLY;
        let folder = runtime_folder_fixture(workspace.path(), &fixture);
        let verified = verify(&folder, &fixture).await.unwrap();

        fs::write(
            folder.join("models").join(BEAT_MODEL_FILE),
            b"fake beat modeX",
        )
        .unwrap();

        assert!(verified.recheck_before_run().await.is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn recheck_runs_on_cpu_when_the_gpu_pack_changed_after_verification() {
        let workspace = tempfile::tempdir().unwrap();
        let fixture = RuntimeFixture::WITH_GPU_PACK;
        let folder = runtime_folder_fixture(workspace.path(), &fixture);
        let verified = verify(&folder, &fixture).await.unwrap();
        assert!(verified.recheck_before_run().await.unwrap().is_some());

        fs::write(
            folder.join("cuda/onnxruntime.dll"),
            b"a different, longer library",
        )
        .unwrap();

        assert_eq!(verified.recheck_before_run().await.unwrap(), None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn detect_passes_the_gpu_pack_and_reports_the_device() {
        let workspace = tempfile::tempdir().unwrap();
        let fixture = RuntimeFixture::WITH_GPU_PACK;
        let folder = runtime_folder_fixture(workspace.path(), &fixture);
        let verified = verify(&folder, &fixture).await.unwrap();
        let wav = workspace.path().join("analysis.wav");
        write_test_wav(&wav, &[0; 64]);
        let pack = verified.recheck_before_run().await.unwrap();

        let output =
            run_beat_detector(&verified, pack.as_deref(), &wav, ProcessCancellation::new())
                .await
                .unwrap();

        assert_eq!(output.device, SidecarDevice::Cuda);
        assert_eq!(output.beats.len(), 7);
        let args = recorded_args(&folder, "detect");
        assert_eq!(args[4], "--cuda");
        assert_eq!(args[6..8], ["--device", "auto"]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn detect_reruns_on_cpu_when_the_sidecar_dies_with_the_gpu_pack() {
        let workspace = tempfile::tempdir().unwrap();
        let fixture = RuntimeFixture::WITH_GPU_PACK;
        let folder = runtime_folder_fixture(workspace.path(), &fixture);
        let verified = verify(&folder, &fixture).await.unwrap();
        let pack = verified.recheck_before_run().await.unwrap();
        fs::write(folder.join("fake-cuda-crash"), b"1").unwrap();
        let wav = workspace.path().join("analysis.wav");
        write_test_wav(&wav, &[0; 64]);

        let output =
            run_beat_detector(&verified, pack.as_deref(), &wav, ProcessCancellation::new())
                .await
                .unwrap();

        assert_eq!(output.device, SidecarDevice::Cpu);
        assert_eq!(recorded_args(&folder, "detect")[4], "--device");
    }

    #[test]
    fn corrupt_or_relative_settings_read_as_not_configured() {
        let config = tempfile::tempdir().unwrap();
        fs::write(config.path().join(MUSIC_BEAT_SETTINGS_FILE), b"{not json").unwrap();
        assert_eq!(load_settings(config.path()), default_settings());
        fs::write(
            config.path().join(MUSIC_BEAT_SETTINGS_FILE),
            br#"{"schemaVersion":1,"runtimeFolder":"relative/folder"}"#,
        )
        .unwrap();
        assert_eq!(load_settings(config.path()), default_settings());
        assert!(save_settings(
            config.path(),
            &MusicBeatSettingsV1 {
                schema_version: 1,
                runtime_folder: Some("relative".to_owned()),
            }
        )
        .is_err());
    }
}
