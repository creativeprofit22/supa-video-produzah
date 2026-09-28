//! Pinned NeMo-Speech.cpp runtime manifest and runtime-folder verification.
//!
//! The app never downloads a runtime. The user points it at a flat folder that
//! must contain exactly the executable, DLLs and GGUF model listed in the
//! checked-in manifest. Anything else fails closed as "unavailable".

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    error::VideoCommandError,
    nemo_transcription::{is_reparse_or_symlink, VerifiedNemoFile, VerifiedNemoRuntime},
    transcript::{
        AsrConfigurationV1, AsrProviderSettingV1, AsrProviderSettingValueV1, AsrTaskV1,
        SpeakerDiarizationModeV1,
    },
};

const MANIFEST_JSON: &str = include_str!("nemo-runtime-manifest.json");
const OPERATION: &str = "verify_asr_runtime";
const MAX_FOLDER_ENTRIES: usize = 512;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NemoRuntimeManifest {
    pub(crate) schema_version: u8,
    pub(crate) engine_id: String,
    pub(crate) device: String,
    pub(crate) quantization: String,
    pub(crate) runtime: NemoRuntimeSection,
    pub(crate) model: NemoModelSection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NemoRuntimeSection {
    pub(crate) repository: String,
    pub(crate) commit: String,
    pub(crate) cuda_architecture: String,
    pub(crate) license: ManifestLicense,
    pub(crate) executable: ManifestFile,
    pub(crate) dlls: Vec<ManifestFile>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NemoModelSection {
    pub(crate) repository: String,
    pub(crate) revision: String,
    pub(crate) license: ManifestLicense,
    pub(crate) file: ManifestFile,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestLicense {
    pub(crate) spdx: String,
    pub(crate) url: String,
    pub(crate) attribution: String,
    pub(crate) commercial_use: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestFile {
    pub(crate) name: String,
    pub(crate) bytes: u64,
    pub(crate) sha256: String,
}

/// Why a runtime folder was rejected. Serialized to the UI as a bounded code.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "reason")]
pub(crate) enum NemoRuntimeProblem {
    FolderMissing,
    LinkedPath,
    TooManyEntries,
    MissingFile { name: String },
    SizeMismatch { name: String },
    UnexpectedExecutable { name: String },
    IntegrityFailed,
}

impl NemoRuntimeProblem {
    pub(crate) fn into_command_error(self) -> VideoCommandError {
        VideoCommandError::new(
            super::error::VideoErrorCode::ToolUnavailable,
            "The speech-recognition runtime folder does not match the pinned manifest",
            serde_json::json!({
                "operation": OPERATION,
                "executable": "nemo",
                "problem": self,
            }),
        )
    }
}

pub(crate) fn pinned_manifest() -> Result<NemoRuntimeManifest, VideoCommandError> {
    parse_manifest(MANIFEST_JSON)
}

/// SHA-256 of the embedded manifest bytes. Consent records are bound to it so a
/// manifest change requires fresh consent.
pub(crate) fn pinned_manifest_sha256() -> String {
    format!("{:x}", Sha256::digest(MANIFEST_JSON.as_bytes()))
}

pub(crate) fn parse_manifest(json: &str) -> Result<NemoRuntimeManifest, VideoCommandError> {
    let manifest: NemoRuntimeManifest =
        serde_json::from_str(json).map_err(|_| manifest_invalid())?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &NemoRuntimeManifest) -> Result<(), VideoCommandError> {
    let mut names = BTreeSet::new();
    let files = std::iter::once(&manifest.runtime.executable)
        .chain(manifest.runtime.dlls.iter())
        .chain(std::iter::once(&manifest.model.file));
    for file in files {
        let lower = file.name.to_ascii_lowercase();
        if file.bytes == 0
            || !is_sha256(&file.sha256)
            || !is_plain_file_name(&file.name)
            || !names.insert(lower)
        {
            return Err(manifest_invalid());
        }
    }
    let executable = manifest.runtime.executable.name.to_ascii_lowercase();
    if manifest.schema_version != 1
        || manifest.engine_id != "nemo-speech.cpp"
        || manifest.device != "cuda:0"
        || !executable.ends_with(".exe")
        || manifest
            .runtime
            .dlls
            .iter()
            .any(|dll| !dll.name.to_ascii_lowercase().ends_with(".dll"))
        || !manifest
            .model
            .file
            .name
            .to_ascii_lowercase()
            .ends_with(".gguf")
        || !is_git_sha(&manifest.runtime.commit)
        || !is_git_sha(&manifest.model.revision)
        || manifest.runtime.license.spdx.is_empty()
        || manifest.model.license.spdx.is_empty()
        || !manifest.model.license.url.starts_with("https://")
        || !manifest.runtime.license.url.starts_with("https://")
    {
        return Err(manifest_invalid());
    }
    Ok(())
}

/// Verifies `folder` against `manifest` and returns a hash-verified runtime.
pub(crate) fn verify_runtime_folder(
    folder: &Path,
    manifest: &NemoRuntimeManifest,
) -> Result<VerifiedNemoRuntime, NemoRuntimeProblem> {
    let metadata = fs::symlink_metadata(folder).map_err(|_| NemoRuntimeProblem::FolderMissing)?;
    if is_reparse_or_symlink(&metadata) {
        return Err(NemoRuntimeProblem::LinkedPath);
    }
    if !metadata.is_dir() {
        return Err(NemoRuntimeProblem::FolderMissing);
    }
    let folder = fs::canonicalize(folder).map_err(|_| NemoRuntimeProblem::FolderMissing)?;

    let expected: BTreeSet<String> = std::iter::once(&manifest.runtime.executable)
        .chain(manifest.runtime.dlls.iter())
        .map(|file| file.name.to_ascii_lowercase())
        .collect();
    let entries = fs::read_dir(&folder).map_err(|_| NemoRuntimeProblem::FolderMissing)?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_FOLDER_ENTRIES {
            return Err(NemoRuntimeProblem::TooManyEntries);
        }
        let entry = entry.map_err(|_| NemoRuntimeProblem::FolderMissing)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        // Any loadable code not in the manifest could be planted next to the
        // executable and picked up by the DLL search order.
        let loadable = [".exe", ".dll", ".com", ".bat", ".cmd", ".sys", ".ocx"]
            .iter()
            .any(|extension| lower.ends_with(extension));
        if loadable && !expected.contains(&lower) {
            return Err(NemoRuntimeProblem::UnexpectedExecutable { name });
        }
    }

    let executable = checked_file(&folder, &manifest.runtime.executable)?;
    let mut dlls = Vec::with_capacity(manifest.runtime.dlls.len());
    for dll in &manifest.runtime.dlls {
        dlls.push(checked_file(&folder, dll)?);
    }
    let model = checked_file(&folder, &manifest.model.file)?;
    VerifiedNemoRuntime::new(executable, folder, dlls, model)
        .map_err(|_| NemoRuntimeProblem::IntegrityFailed)
}

fn checked_file(
    folder: &Path,
    file: &ManifestFile,
) -> Result<VerifiedNemoFile, NemoRuntimeProblem> {
    let path: PathBuf = folder.join(&file.name);
    let metadata = fs::symlink_metadata(&path).map_err(|_| NemoRuntimeProblem::MissingFile {
        name: file.name.clone(),
    })?;
    if is_reparse_or_symlink(&metadata) {
        return Err(NemoRuntimeProblem::LinkedPath);
    }
    if !metadata.is_file() {
        return Err(NemoRuntimeProblem::MissingFile {
            name: file.name.clone(),
        });
    }
    if metadata.len() != file.bytes {
        return Err(NemoRuntimeProblem::SizeMismatch {
            name: file.name.clone(),
        });
    }
    Ok(VerifiedNemoFile {
        path,
        byte_length: file.bytes,
        sha256: file.sha256.clone(),
    })
}

/// Builds the ASR configuration whose identity pins every piece of provenance:
/// runtime commit (`engine_version`), model repository and revision, model and
/// executable hashes, the whole manifest (covering the DLL set) and the device.
/// Changing any of them changes the transcript artifact identity.
pub(crate) fn nemo_asr_configuration(
    manifest: &NemoRuntimeManifest,
    manifest_sha256: &str,
    source_duration_us: u64,
) -> AsrConfigurationV1 {
    let setting = |key: &str, value: &str| AsrProviderSettingV1 {
        key: key.to_owned(),
        value: AsrProviderSettingValueV1::String(value.to_owned()),
    };
    AsrConfigurationV1 {
        schema_version: 1,
        engine_id: manifest.engine_id.clone(),
        engine_version: manifest.runtime.commit.clone(),
        model_id: model_id_from_repository(&manifest.model.repository),
        model_revision: manifest.model.revision.clone(),
        requested_language: Some("en".to_owned()),
        task: AsrTaskV1::Transcribe,
        word_timing_required: true,
        speaker_diarization_mode: SpeakerDiarizationModeV1::Off,
        chunk_duration_us: source_duration_us,
        chunk_overlap_us: 0,
        provider_settings: vec![
            setting("device", &manifest.device),
            setting("gguf_sha256", &manifest.model.file.sha256),
            setting("quantization", &manifest.quantization),
            setting("runtime_manifest_sha256", manifest_sha256),
            setting("runtime_sha256", &manifest.runtime.executable.sha256),
        ],
    }
}

fn model_id_from_repository(repository: &str) -> String {
    repository
        .strip_prefix("https://huggingface.co/")
        .unwrap_or(repository)
        .to_owned()
}

fn manifest_invalid() -> VideoCommandError {
    VideoCommandError::new(
        super::error::VideoErrorCode::ToolUnavailable,
        "The pinned speech-recognition manifest is invalid",
        serde_json::json!({ "operation": OPERATION, "executable": "nemo", "category": "manifest_invalid" }),
    )
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_git_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn fixture_manifest(files: &[(&str, &[u8])]) -> NemoRuntimeManifest {
        let entry = |name: &str, bytes: &[u8]| ManifestFile {
            name: name.to_owned(),
            bytes: bytes.len() as u64,
            sha256: sha(bytes),
        };
        let mut manifest = pinned_manifest().unwrap();
        manifest.runtime.executable = entry(files[0].0, files[0].1);
        manifest.runtime.dlls = files[1..files.len() - 1]
            .iter()
            .map(|(name, bytes)| entry(name, bytes))
            .collect();
        let last = files[files.len() - 1];
        manifest.model.file = entry(last.0, last.1);
        manifest
    }

    const FILES: &[(&str, &[u8])] = &[
        ("nemo-speech.exe", b"exe-bytes"),
        ("ggml.dll", b"ggml-bytes"),
        ("model.gguf", b"model-bytes"),
    ];

    fn write_all(dir: &Path, files: &[(&str, &[u8])]) {
        for (name, bytes) in files {
            fs::write(dir.join(name), bytes).unwrap();
        }
    }

    #[test]
    fn embedded_manifest_parses_and_pins_upstream_provenance() {
        let manifest = pinned_manifest().unwrap();
        assert_eq!(
            manifest.runtime.commit,
            "5be7bfb104802131e61fe679b3f1401b27270216"
        );
        assert_eq!(
            manifest.model.revision,
            "1c8deaecc64b91f034d73e08dd8b64625eb3395d"
        );
        assert_eq!(manifest.model.file.bytes, 741_548_352);
        assert_eq!(manifest.model.license.spdx, "OpenMDW-1.1");
        assert_eq!(manifest.device, "cuda:0");
        assert!(is_sha256(&pinned_manifest_sha256()));
    }

    #[test]
    fn manifest_rejects_unsafe_or_duplicate_names() {
        let mut value: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();
        value["model"]["file"]["name"] = "..\\model.gguf".into();
        assert!(parse_manifest(&value.to_string()).is_err());
        let mut value: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();
        value["model"]["file"]["name"] = value["runtime"]["executable"]["name"].clone();
        assert!(parse_manifest(&value.to_string()).is_err());
        let mut value: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();
        value["unexpected"] = true.into();
        assert!(parse_manifest(&value.to_string()).is_err());
    }

    #[test]
    fn matching_folder_verifies() {
        let dir = tempfile::tempdir().unwrap();
        write_all(dir.path(), FILES);
        fs::write(dir.path().join("README.txt"), b"notes are allowed").unwrap();
        assert!(verify_runtime_folder(dir.path(), &fixture_manifest(FILES)).is_ok());
    }

    #[test]
    fn hash_mismatch_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        write_all(dir.path(), FILES);
        fs::write(dir.path().join("model.gguf"), b"model-byteZ").unwrap();
        assert_eq!(
            verify_runtime_folder(dir.path(), &fixture_manifest(FILES)).unwrap_err(),
            NemoRuntimeProblem::IntegrityFailed
        );
    }

    #[test]
    fn missing_dll_is_named() {
        let dir = tempfile::tempdir().unwrap();
        write_all(dir.path(), FILES);
        fs::remove_file(dir.path().join("ggml.dll")).unwrap();
        assert_eq!(
            verify_runtime_folder(dir.path(), &fixture_manifest(FILES)).unwrap_err(),
            NemoRuntimeProblem::MissingFile {
                name: "ggml.dll".to_owned()
            }
        );
    }

    #[test]
    fn size_mismatch_is_named() {
        let dir = tempfile::tempdir().unwrap();
        write_all(dir.path(), FILES);
        fs::write(dir.path().join("ggml.dll"), b"longer-ggml-bytes").unwrap();
        assert_eq!(
            verify_runtime_folder(dir.path(), &fixture_manifest(FILES)).unwrap_err(),
            NemoRuntimeProblem::SizeMismatch {
                name: "ggml.dll".to_owned()
            }
        );
    }

    #[test]
    fn unexpected_executable_or_dll_is_rejected() {
        for extra in ["helper.exe", "planted.DLL"] {
            let dir = tempfile::tempdir().unwrap();
            write_all(dir.path(), FILES);
            fs::write(dir.path().join(extra), b"x").unwrap();
            assert_eq!(
                verify_runtime_folder(dir.path(), &fixture_manifest(FILES)).unwrap_err(),
                NemoRuntimeProblem::UnexpectedExecutable {
                    name: extra.to_owned()
                }
            );
        }
    }

    #[test]
    fn missing_folder_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            verify_runtime_folder(&dir.path().join("absent"), &fixture_manifest(FILES))
                .unwrap_err(),
            NemoRuntimeProblem::FolderMissing
        );
    }

    #[cfg(windows)]
    #[test]
    fn reparse_point_folder_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        fs::create_dir(&real).unwrap();
        write_all(&real, FILES);
        let link = dir.path().join("link");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert_eq!(
            verify_runtime_folder(&link, &fixture_manifest(FILES)).unwrap_err(),
            NemoRuntimeProblem::LinkedPath
        );
    }

    #[test]
    fn every_provenance_field_changes_the_asr_configuration_identity() {
        use crate::video::transcript::derive_asr_configuration_identity;

        let manifest = pinned_manifest().unwrap();
        let manifest_sha = pinned_manifest_sha256();
        let identity = |manifest: &NemoRuntimeManifest, manifest_sha: &str| {
            derive_asr_configuration_identity(&nemo_asr_configuration(
                manifest,
                manifest_sha,
                2_000_000,
            ))
            .unwrap()
        };
        let baseline = identity(&manifest, &manifest_sha);
        assert_eq!(
            baseline,
            identity(&manifest, &manifest_sha),
            "identity is deterministic"
        );

        let other_sha = "f".repeat(64);
        let mut variants: Vec<(&str, NemoRuntimeManifest, String)> = Vec::new();
        let mut changed = manifest.clone();
        changed.runtime.commit = "0".repeat(40);
        variants.push(("runtime commit", changed, manifest_sha.clone()));
        let mut changed = manifest.clone();
        changed.model.revision = "0".repeat(40);
        variants.push(("model revision", changed, manifest_sha.clone()));
        let mut changed = manifest.clone();
        changed.model.repository = "https://huggingface.co/nvidia/other".to_owned();
        variants.push(("model repository", changed, manifest_sha.clone()));
        let mut changed = manifest.clone();
        changed.model.file.sha256 = other_sha.clone();
        variants.push(("model sha256", changed, manifest_sha.clone()));
        let mut changed = manifest.clone();
        changed.runtime.executable.sha256 = other_sha.clone();
        variants.push(("runtime sha256", changed, manifest_sha.clone()));
        let mut changed = manifest.clone();
        changed.device = "cuda:1".to_owned();
        variants.push(("device", changed, manifest_sha.clone()));
        variants.push(("manifest (DLL set)", manifest.clone(), other_sha));

        for (field, manifest, manifest_sha) in variants {
            assert_ne!(
                baseline,
                identity(&manifest, &manifest_sha),
                "{field} must change identity"
            );
        }
    }

    #[test]
    fn pinned_configuration_records_provenance_in_the_artifact() {
        let manifest = pinned_manifest().unwrap();
        let configuration = nemo_asr_configuration(&manifest, &pinned_manifest_sha256(), 1);
        assert_eq!(configuration.engine_version, manifest.runtime.commit);
        assert_eq!(
            configuration.model_id,
            "nvidia/nemotron-3.5-asr-streaming-0.6b"
        );
        assert_eq!(configuration.model_revision, manifest.model.revision);
        let keys: Vec<&str> = configuration
            .provider_settings
            .iter()
            .map(|setting| setting.key.as_str())
            .collect();
        assert_eq!(
            keys,
            [
                "device",
                "gguf_sha256",
                "quantization",
                "runtime_manifest_sha256",
                "runtime_sha256"
            ]
        );
    }
}
