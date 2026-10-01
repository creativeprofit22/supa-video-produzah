//! Immutable render manifest `<output>.manifest.json` (schema in
//! `@supa-video/qc` `manifest.ts`). Written with canonical JSON (RFC 8785,
//! sorted keys) to a temp file in the output directory and renamed into place
//! before the output itself is promoted. It never holds review decisions.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    error::{VideoCommandError, VideoErrorCode},
    qc::{hex_sha256, sort_findings, QcFinding, QcStatus},
    types::MediaProbe,
};

pub(crate) const RENDER_MANIFEST_SCHEMA_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestProject {
    pub revision_id: String,
    pub revision_state_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestInput {
    pub asset_id: Option<String>,
    pub content_sha256: Option<String>,
    pub rights_receipt_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestOutput {
    pub file_name: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub duration_microseconds: u64,
    pub width: u64,
    pub height: u64,
    pub video_codec: String,
    pub audio_codec: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestQc {
    pub status: QcStatus,
    pub detector_version: String,
    pub findings: Vec<QcFinding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestEditorial {
    pub evaluator_version: String,
    pub evaluation_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestSource {
    pub review_manifest_sha256: String,
    pub accepted_decision_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderManifest {
    pub schema_version: u64,
    pub kind: String,
    pub preset_id: Option<String>,
    pub project: ManifestProject,
    pub render_plan_sha256: String,
    pub toolchain_id: String,
    pub inputs: Vec<ManifestInput>,
    pub output: ManifestOutput,
    pub loudness: Option<Value>,
    pub qc: ManifestQc,
    pub editorial: ManifestEditorial,
    pub source: Option<ManifestSource>,
    pub app_version: String,
    pub created_at: String,
}

impl RenderManifest {
    /// Canonical bytes; inputs, findings and decision ids in deterministic order.
    pub(crate) fn canonical_bytes(&self) -> Result<Vec<u8>, VideoCommandError> {
        let mut normalized = self.clone();
        normalized.inputs.sort();
        sort_findings(&mut normalized.qc.findings);
        if let Some(source) = normalized.source.as_mut() {
            source.accepted_decision_ids.sort();
        }
        serde_json_canonicalizer::to_vec(&normalized).map_err(|_| manifest_write("serialize"))
    }
}

pub(crate) fn manifest_output(
    file_name: String,
    sha256: String,
    size_bytes: u64,
    probe: &MediaProbe,
) -> ManifestOutput {
    ManifestOutput {
        file_name,
        sha256,
        size_bytes,
        duration_microseconds: probe.duration_microseconds,
        width: probe.width,
        height: probe.height,
        video_codec: probe.video_codec_name.clone(),
        audio_codec: probe.audio.as_ref().map(|audio| audio.codec_name.clone()),
    }
}

/// SHA-256 of a value's canonical JSON (render plan, editorial evaluation).
pub(crate) fn canonical_sha256<T: Serialize>(value: &T) -> Result<String, VideoCommandError> {
    serde_json_canonicalizer::to_vec(value)
        .map(|bytes| hex_sha256(&bytes))
        .map_err(|_| manifest_write("serialize"))
}

pub(crate) fn manifest_write(stage: &str) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::ProjectIo,
        "The render manifest could not be written",
        json!({
            "operation": "render_manifest",
            "category": "manifest_write",
            "stage": stage,
        }),
    )
}

pub(crate) fn manifest_path_for(output_path: &Path) -> Option<PathBuf> {
    let parent = output_path.parent()?;
    let name = output_path.file_name()?.to_str()?;
    Some(parent.join(format!("{name}.manifest.json")))
}

pub(crate) fn review_record_path_for(output_path: &Path) -> Option<PathBuf> {
    let parent = output_path.parent()?;
    let name = output_path.file_name()?.to_str()?;
    Some(parent.join(format!("{name}.review.jsonl")))
}

/// A manifest that has been renamed into place; removed again on drop unless
/// the output was promoted (`keep`).
pub(crate) struct WrittenManifest {
    pub(crate) path: PathBuf,
    pub(crate) sha256: String,
    keep: bool,
}

impl WrittenManifest {
    /// Guard for another sidecar already renamed into place.
    pub(crate) fn guard(path: PathBuf, sha256: String) -> Self {
        Self {
            path,
            sha256,
            keep: false,
        }
    }

    pub(crate) fn keep(mut self) -> (PathBuf, String) {
        self.keep = true;
        (self.path.clone(), self.sha256.clone())
    }
}

impl Drop for WrittenManifest {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Hook for tests to force a manifest write failure at a given stage.
pub(crate) type ManifestFailpoint = fn(&str) -> bool;

/// Writes the manifest via temp + fsync + rename. Without `overwrite`, an
/// existing manifest is never replaced (the existing output owns it).
pub(crate) fn write_manifest(
    output_path: &Path,
    manifest: &RenderManifest,
    overwrite: bool,
    failpoint: Option<ManifestFailpoint>,
) -> Result<WrittenManifest, VideoCommandError> {
    let fail = |stage: &str| failpoint.is_some_and(|hook| hook(stage));
    let target = manifest_path_for(output_path).ok_or_else(|| manifest_write("path"))?;
    let parent = output_path.parent().ok_or_else(|| manifest_write("path"))?;
    if let Ok(metadata) = std::fs::symlink_metadata(&target) {
        if !metadata.file_type().is_file() || !overwrite {
            return Err(manifest_write("exists"));
        }
    }
    let bytes = manifest.canonical_bytes()?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".svp-manifest-")
        .suffix(".part")
        .tempfile_in(parent)
        .map_err(|_| manifest_write("create"))?;
    if fail("write") {
        return Err(manifest_write("write"));
    }
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| manifest_write("write"))?;
    if fail("persist") {
        return Err(manifest_write("persist"));
    }
    let persisted = if overwrite {
        temporary.persist(&target).map(|_| ())
    } else {
        temporary.persist_noclobber(&target).map(|_| ())
    };
    persisted.map_err(|_| manifest_write("persist"))?;
    Ok(WrittenManifest {
        path: target,
        sha256: hex_sha256(&bytes),
        keep: false,
    })
}

/// When an existing output is overwritten, its review record belongs to the
/// old bytes. Move it aside (never delete) so the new export starts clean.
pub(crate) fn supersede_review_record(
    output_path: &Path,
    now_ms: u64,
) -> Result<(), VideoCommandError> {
    let Some(record) = review_record_path_for(output_path) else {
        return Ok(());
    };
    if std::fs::symlink_metadata(&record).is_err() {
        return Ok(());
    }
    let name = record
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| manifest_write("supersede"))?;
    let archived = record.with_file_name(format!("{name}.superseded-{now_ms}"));
    std::fs::rename(&record, archived).map_err(|_| manifest_write("supersede"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::qc::{QcFindingKind, QcRange, QcSeverity, QcSource};

    fn manifest(findings: Vec<QcFinding>) -> RenderManifest {
        RenderManifest {
            schema_version: RENDER_MANIFEST_SCHEMA_VERSION,
            kind: "review".into(),
            preset_id: None,
            project: ManifestProject {
                revision_id: "00000000-0000-4000-8000-00000000000a".into(),
                revision_state_hash: "a".repeat(64),
            },
            render_plan_sha256: "b".repeat(64),
            toolchain_id: "tool".into(),
            inputs: vec![
                ManifestInput {
                    asset_id: Some("z".into()),
                    content_sha256: None,
                    rights_receipt_id: None,
                },
                ManifestInput {
                    asset_id: Some("a".into()),
                    content_sha256: None,
                    rights_receipt_id: None,
                },
            ],
            output: ManifestOutput {
                file_name: "out.mp4".into(),
                sha256: "c".repeat(64),
                size_bytes: 1,
                duration_microseconds: 1,
                width: 1,
                height: 1,
                video_codec: "h264".into(),
                audio_codec: None,
            },
            loudness: None,
            qc: ManifestQc {
                status: QcStatus::Passed,
                detector_version: "qc-v1".into(),
                findings,
            },
            editorial: ManifestEditorial {
                evaluator_version: "editorial-v1".into(),
                evaluation_sha256: "d".repeat(64),
            },
            source: None,
            app_version: "0.1.0".into(),
            created_at: "2026-10-01T00:00:00Z".into(),
        }
    }

    fn finding(start_us: u64) -> QcFinding {
        QcFinding::new(
            QcFindingKind::Silence,
            QcSeverity::Warning,
            QcSource::Deterministic,
            "",
            QcRange {
                start_us,
                end_us: start_us + 1,
            },
            "Silence".into(),
            &"a".repeat(64),
        )
    }

    #[test]
    fn canonical_bytes_are_order_independent_with_sorted_keys() {
        let a = manifest(vec![finding(5), finding(1)]);
        let mut b = manifest(vec![finding(1), finding(5)]);
        b.inputs.reverse();
        let bytes = a.canonical_bytes().unwrap();
        assert_eq!(bytes, b.canonical_bytes().unwrap());
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("{\"appVersion\":"));
        assert!(!text.contains("decision"));
    }

    #[test]
    fn write_is_atomic_and_never_clobbers_without_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("out.mp4");
        let written = write_manifest(&output, &manifest(vec![]), false, None).unwrap();
        let (path, sha) = written.keep();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(hex_sha256(&bytes), sha);
        let again = write_manifest(&output, &manifest(vec![finding(1)]), false, None);
        assert!(again.is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "existing manifest untouched"
        );
        let leftovers: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn unkept_manifest_is_removed_and_failpoints_leave_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("out.mp4");
        let written = write_manifest(&output, &manifest(vec![]), false, None).unwrap();
        let path = written.path.clone();
        drop(written);
        assert!(!path.exists());
        for stage in ["write", "persist"] {
            let hook: ManifestFailpoint = match stage {
                "write" => |stage| stage == "write",
                _ => |stage| stage == "persist",
            };
            let error = write_manifest(&output, &manifest(vec![]), false, Some(hook))
                .err()
                .expect("failpoint must fail");
            assert_eq!(error.details["category"], "manifest_write");
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn superseding_moves_the_old_review_record_aside() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("out.mp4");
        let record = review_record_path_for(&output).unwrap();
        std::fs::write(&record, b"{}\n").unwrap();
        supersede_review_record(&output, 42).unwrap();
        assert!(!record.exists());
        assert!(directory
            .path()
            .join("out.mp4.review.jsonl.superseded-42")
            .exists());
        supersede_review_record(&output, 43).unwrap();
    }
}
