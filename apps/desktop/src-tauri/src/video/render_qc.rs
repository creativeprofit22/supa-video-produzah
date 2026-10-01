//! QC step of the render worker: runs after the encode is verified (probe +
//! loudness) and before the partial output is promoted.
//!
//! | Situation                                     | Result                               |
//! |-----------------------------------------------|--------------------------------------|
//! | blockers on a review export                   | promoted, `qcStatus: blocked`        |
//! | unaccepted blocker on a Deliver preset render | `qc_release_blocked`, partial deleted |
//! | QC pass crash / non-zero exit / timeout       | `qc_unavailable`, partial deleted    |
//! | cancel during QC                              | `process_cancelled`, partial deleted |
//! | manifest write fails                          | `manifest_write`, partial deleted    |
//!
//! Partial deletion is the existing `TempPath` guard: any early return drops it.

use std::{collections::BTreeMap, path::Path};

use serde_json::Value;

use super::{
    error::VideoCommandError,
    probe::InspectedMedia,
    qc::{
        analyze_output, qc_release_blocked, qc_status, qc_timeout_for, sort_findings,
        unresolved_blockers, QcAnalysisConfig, QcFinding, QcThresholds, RenderQcContext,
        QC_DETECTOR_VERSION, QC_MAX_FINDINGS,
    },
    render::RenderWorkerRequest,
    render_manifest::{
        canonical_sha256, manifest_output, manifest_write, ManifestEditorial, ManifestInput,
        ManifestProject, ManifestQc, ManifestSource, RenderManifest,
        RENDER_MANIFEST_SCHEMA_VERSION,
    },
    types::{RenderCaptionInput, RenderPlan},
};

/// Findings and the manifest ready to be written before promotion.
pub(crate) struct QcVerdict {
    pub(crate) findings: Vec<QcFinding>,
    pub(crate) manifest: RenderManifest,
}

/// Native findings + validated editorial findings, deduplicated by id, sorted.
pub(crate) fn merge_findings(native: Vec<QcFinding>, editorial: &[QcFinding]) -> Vec<QcFinding> {
    let mut by_id: BTreeMap<String, QcFinding> = BTreeMap::new();
    for finding in native.into_iter().chain(editorial.iter().cloned()) {
        by_id.entry(finding.finding_id.clone()).or_insert(finding);
    }
    let mut findings: Vec<QcFinding> = by_id.into_values().collect();
    sort_findings(&mut findings);
    findings.truncate(QC_MAX_FINDINGS);
    findings
}

/// Deliver gate: every blocker must have been accepted on the source review
/// export (by stable id). Rights findings are never accepted.
pub(crate) fn unresolved_for_delivery(
    findings: &[QcFinding],
    accepted: &BTreeMap<String, String>,
) -> Vec<String> {
    let accepted_ids = accepted.keys().cloned().collect();
    unresolved_blockers(findings, &accepted_ids)
}

pub(crate) fn plan_captions(plan: &RenderPlan) -> &[RenderCaptionInput] {
    match plan {
        RenderPlan::V1(plan) => &plan.captions,
        RenderPlan::V2(plan) => &plan.captions,
    }
}

/// Input digests for the manifest. Each path was already normalized and
/// granted at validation; the rights gate hashed the same bytes.
fn manifest_inputs(request: &RenderWorkerRequest) -> Result<Vec<ManifestInput>, VideoCommandError> {
    let plan = &request.validated.plan;
    let mut inputs = Vec::new();
    match plan {
        RenderPlan::V1(_) => {
            for path in &request.validated.input_paths {
                inputs.push(ManifestInput {
                    asset_id: None,
                    content_sha256: Some(hash_input(path)?),
                    rights_receipt_id: None,
                });
            }
        }
        RenderPlan::V2(v2) => {
            for (asset_id, path) in &v2.input_paths_by_asset_id {
                let receipt = v2.rights.as_ref().and_then(|rights| {
                    rights
                        .acquisition_receipt_ids_by_asset_id
                        .get(asset_id)
                        .map(ToString::to_string)
                });
                inputs.push(ManifestInput {
                    asset_id: Some(asset_id.as_str().to_owned()),
                    content_sha256: Some(hash_input(Path::new(path))?),
                    rights_receipt_id: receipt,
                });
            }
        }
    }
    inputs.sort();
    Ok(inputs)
}

fn hash_input(path: &Path) -> Result<String, VideoCommandError> {
    crate::rights::gate::hash_file(path)
        .map(|(digest, _)| digest)
        .map_err(|_| manifest_write("input_digest"))
}

/// Runs the QC pass and builds (but does not write) the manifest.
pub(crate) async fn evaluate_render(
    request: &RenderWorkerRequest,
    context: &RenderQcContext,
    partial_path: &Path,
    inspected: &InspectedMedia,
    loudness: Option<&super::audio_mix::LoudnessReport>,
    created_at: String,
) -> Result<QcVerdict, VideoCommandError> {
    let probe = &inspected.probe;
    let plan = &request.validated.plan;
    let config = QcAnalysisConfig {
        duration_us: probe.duration_microseconds,
        has_audio: probe.audio.is_some(),
        video_hidden: plan.expected().video_hidden,
        loudness_target_lufs: plan.audio_mix().map(|mix| mix.integrated_lufs as f64),
        thresholds: QcThresholds::default(),
        timeout: request
            .hooks
            .qc_timeout
            .unwrap_or_else(|| qc_timeout_for(probe.duration_microseconds)),
    };
    if let Some(before_qc) = request.hooks.before_qc {
        before_qc(&request.cancellation, partial_path);
    }
    let started = std::time::Instant::now();
    let native = analyze_output(
        &request.programs,
        request.cancellation.clone(),
        partial_path,
        &config,
        plan_captions(plan),
        (probe.width, probe.height),
        &context.revision_state_hash,
    )
    .await?;
    let findings = merge_findings(native, &context.editorial.findings);
    let status = qc_status(&findings);
    eprintln!(
        "video.qc job={} status={status:?} findings={} elapsed_ms={}",
        request.identity.job_id,
        findings.len(),
        started.elapsed().as_millis()
    );
    let source = match &context.delivery {
        Some(gate) => {
            let unresolved = unresolved_for_delivery(&findings, &gate.accepted);
            if !unresolved.is_empty() {
                return Err(qc_release_blocked(&unresolved));
            }
            let mut relied: Vec<String> = findings
                .iter()
                .filter_map(|finding| gate.accepted.get(&finding.finding_id).cloned())
                .collect();
            relied.sort();
            relied.dedup();
            Some(ManifestSource {
                review_manifest_sha256: gate.source_manifest_sha256.clone(),
                accepted_decision_ids: relied,
            })
        }
        None => None,
    };
    let (output_sha256, size_bytes) = crate::rights::gate::hash_file(partial_path)
        .map_err(|_| manifest_write("output_digest"))?;
    let file_name = request
        .validated
        .output_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| manifest_write("path"))?
        .to_owned();
    let loudness = loudness
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| manifest_write("serialize"))?
        .filter(|value| !value.is_null());
    let manifest = RenderManifest {
        schema_version: RENDER_MANIFEST_SCHEMA_VERSION,
        kind: if context.delivery.is_some() {
            "delivery".to_owned()
        } else {
            "review".to_owned()
        },
        preset_id: context.delivery.as_ref().map(|gate| gate.preset_id.clone()),
        project: ManifestProject {
            revision_id: plan.revision_id().as_str().to_owned(),
            revision_state_hash: context.revision_state_hash.clone(),
        },
        render_plan_sha256: canonical_sha256(plan)?,
        toolchain_id: request.programs.toolchain_id().to_owned(),
        inputs: manifest_inputs(request)?,
        output: manifest_output(file_name, output_sha256, size_bytes, probe),
        loudness: loudness.map(strip_nulls),
        qc: ManifestQc {
            status,
            detector_version: QC_DETECTOR_VERSION.to_owned(),
            findings: findings.clone(),
        },
        editorial: ManifestEditorial {
            evaluator_version: context.editorial.evaluator_version.clone(),
            evaluation_sha256: canonical_sha256(&context.editorial)?,
        },
        source,
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        created_at,
    };
    Ok(QcVerdict { findings, manifest })
}

fn strip_nulls(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| (key, strip_nulls(value)))
                .collect(),
        ),
        other => other,
    }
}

pub(crate) fn now_rfc3339() -> String {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::qc::{QcFindingKind, QcRange, QcSeverity, QcSource};

    const STATE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn finding(
        kind: QcFindingKind,
        source: QcSource,
        severity: QcSeverity,
        start: u64,
    ) -> QcFinding {
        QcFinding::new(
            kind,
            severity,
            source,
            "",
            QcRange {
                start_us: start,
                end_us: start + 1_000_000,
            },
            "finding".to_owned(),
            STATE,
        )
    }

    #[test]
    fn merge_dedupes_by_id_and_sorts() {
        let black = finding(
            QcFindingKind::BlackFrames,
            QcSource::Deterministic,
            QcSeverity::Blocker,
            2_000_000,
        );
        let repeat = finding(
            QcFindingKind::RepeatedAsset,
            QcSource::Editorial,
            QcSeverity::Warning,
            0,
        );
        let merged = merge_findings(
            vec![black.clone(), black.clone()],
            &[repeat.clone(), repeat.clone()],
        );
        assert_eq!(merged, vec![repeat, black]);
    }

    #[test]
    fn delivery_gate_requires_acceptance_and_never_accepts_rights() {
        let black = finding(
            QcFindingKind::BlackFrames,
            QcSource::Deterministic,
            QcSeverity::Blocker,
            0,
        );
        let warn = finding(
            QcFindingKind::Silence,
            QcSource::Deterministic,
            QcSeverity::Warning,
            0,
        );
        let rights = finding(
            QcFindingKind::RightsBlocked,
            QcSource::Rights,
            QcSeverity::Blocker,
            0,
        );
        let findings = vec![black.clone(), warn, rights.clone()];
        let mut accepted = BTreeMap::new();
        assert_eq!(unresolved_for_delivery(&findings, &accepted), {
            let mut ids = vec![black.finding_id.clone(), rights.finding_id.clone()];
            ids.sort();
            ids
        });
        accepted.insert(black.finding_id.clone(), "d1".to_owned());
        accepted.insert(rights.finding_id.clone(), "d2".to_owned());
        assert_eq!(
            unresolved_for_delivery(&findings, &accepted),
            vec![rights.finding_id]
        );
    }
}
