//! The managed music-beat runtime: a user-chosen folder holding a Python
//! environment with `beat-this` installed and the pinned `final0` checkpoint.
//!
//! Python is never bundled. The folder is checked against the embedded
//! manifest (checkpoint SHA-256 and size, `beat-this` package version). The
//! runner script is embedded and written content-addressed into the app cache,
//! and it is always given the local checkpoint path, so Beat This! never
//! downloads anything at run time. When the runtime is not ready, music beat
//! detection uses the in-app tempo fallback instead.

use std::{
    ffi::OsString,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    error::VideoCommandError,
    media_store::is_reparse_or_symlink,
    process::{ProcessCancellation, ProcessFailure, ProcessSpec, SupervisedOutput},
};

const OPERATION: &str = "detect_music_beats";
const MANIFEST_JSON: &str = include_str!("music-beat-runtime-manifest.json");
const RUNNER_SCRIPT: &str = include_str!("beat_this_runner.py");
pub(crate) const MUSIC_BEAT_SETTINGS_FILE: &str = "music-beat-settings.json";
const MAX_SETTINGS_BYTES: u64 = 16 * 1024;
const MAX_RUNTIME_PATH_CHARS: usize = 1_024;
const HASH_BUFFER_BYTES: usize = 1 << 20;
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_STDOUT_LIMIT: usize = 4 * 1024;
/// Beat This! on CPU runs at roughly real time on long tracks.
const DETECT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const DETECT_STDOUT_LIMIT: usize = 4 * 1024 * 1024;
const STDERR_TAIL_LIMIT: usize = 8 * 1024;
/// Prints `{"version": "<beat-this version>"}`; `-I` ignores user site and
/// `PYTHON*` variables while still honouring the venv.
const PROBE_SOURCE: &str = "import importlib.metadata as m, json, sys; \
json.dump({'version': m.version('beat-this')}, sys.stdout)";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MusicBeatRuntimeManifest {
    pub(crate) schema_version: u8,
    pub(crate) detector: ManifestDetector,
    pub(crate) checkpoint: ManifestCheckpoint,
    pub(crate) python: ManifestPython,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestDetector {
    pub(crate) kind: String,
    pub(crate) package: String,
    pub(crate) version: String,
    pub(crate) source_repository: String,
    pub(crate) source_revision: String,
    pub(crate) license: ManifestLicense,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestCheckpoint {
    pub(crate) name: String,
    pub(crate) file: String,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
    pub(crate) url: String,
    pub(crate) license: ManifestLicense,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestLicense {
    pub(crate) spdx: String,
    pub(crate) url: String,
    pub(crate) attribution: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestPython {
    pub(crate) windows: String,
    pub(crate) unix: String,
}

impl ManifestPython {
    fn relative_path(&self) -> &str {
        if cfg!(windows) {
            &self.windows
        } else {
            &self.unix
        }
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

/// A manifest-relative path: plain components only, no traversal or roots.
fn is_relative_plain_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
}

fn is_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_+".contains(&byte))
}

pub(crate) fn validate_manifest(manifest: &MusicBeatRuntimeManifest) -> bool {
    manifest.schema_version == 1
        && manifest.detector.kind == "beat_this"
        && is_version(&manifest.detector.version)
        && is_sha256(&manifest.checkpoint.sha256)
        && manifest.checkpoint.byte_length > 0
        && is_relative_plain_path(&manifest.checkpoint.file)
        && !manifest.checkpoint.file.contains('/')
        && is_relative_plain_path(&manifest.python.windows)
        && is_relative_plain_path(&manifest.python.unix)
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
    PythonMissing,
    CheckpointMissing,
    CheckpointMismatch,
    PackageMismatch,
    ProbeFailed,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum MusicBeatRuntimeAvailability {
    NotConfigured,
    Ready,
    Unavailable { problem: MusicBeatRuntimeProblem },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicBeatRuntimeStatus {
    pub(crate) runtime_folder: Option<String>,
    pub(crate) runtime: MusicBeatRuntimeAvailability,
    pub(crate) manifest_sha256: String,
    pub(crate) beat_this_version: String,
    pub(crate) checkpoint_sha256: String,
}

/// A runtime folder whose checkpoint matched the manifest and whose Python
/// reported the pinned `beat-this` version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedMusicBeatRuntime {
    pub(crate) python: PathBuf,
    pub(crate) checkpoint: PathBuf,
    pub(crate) checkpoint_sha256: String,
    pub(crate) checkpoint_byte_length: u64,
    pub(crate) beat_this_version: String,
}

impl VerifiedMusicBeatRuntime {
    /// Re-hashes the checkpoint right before a run so a file swapped after
    /// verification is never loaded.
    pub(crate) async fn recheck_checkpoint(&self) -> Result<(), VideoCommandError> {
        let path = self.checkpoint.clone();
        let expected_len = self.checkpoint_byte_length;
        let expected = self.checkpoint_sha256.clone();
        let matches = tauri::async_runtime::spawn_blocking(move || {
            checkpoint_digest(&path, expected_len).is_ok_and(|digest| digest == expected)
        })
        .await
        .unwrap_or(false);
        if matches {
            Ok(())
        } else {
            Err(VideoCommandError::tool_unavailable(OPERATION, "beat_this"))
        }
    }
}

fn checkpoint_digest(path: &Path, expected_len: u64) -> Result<String, MusicBeatRuntimeProblem> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| MusicBeatRuntimeProblem::CheckpointMissing)?;
    if is_reparse_or_symlink(&metadata) {
        return Err(MusicBeatRuntimeProblem::LinkedPath);
    }
    if !metadata.is_file() {
        return Err(MusicBeatRuntimeProblem::CheckpointMissing);
    }
    if metadata.len() != expected_len {
        return Err(MusicBeatRuntimeProblem::CheckpointMismatch);
    }
    let file = File::open(path).map_err(|_| MusicBeatRuntimeProblem::CheckpointMissing)?;
    let mut reader = file.take(expected_len.saturating_add(1));
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut total = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| MusicBeatRuntimeProblem::CheckpointMissing)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
    }
    if total != expected_len {
        return Err(MusicBeatRuntimeProblem::CheckpointMismatch);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Checks the folder layout and checkpoint digest (blocking file work).
fn verify_runtime_files(
    folder: &Path,
    manifest: &MusicBeatRuntimeManifest,
) -> Result<(PathBuf, PathBuf), MusicBeatRuntimeProblem> {
    let metadata =
        fs::symlink_metadata(folder).map_err(|_| MusicBeatRuntimeProblem::FolderMissing)?;
    if is_reparse_or_symlink(&metadata) {
        return Err(MusicBeatRuntimeProblem::LinkedPath);
    }
    if !metadata.is_dir() {
        return Err(MusicBeatRuntimeProblem::FolderMissing);
    }
    let folder = fs::canonicalize(folder).map_err(|_| MusicBeatRuntimeProblem::FolderMissing)?;
    // A venv's interpreter may itself be a link to the base install (Unix),
    // so only its existence as a file is required here.
    let python = folder.join(manifest.python.relative_path());
    if !fs::metadata(&python).is_ok_and(|metadata| metadata.is_file()) {
        return Err(MusicBeatRuntimeProblem::PythonMissing);
    }
    let checkpoint = folder.join(&manifest.checkpoint.file);
    let digest = checkpoint_digest(&checkpoint, manifest.checkpoint.byte_length)?;
    if digest != manifest.checkpoint.sha256 {
        return Err(MusicBeatRuntimeProblem::CheckpointMismatch);
    }
    Ok((python, checkpoint))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeOutput {
    version: String,
}

async fn probe_package_version(python: &Path) -> Result<String, MusicBeatRuntimeProblem> {
    let output = run_music_beat_process(
        ProcessSpec {
            program: python.as_os_str().to_owned(),
            args: vec![
                OsString::from("-I"),
                OsString::from("-c"),
                OsString::from(PROBE_SOURCE),
            ],
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
    let parsed: ProbeOutput =
        serde_json::from_slice(&output.stdout).map_err(|_| MusicBeatRuntimeProblem::ProbeFailed)?;
    if !is_version(&parsed.version) {
        return Err(MusicBeatRuntimeProblem::ProbeFailed);
    }
    Ok(parsed.version)
}

pub(crate) async fn verify_runtime_folder(
    folder: &Path,
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
    let (python, checkpoint) = tauri::async_runtime::spawn_blocking(move || {
        verify_runtime_files(&owned_folder, &owned_manifest)
    })
    .await
    .map_err(|_| MusicBeatRuntimeProblem::FolderMissing)??;
    let version = probe_package_version(&python).await?;
    let result = if version == manifest.detector.version {
        Ok(VerifiedMusicBeatRuntime {
            python,
            checkpoint,
            checkpoint_sha256: manifest.checkpoint.sha256.clone(),
            checkpoint_byte_length: manifest.checkpoint.byte_length,
            beat_this_version: version,
        })
    } else {
        Err(MusicBeatRuntimeProblem::PackageMismatch)
    };
    eprintln!(
        "music_beats.runtime_verify ready={} elapsed_ms={}",
        result.is_ok(),
        started.elapsed().as_millis()
    );
    result
}

/// Status plus the verified runtime when ready.
pub(crate) async fn runtime_status_with(
    config_dir: &Path,
    manifest: &MusicBeatRuntimeManifest,
    manifest_sha256: &str,
) -> (MusicBeatRuntimeStatus, Option<VerifiedMusicBeatRuntime>) {
    let settings = load_settings(config_dir);
    let (runtime, verified) = match settings.runtime_folder.as_deref() {
        None => (MusicBeatRuntimeAvailability::NotConfigured, None),
        Some(folder) => match verify_runtime_folder(Path::new(folder), manifest).await {
            Ok(verified) => (MusicBeatRuntimeAvailability::Ready, Some(verified)),
            Err(problem) => (MusicBeatRuntimeAvailability::Unavailable { problem }, None),
        },
    };
    (
        MusicBeatRuntimeStatus {
            runtime_folder: settings.runtime_folder,
            runtime,
            manifest_sha256: manifest_sha256.to_owned(),
            beat_this_version: manifest.detector.version.clone(),
            checkpoint_sha256: manifest.checkpoint.sha256.clone(),
        },
        verified,
    )
}

pub(crate) async fn music_beat_runtime_status(
    config_dir: &Path,
) -> (MusicBeatRuntimeStatus, Option<VerifiedMusicBeatRuntime>) {
    runtime_status_with(config_dir, &pinned_manifest(), &pinned_manifest_sha256()).await
}

pub(crate) async fn set_music_beat_runtime_folder(
    config_dir: &Path,
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
    Ok(music_beat_runtime_status(config_dir).await.0)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/// Writes the embedded runner as `beat_this_runner-<sha256>.py` under the app
/// cache and returns its path. An existing file is reused only when its bytes
/// match; anything else at that path is replaced.
pub(crate) fn materialize_runner(app_cache_root: &Path) -> Result<PathBuf, VideoCommandError> {
    let io = |category| VideoCommandError::project_io(OPERATION, category);
    let digest = format!("{:x}", Sha256::digest(RUNNER_SCRIPT.as_bytes()));
    let directory = app_cache_root.join("runners");
    fs::create_dir_all(&directory).map_err(|_| io("runner_directory"))?;
    let directory_metadata =
        fs::symlink_metadata(&directory).map_err(|_| io("runner_directory"))?;
    if is_reparse_or_symlink(&directory_metadata) || !directory_metadata.is_dir() {
        return Err(io("runner_directory"));
    }
    let path = directory.join(format!("beat_this_runner-{digest}.py"));
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.is_file()
            && !is_reparse_or_symlink(&metadata)
            && metadata.len() == RUNNER_SCRIPT.len() as u64
            && fs::read(&path).is_ok_and(|bytes| bytes == RUNNER_SCRIPT.as_bytes())
        {
            return Ok(path);
        }
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(&directory).map_err(|_| io("runner_temporary"))?;
    temporary
        .write_all(RUNNER_SCRIPT.as_bytes())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| io("runner_write"))?;
    temporary.persist(&path).map_err(|_| io("runner_publish"))?;
    Ok(path)
}

/// Raw runner output in seconds, before bounds and conversion.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BeatThisOutput {
    pub(crate) beats: Vec<f64>,
    pub(crate) downbeats: Vec<f64>,
}

pub(crate) async fn run_beat_this(
    runtime: &VerifiedMusicBeatRuntime,
    runner: &Path,
    wav_path: &Path,
    cancellation: ProcessCancellation,
) -> Result<BeatThisOutput, VideoCommandError> {
    let started = std::time::Instant::now();
    let output = run_music_beat_process(
        ProcessSpec {
            program: runtime.python.as_os_str().to_owned(),
            args: vec![
                OsString::from("-I"),
                OsString::from("-B"),
                runner.as_os_str().to_owned(),
                wav_path.as_os_str().to_owned(),
                runtime.checkpoint.as_os_str().to_owned(),
            ],
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
    .map_err(|failure| map_process_failure(failure, "beat_this"))?;
    let parsed = serde_json::from_slice::<BeatThisOutput>(&output.stdout)
        .map_err(|_| VideoCommandError::invalid_media(OPERATION, "music_beats_output"));
    eprintln!(
        "music_beats.beat_this_run ok={} elapsed_ms={}",
        parsed.is_ok(),
        started.elapsed().as_millis()
    );
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

#[cfg(test)]
pub(crate) const REAL_BEAT_THIS_PROOF_ENV: &str = "SUPA_VIDEO_REAL_BEAT_THIS_PROOF";
#[cfg(test)]
const HELPER_ARGUMENTS_ENV: &str = "SUPA_VIDEO_MUSIC_BEAT_HELPER_ARGUMENTS";

/// Tests swap Python for the test binary's helper mode; the ignored real
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
    // Beat This! proof run unmodified.
    let real_ffmpeg = helper_kind == "ffmpeg" && Path::new(&spec.program) != current_executable;
    if real_ffmpeg || std::env::var_os(REAL_BEAT_THIS_PROOF_ENV).is_some_and(|value| value == "1") {
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

/// Fake `python -I -c <probe>`. Marker files in the runtime folder select
/// failures: `fake-probe-fail` exits non-zero, `fake-probe-version` overrides
/// the reported version.
#[cfg(test)]
pub(crate) fn music_beat_probe_helper() {
    let arguments = helper_arguments();
    assert_eq!(arguments[1..3], ["-I", "-c"]);
    assert_eq!(arguments[3], PROBE_SOURCE);
    let folder = Path::new(&arguments[0])
        .ancestors()
        .nth(pinned_manifest().python.relative_path().split('/').count())
        .expect("python lives inside the runtime folder")
        .to_path_buf();
    if folder.join("fake-probe-fail").exists() {
        eprintln!("ModuleNotFoundError: No module named 'beat_this'");
        std::process::exit(1);
    }
    let version = fs::read_to_string(folder.join("fake-probe-version"))
        .map(|version| version.trim().to_owned())
        .unwrap_or_else(|_| pinned_manifest().detector.version);
    println!("{}", serde_json::json!({ "version": version }));
}

/// Fake Beat This! run. Markers next to the checkpoint: `fake-detect-hang`
/// writes `fake-detect-running` and sleeps, `fake-detect-malformed` prints
/// invalid output. Otherwise it reports a music beat every 0.5 s from 0.5 s
/// and a downbeat every 2 s.
#[cfg(test)]
pub(crate) fn music_beat_detect_helper() {
    let arguments = helper_arguments();
    assert_eq!(arguments[1..3], ["-I", "-B"]);
    let runner = Path::new(&arguments[3]);
    assert_eq!(
        fs::read(runner).expect("runner script must exist"),
        RUNNER_SCRIPT.as_bytes()
    );
    assert!(Path::new(&arguments[4]).is_file(), "audio must exist");
    let checkpoint = Path::new(&arguments[5]);
    assert!(checkpoint.is_file(), "checkpoint must be a local file");
    let folder = checkpoint.parent().expect("checkpoint has a folder");
    if folder.join("fake-detect-hang").exists() {
        fs::write(folder.join("fake-detect-running"), b"1").expect("marker must write");
        std::thread::sleep(Duration::from_secs(30));
    }
    if folder.join("fake-detect-malformed").exists() {
        println!("{{\"beats\": \"soon\"}}");
        return;
    }
    let beats: Vec<f64> = (1..=7).map(|index| f64::from(index) * 0.5).collect();
    println!(
        "{}",
        serde_json::json!({ "beats": beats, "downbeats": [0.5, 2.5] })
    );
}

#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use tests::{fixture_manifest, runtime_folder_fixture};

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn fixture_manifest(checkpoint: &[u8]) -> MusicBeatRuntimeManifest {
        let mut manifest = pinned_manifest();
        manifest.checkpoint.byte_length = checkpoint.len() as u64;
        manifest.checkpoint.sha256 = format!("{:x}", Sha256::digest(checkpoint));
        manifest
    }

    pub(crate) fn runtime_folder_fixture(root: &Path, checkpoint: &[u8]) -> PathBuf {
        let folder = root.join("beat-this-runtime");
        let python = folder.join(pinned_manifest().python.relative_path());
        fs::create_dir_all(python.parent().unwrap()).unwrap();
        fs::write(&python, b"fake interpreter").unwrap();
        fs::write(folder.join("final0.ckpt"), checkpoint).unwrap();
        folder
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

    #[test]
    fn pinned_manifest_is_valid() {
        let manifest = pinned_manifest();
        assert!(validate_manifest(&manifest));
        assert_eq!(manifest.checkpoint.byte_length, 81_058_141);
        assert_eq!(manifest.detector.license.spdx, "MIT");
        assert!(is_sha256(&pinned_manifest_sha256()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_manifest_with_traversal_paths_fails_closed() {
        let workspace = tempfile::tempdir().unwrap();
        let checkpoint = b"fake final0 checkpoint";
        let folder = runtime_folder_fixture(workspace.path(), checkpoint);
        let mut manifest = fixture_manifest(checkpoint);
        manifest.checkpoint.file = "../final0.ckpt".to_owned();
        assert!(!validate_manifest(&manifest));
        assert_eq!(
            verify_runtime_folder(&folder, &manifest).await.unwrap_err(),
            MusicBeatRuntimeProblem::FolderMissing
        );
        let mut manifest = fixture_manifest(checkpoint);
        manifest.python.windows = "../../python.exe".to_owned();
        manifest.python.unix = "../../python".to_owned();
        assert!(verify_runtime_folder(&folder, &manifest).await.is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_is_not_configured_without_a_folder() {
        let config = tempfile::tempdir().unwrap();
        let (status, verified) = music_beat_runtime_status(config.path()).await;
        assert_eq!(status.runtime, MusicBeatRuntimeAvailability::NotConfigured);
        assert!(verified.is_none());
        assert_eq!(status.runtime_folder, None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_is_ready_for_a_matching_folder() {
        let workspace = tempfile::tempdir().unwrap();
        let checkpoint = b"checkpoint fixture";
        let folder = runtime_folder_fixture(workspace.path(), checkpoint);
        configure(workspace.path(), &folder);
        let manifest = fixture_manifest(checkpoint);

        let (status, verified) = runtime_status_with(workspace.path(), &manifest, "a").await;

        assert_eq!(status.runtime, MusicBeatRuntimeAvailability::Ready);
        let verified = verified.expect("ready runtime");
        assert_eq!(verified.beat_this_version, manifest.detector.version);
        assert!(verified.checkpoint.ends_with("final0.ckpt"));
        verified.recheck_checkpoint().await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_reports_each_problem() {
        let workspace = tempfile::tempdir().unwrap();
        let checkpoint = b"checkpoint fixture";
        let manifest = fixture_manifest(checkpoint);
        let status_of = |folder: PathBuf| {
            let config = workspace.path().join("config");
            let manifest = manifest.clone();
            async move {
                configure(&config, &folder);
                runtime_status_with(&config, &manifest, "a").await.0.runtime
            }
        };
        let unavailable = |problem| MusicBeatRuntimeAvailability::Unavailable { problem };

        assert_eq!(
            status_of(workspace.path().join("missing")).await,
            unavailable(MusicBeatRuntimeProblem::FolderMissing)
        );

        let no_checkpoint = workspace.path().join("no-checkpoint");
        let folder = runtime_folder_fixture(&no_checkpoint, checkpoint);
        fs::remove_file(folder.join("final0.ckpt")).unwrap();
        assert_eq!(
            status_of(folder).await,
            unavailable(MusicBeatRuntimeProblem::CheckpointMissing)
        );

        let wrong_hash = workspace.path().join("wrong-hash");
        let folder = runtime_folder_fixture(&wrong_hash, b"checkpoint fixturX");
        assert_eq!(
            status_of(folder).await,
            unavailable(MusicBeatRuntimeProblem::CheckpointMismatch)
        );

        let no_python = workspace.path().join("no-python");
        let folder = runtime_folder_fixture(&no_python, checkpoint);
        fs::remove_file(folder.join(pinned_manifest().python.relative_path())).unwrap();
        assert_eq!(
            status_of(folder).await,
            unavailable(MusicBeatRuntimeProblem::PythonMissing)
        );

        let probe_fails = workspace.path().join("probe-fails");
        let folder = runtime_folder_fixture(&probe_fails, checkpoint);
        fs::write(folder.join("fake-probe-fail"), b"1").unwrap();
        assert_eq!(
            status_of(folder).await,
            unavailable(MusicBeatRuntimeProblem::ProbeFailed)
        );

        let old_package = workspace.path().join("old-package");
        let folder = runtime_folder_fixture(&old_package, checkpoint);
        fs::write(folder.join("fake-probe-version"), b"0.9.0").unwrap();
        assert_eq!(
            status_of(folder).await,
            unavailable(MusicBeatRuntimeProblem::PackageMismatch)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn recheck_rejects_a_swapped_checkpoint() {
        let workspace = tempfile::tempdir().unwrap();
        let checkpoint = b"checkpoint fixture";
        let folder = runtime_folder_fixture(workspace.path(), checkpoint);
        let verified = verify_runtime_folder(&folder, &fixture_manifest(checkpoint))
            .await
            .unwrap();
        fs::write(folder.join("final0.ckpt"), b"checkpoint fixturX").unwrap();
        assert!(verified.recheck_checkpoint().await.is_err());
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

    #[test]
    fn runner_is_content_addressed_and_repaired() {
        let cache = tempfile::tempdir().unwrap();
        let path = materialize_runner(cache.path()).unwrap();
        let digest = format!("{:x}", Sha256::digest(RUNNER_SCRIPT.as_bytes()));
        assert!(path.ends_with(format!("beat_this_runner-{digest}.py")));
        fs::write(&path, b"import os; os.system('evil')").unwrap();
        let repaired = materialize_runner(cache.path()).unwrap();
        assert_eq!(repaired, path);
        assert_eq!(fs::read(&path).unwrap(), RUNNER_SCRIPT.as_bytes());
    }

    #[test]
    fn runner_never_passes_a_checkpoint_shortname() {
        // Beat This! downloads any checkpoint argument that is not a file.
        assert!(RUNNER_SCRIPT.contains("checkpoint.is_file()"));
        assert!(RUNNER_SCRIPT.contains("dbn=False"));
    }
}
