//! Machine-local speech-recognition settings: where the verified runtime lives
//! and whether the user accepted the model license for the pinned manifest.
//! Stored in the app config dir, never inside a project.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::error::{VideoCommandError, VideoErrorCode};

pub(crate) const ASR_SETTINGS_FILE: &str = "asr-settings.json";
const MAX_SETTINGS_BYTES: u64 = 16 * 1024;
const MAX_RUNTIME_PATH_CHARS: usize = 1_024;
const OPERATION: &str = "asr_settings";

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AsrSettingsV1 {
    pub(crate) schema_version: u8,
    pub(crate) runtime_folder: Option<String>,
    pub(crate) consent: Option<AsrConsentRecordV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AsrConsentRecordV1 {
    /// Consent is bound to this exact manifest; a changed manifest needs fresh consent.
    pub(crate) manifest_sha256: String,
    pub(crate) model_license_spdx: String,
    pub(crate) accepted_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AsrConsentState {
    Missing,
    Stale,
    Accepted,
}

impl AsrSettingsV1 {
    pub(crate) fn consent_state(&self, manifest_sha256: &str) -> AsrConsentState {
        match &self.consent {
            None => AsrConsentState::Missing,
            Some(record) if record.manifest_sha256 == manifest_sha256 => AsrConsentState::Accepted,
            Some(_) => AsrConsentState::Stale,
        }
    }

    /// Fails closed with a typed `consent_required` error unless consent matches.
    pub(crate) fn require_consent(&self, manifest_sha256: &str) -> Result<(), VideoCommandError> {
        match self.consent_state(manifest_sha256) {
            AsrConsentState::Accepted => Ok(()),
            state => Err(consent_required(state)),
        }
    }
}

pub(crate) fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(ASR_SETTINGS_FILE)
}

/// Missing file means defaults. A corrupt or oversized file also resets to
/// defaults (fail closed: no runtime, no consent) rather than blocking the app.
pub(crate) fn load_settings(config_dir: &Path) -> AsrSettingsV1 {
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
    match serde_json::from_slice::<AsrSettingsV1>(&bytes) {
        Ok(settings) if settings.schema_version == 1 && valid_runtime_folder(&settings) => settings,
        _ => default_settings(),
    }
}

pub(crate) fn save_settings(
    config_dir: &Path,
    settings: &AsrSettingsV1,
) -> Result<(), VideoCommandError> {
    if settings.schema_version != 1 || !valid_runtime_folder(settings) {
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

pub(crate) fn default_settings() -> AsrSettingsV1 {
    AsrSettingsV1 {
        schema_version: 1,
        runtime_folder: None,
        consent: None,
    }
}

fn valid_runtime_folder(settings: &AsrSettingsV1) -> bool {
    settings.runtime_folder.as_deref().is_none_or(|folder| {
        !folder.is_empty()
            && folder.chars().count() <= MAX_RUNTIME_PATH_CHARS
            && Path::new(folder).is_absolute()
            && !folder.chars().any(char::is_control)
    })
}

pub(crate) fn consent_required(state: AsrConsentState) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::ToolUnavailable,
        "Accept the speech-recognition model license before transcribing",
        serde_json::json!({
            "operation": "start_transcription",
            "executable": "nemo",
            "category": "consent_required",
            "consent": state,
        }),
    )
}

fn settings_io(category: &'static str) -> VideoCommandError {
    VideoCommandError::project_io(OPERATION, category)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn accepted(manifest: &str) -> AsrSettingsV1 {
        AsrSettingsV1 {
            schema_version: 1,
            runtime_folder: None,
            consent: Some(AsrConsentRecordV1 {
                manifest_sha256: manifest.to_owned(),
                model_license_spdx: "OpenMDW-1.1".to_owned(),
                accepted_at_ms: 1,
            }),
        }
    }

    fn category(error: &VideoCommandError) -> serde_json::Value {
        serde_json::to_value(error).unwrap()["details"]["consent"].clone()
    }

    #[test]
    fn missing_file_loads_defaults_without_consent() {
        let dir = tempfile::tempdir().unwrap();
        let settings = load_settings(dir.path());
        assert_eq!(settings, default_settings());
        let error = settings.require_consent(MANIFEST).unwrap_err();
        assert_eq!(category(&error), "missing");
    }

    #[test]
    fn consent_for_a_different_manifest_is_stale() {
        let settings = accepted(&"b".repeat(64));
        assert_eq!(settings.consent_state(MANIFEST), AsrConsentState::Stale);
        assert_eq!(
            category(&settings.require_consent(MANIFEST).unwrap_err()),
            "stale"
        );
    }

    #[test]
    fn saved_consent_round_trips_and_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = accepted(MANIFEST);
        settings.runtime_folder = Some(dir.path().to_string_lossy().into_owned());
        save_settings(dir.path(), &settings).unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded, settings);
        assert!(loaded.require_consent(MANIFEST).is_ok());
    }

    #[test]
    fn revoking_consent_fails_closed_again() {
        let dir = tempfile::tempdir().unwrap();
        save_settings(dir.path(), &accepted(MANIFEST)).unwrap();
        let mut settings = load_settings(dir.path());
        settings.consent = None;
        save_settings(dir.path(), &settings).unwrap();
        assert!(load_settings(dir.path()).require_consent(MANIFEST).is_err());
    }

    #[test]
    fn corrupt_or_unknown_fields_reset_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(settings_path(dir.path()), b"{not json").unwrap();
        assert_eq!(load_settings(dir.path()), default_settings());
        fs::write(
            settings_path(dir.path()),
            br#"{"schemaVersion":1,"runtimeFolder":null,"consent":null,"extra":1}"#,
        )
        .unwrap();
        assert_eq!(load_settings(dir.path()), default_settings());
    }

    #[test]
    fn relative_runtime_folder_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = default_settings();
        settings.runtime_folder = Some("relative\\runtime".to_owned());
        assert!(save_settings(dir.path(), &settings).is_err());
    }
}
