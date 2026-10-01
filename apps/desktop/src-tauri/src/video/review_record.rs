//! Append-only review record `<output>.review.jsonl` (schema in
//! `@supa-video/qc` `review-decision.ts`).
//!
//! One canonical JSON object per line, each bound to exactly one manifest by
//! `outputSha256` + `manifestSha256`. Lines are only ever appended (open with
//! append + fsync); the file is never truncated or rewritten. Readers validate
//! every line and fail closed on anything malformed or bound to other bytes.
//! Accept-anyway on a rights finding is rejected on write and ignored on read.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::Path,
};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    error::{VideoCommandError, VideoErrorCode},
    qc::{is_sha256_hex, unresolved_blockers, QcFinding, QcSource},
    render_manifest::{manifest_path_for, review_record_path_for, RenderManifest},
};

pub(crate) const REVIEW_DECISION_SCHEMA_VERSION: u64 = 1;
pub(crate) const REPAIR_ATTEMPT_LIMIT: u64 = 3;
pub(crate) const ACCEPT_REASON_MAX: usize = 480;
const REVIEW_RECORD_MAX_BYTES: u64 = 8 * 1024 * 1024;
const MANIFEST_MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepairOutcome {
    Proposed,
    Applied,
    Rejected,
    Undone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepairStopReason {
    UserStopped,
    AttemptLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReviewDecisionBody {
    #[serde(rename_all = "camelCase")]
    AcceptAnyway { reason: String },
    #[serde(rename_all = "camelCase")]
    RepairAttempt {
        attempt: u64,
        proposal_id: String,
        outcome: RepairOutcome,
    },
    #[serde(rename_all = "camelCase")]
    RepairStopped { reason: RepairStopReason },
}

/// Unknown fields are rejected on read by requiring every line to equal its
/// own canonical re-serialization (`flatten` cannot use `deny_unknown_fields`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDecision {
    pub schema_version: u64,
    pub decision_id: String,
    pub finding_id: String,
    pub output_sha256: String,
    pub manifest_sha256: String,
    pub recorded_at: String,
    #[serde(flatten)]
    pub body: ReviewDecisionBody,
}

/// Untrusted decision request from the Review UI. Ids, digests and the
/// timestamp are always assigned natively.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReviewDecisionRequest {
    #[serde(rename_all = "camelCase")]
    AcceptAnyway { finding_id: String, reason: String },
    #[serde(rename_all = "camelCase")]
    RepairAttempt {
        finding_id: String,
        proposal_id: String,
        outcome: RepairOutcome,
    },
    #[serde(rename_all = "camelCase")]
    RepairStopped { finding_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReleaseDecision {
    #[serde(rename_all = "camelCase")]
    Releasable {
        accepted_finding_ids: Vec<String>,
        accepted_decision_ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Blocked { unresolved_finding_ids: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewState {
    pub manifest: RenderManifest,
    pub manifest_sha256: String,
    pub decisions: Vec<ReviewDecision>,
    pub release: ReleaseDecision,
}

impl ReviewState {
    /// Accepted (non-rights) finding id → latest accepting decision id.
    pub(crate) fn accepted(&self) -> BTreeMap<String, String> {
        accepted_overrides(&self.manifest.qc.findings, &self.decisions)
    }
}

pub(crate) fn invalid_review_record(reason: &'static str) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::InvalidReviewRecord,
        "The review record for this export is missing, changed or invalid",
        json!({ "operation": "review_record", "category": "invalid_review_record", "reason": reason }),
    )
}

fn is_overridable(finding: &QcFinding) -> bool {
    finding.source != QcSource::Rights && finding.kind != super::qc::QcFindingKind::RightsBlocked
}

pub(crate) fn accepted_overrides(
    findings: &[QcFinding],
    decisions: &[ReviewDecision],
) -> BTreeMap<String, String> {
    let overridable: BTreeSet<&str> = findings
        .iter()
        .filter(|finding| is_overridable(finding))
        .map(|finding| finding.finding_id.as_str())
        .collect();
    let mut accepted = BTreeMap::new();
    for decision in decisions {
        if matches!(decision.body, ReviewDecisionBody::AcceptAnyway { .. })
            && overridable.contains(decision.finding_id.as_str())
        {
            accepted.insert(decision.finding_id.clone(), decision.decision_id.clone());
        }
    }
    accepted
}

/// Mirrors `evaluateRelease` in `@supa-video/qc` `policy.ts`.
pub(crate) fn evaluate_release(
    findings: &[QcFinding],
    decisions: &[ReviewDecision],
) -> ReleaseDecision {
    let accepted = accepted_overrides(findings, decisions);
    let accepted_ids: BTreeSet<String> = accepted.keys().cloned().collect();
    let unresolved = unresolved_blockers(findings, &accepted_ids);
    if !unresolved.is_empty() {
        return ReleaseDecision::Blocked {
            unresolved_finding_ids: unresolved,
        };
    }
    let present: BTreeSet<&str> = findings
        .iter()
        .map(|finding| finding.finding_id.as_str())
        .collect();
    let relied: BTreeMap<String, String> = accepted
        .into_iter()
        .filter(|(finding_id, _)| present.contains(finding_id.as_str()))
        .collect();
    let mut accepted_decision_ids: Vec<String> = relied.values().cloned().collect();
    accepted_decision_ids.sort();
    ReleaseDecision::Releasable {
        accepted_finding_ids: relied.into_keys().collect(),
        accepted_decision_ids,
    }
}

fn read_bounded(
    path: &Path,
    limit: u64,
    missing_ok: bool,
) -> Result<Option<Vec<u8>>, VideoCommandError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if missing_ok && error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None)
        }
        Err(_) => return Err(invalid_review_record("missing")),
    };
    if !metadata.file_type().is_file() || metadata.len() > limit {
        return Err(invalid_review_record("not_a_file"));
    }
    std::fs::read(path)
        .map(Some)
        .map_err(|_| invalid_review_record("read"))
}

fn validate_decision_shape(decision: &ReviewDecision) -> bool {
    decision.schema_version == REVIEW_DECISION_SCHEMA_VERSION
        && uuid::Uuid::parse_str(&decision.decision_id).is_ok()
        && is_sha256_hex(&decision.finding_id)
        && chrono::DateTime::parse_from_rfc3339(&decision.recorded_at).is_ok()
        && match &decision.body {
            ReviewDecisionBody::AcceptAnyway { reason } => {
                let trimmed = reason.trim();
                !trimmed.is_empty() && trimmed.len() <= ACCEPT_REASON_MAX
            }
            ReviewDecisionBody::RepairAttempt {
                attempt,
                proposal_id,
                ..
            } => {
                (1..=REPAIR_ATTEMPT_LIMIT).contains(attempt)
                    && !proposal_id.is_empty()
                    && proposal_id.len() <= 128
            }
            ReviewDecisionBody::RepairStopped { .. } => true,
        }
}

/// Reads the manifest and the full review record for an export. Any changed
/// output bytes, foreign or malformed line fails closed.
pub(crate) fn read_review_state(output_path: &Path) -> Result<ReviewState, VideoCommandError> {
    let manifest_path =
        manifest_path_for(output_path).ok_or_else(|| invalid_review_record("path"))?;
    let manifest_bytes = read_bounded(&manifest_path, MANIFEST_MAX_BYTES, false)?
        .ok_or_else(|| invalid_review_record("missing"))?;
    let manifest: RenderManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| invalid_review_record("manifest_malformed"))?;
    let manifest_sha256 = super::qc::hex_sha256(&manifest_bytes);
    let (output_sha256, _) = crate::rights::gate::hash_file(output_path)
        .map_err(|_| invalid_review_record("output_unreadable"))?;
    if output_sha256 != manifest.output.sha256 {
        return Err(invalid_review_record("output_changed"));
    }
    let record_path =
        review_record_path_for(output_path).ok_or_else(|| invalid_review_record("path"))?;
    let mut decisions = Vec::new();
    if let Some(bytes) = read_bounded(&record_path, REVIEW_RECORD_MAX_BYTES, true)? {
        let text =
            std::str::from_utf8(&bytes).map_err(|_| invalid_review_record("malformed_line"))?;
        if !text.is_empty() && !text.ends_with('\n') {
            return Err(invalid_review_record("malformed_line"));
        }
        let findings: BTreeMap<&str, &QcFinding> = manifest
            .qc
            .findings
            .iter()
            .map(|finding| (finding.finding_id.as_str(), finding))
            .collect();
        for line in text.lines() {
            let decision: ReviewDecision =
                serde_json::from_str(line).map_err(|_| invalid_review_record("malformed_line"))?;
            let canonical = serde_json_canonicalizer::to_string(&decision)
                .map_err(|_| invalid_review_record("malformed_line"))?;
            if canonical != line || !validate_decision_shape(&decision) {
                return Err(invalid_review_record("malformed_line"));
            }
            if decision.manifest_sha256 != manifest_sha256
                || decision.output_sha256 != output_sha256
            {
                return Err(invalid_review_record("digest_mismatch"));
            }
            let Some(finding) = findings.get(decision.finding_id.as_str()) else {
                return Err(invalid_review_record("unknown_finding"));
            };
            // A rights override can never take effect; skip it on read.
            if matches!(decision.body, ReviewDecisionBody::AcceptAnyway { .. })
                && !is_overridable(finding)
            {
                continue;
            }
            decisions.push(decision);
        }
    }
    let release = evaluate_release(&manifest.qc.findings, &decisions);
    Ok(ReviewState {
        manifest,
        manifest_sha256,
        decisions,
        release,
    })
}

fn request_finding_id(request: &ReviewDecisionRequest) -> &str {
    match request {
        ReviewDecisionRequest::AcceptAnyway { finding_id, .. }
        | ReviewDecisionRequest::RepairAttempt { finding_id, .. }
        | ReviewDecisionRequest::RepairStopped { finding_id } => finding_id,
    }
}

/// Builds the next decision for `request`, enforcing the repair attempt limit.
pub(crate) fn next_decision(
    state: &ReviewState,
    request: ReviewDecisionRequest,
    decision_id: String,
    recorded_at: String,
) -> Result<ReviewDecision, VideoCommandError> {
    let finding_id = request_finding_id(&request).to_owned();
    let finding = state
        .manifest
        .qc
        .findings
        .iter()
        .find(|finding| finding.finding_id == finding_id)
        .ok_or_else(|| invalid_review_record("unknown_finding"))?;
    let history: Vec<&ReviewDecision> = state
        .decisions
        .iter()
        .filter(|decision| decision.finding_id == finding_id)
        .collect();
    let stopped = history
        .iter()
        .any(|decision| matches!(decision.body, ReviewDecisionBody::RepairStopped { .. }));
    let proposals: Vec<&str> = history
        .iter()
        .filter_map(|decision| match &decision.body {
            ReviewDecisionBody::RepairAttempt { proposal_id, .. } => Some(proposal_id.as_str()),
            _ => None,
        })
        .fold(Vec::new(), |mut seen, id| {
            if !seen.contains(&id) {
                seen.push(id);
            }
            seen
        });
    let body = match request {
        ReviewDecisionRequest::AcceptAnyway { reason, .. } => {
            if !is_overridable(finding) {
                return Err(invalid_review_record("rights_not_overridable"));
            }
            let reason = reason.trim().to_owned();
            if reason.is_empty() || reason.len() > ACCEPT_REASON_MAX {
                return Err(invalid_review_record("reason"));
            }
            ReviewDecisionBody::AcceptAnyway { reason }
        }
        ReviewDecisionRequest::RepairAttempt {
            proposal_id,
            outcome,
            ..
        } => {
            if proposal_id.is_empty() || proposal_id.len() > 128 {
                return Err(invalid_review_record("proposal_id"));
            }
            if stopped {
                return Err(invalid_review_record("repair_stopped"));
            }
            let attempt = match proposals.iter().position(|id| *id == proposal_id) {
                Some(index) => index as u64 + 1,
                None if outcome == RepairOutcome::Proposed => proposals.len() as u64 + 1,
                None => return Err(invalid_review_record("unknown_proposal")),
            };
            if attempt > REPAIR_ATTEMPT_LIMIT {
                return Err(invalid_review_record("repair_attempt_limit"));
            }
            ReviewDecisionBody::RepairAttempt {
                attempt,
                proposal_id,
                outcome,
            }
        }
        ReviewDecisionRequest::RepairStopped { .. } => {
            if stopped {
                return Err(invalid_review_record("repair_stopped"));
            }
            ReviewDecisionBody::RepairStopped {
                reason: if proposals.len() as u64 >= REPAIR_ATTEMPT_LIMIT {
                    RepairStopReason::AttemptLimit
                } else {
                    RepairStopReason::UserStopped
                },
            }
        }
    };
    Ok(ReviewDecision {
        schema_version: REVIEW_DECISION_SCHEMA_VERSION,
        decision_id,
        finding_id,
        output_sha256: state.manifest.output.sha256.clone(),
        manifest_sha256: state.manifest_sha256.clone(),
        recorded_at,
        body,
    })
}

/// Validates the existing record, then appends one canonical line + fsync.
pub(crate) fn append_review_decision(
    output_path: &Path,
    request: ReviewDecisionRequest,
    decision_id: String,
    recorded_at: String,
) -> Result<(ReviewDecision, ReviewState), VideoCommandError> {
    let state = read_review_state(output_path)?;
    let decision = next_decision(&state, request, decision_id, recorded_at)?;
    let mut line = serde_json_canonicalizer::to_vec(&decision)
        .map_err(|_| invalid_review_record("serialize"))?;
    line.push(b'\n');
    let record_path =
        review_record_path_for(output_path).ok_or_else(|| invalid_review_record("path"))?;
    if let Ok(metadata) = std::fs::symlink_metadata(&record_path) {
        if !metadata.file_type().is_file() {
            return Err(invalid_review_record("not_a_file"));
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&record_path)
        .map_err(|_| invalid_review_record("write"))?;
    file.write_all(&line)
        .and_then(|()| file.sync_all())
        .map_err(|_| invalid_review_record("write"))?;
    let state = read_review_state(output_path)?;
    Ok((decision, state))
}

/// Read the manifest, review decisions and release decision for an export.
/// The output path must already be granted to this window.
#[tauri::command]
pub async fn video_read_review_state<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    grants: tauri::State<'_, super::VideoPathGrants>,
    output_path: String,
) -> Result<ReviewState, VideoCommandError> {
    let output = grants.authorize(
        window.label(),
        super::GrantCategory::Output,
        Path::new(&output_path),
    )?;
    tauri::async_runtime::spawn_blocking(move || read_review_state(&output))
        .await
        .map_err(|_| invalid_review_record("read"))?
}

/// Append one review decision. Ids, digests and the timestamp are native.
#[tauri::command]
pub async fn video_record_review_decision<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    grants: tauri::State<'_, super::VideoPathGrants>,
    output_path: String,
    decision: serde_json::Value,
) -> Result<ReviewState, VideoCommandError> {
    let output = grants.authorize(
        window.label(),
        super::GrantCategory::Output,
        Path::new(&output_path),
    )?;
    let request: ReviewDecisionRequest =
        serde_json::from_value(decision).map_err(|_| invalid_review_record("malformed_request"))?;
    tauri::async_runtime::spawn_blocking(move || {
        append_review_decision(
            &output,
            request,
            uuid::Uuid::new_v4().to_string(),
            super::render_qc::now_rfc3339(),
        )
        .map(|(_, state)| state)
    })
    .await
    .map_err(|_| invalid_review_record("write"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::{
        qc::{QcFindingKind, QcRange, QcSeverity, QcStatus},
        render_manifest::{
            write_manifest, ManifestEditorial, ManifestOutput, ManifestProject, ManifestQc,
        },
    };

    const STATE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const AT: &str = "2026-10-01T00:00:00.000Z";

    fn finding(kind: QcFindingKind, source: QcSource, start: u64) -> QcFinding {
        QcFinding::new(
            kind,
            QcSeverity::Blocker,
            source,
            "",
            QcRange {
                start_us: start,
                end_us: start + 1_000_000,
            },
            "Problem".to_owned(),
            STATE,
        )
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        output: std::path::PathBuf,
        black: QcFinding,
        rights: QcFinding,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("export.mp4");
        std::fs::write(&output, b"encoded bytes").unwrap();
        let (sha, size) = crate::rights::gate::hash_file(&output).unwrap();
        let black = finding(QcFindingKind::BlackFrames, QcSource::Deterministic, 0);
        let rights = finding(QcFindingKind::RightsBlocked, QcSource::Rights, 2_000_000);
        let manifest = RenderManifest {
            schema_version: 1,
            kind: "review".to_owned(),
            preset_id: None,
            project: ManifestProject {
                revision_id: "00000000-0000-4000-8000-000000000001".to_owned(),
                revision_state_hash: STATE.to_owned(),
            },
            render_plan_sha256: STATE.to_owned(),
            toolchain_id: "ffmpeg-test".to_owned(),
            inputs: vec![],
            output: ManifestOutput {
                file_name: "export.mp4".to_owned(),
                sha256: sha,
                size_bytes: size,
                duration_microseconds: 4_000_000,
                width: 320,
                height: 180,
                video_codec: "h264".to_owned(),
                audio_codec: None,
            },
            loudness: None,
            qc: ManifestQc {
                status: QcStatus::Blocked,
                detector_version: "qc-v1".to_owned(),
                findings: vec![black.clone(), rights.clone()],
            },
            editorial: ManifestEditorial {
                evaluator_version: "editorial-v1".to_owned(),
                evaluation_sha256: STATE.to_owned(),
            },
            source: None,
            app_version: "0.1.0".to_owned(),
            created_at: AT.to_owned(),
        };
        write_manifest(&output, &manifest, false, None)
            .unwrap()
            .keep();
        Fixture {
            _dir: dir,
            output,
            black,
            rights,
        }
    }

    fn id(n: u8) -> String {
        format!("00000000-0000-4000-8000-0000000000{n:02x}")
    }

    fn accept(fx: &Fixture, n: u8) -> Result<(ReviewDecision, ReviewState), VideoCommandError> {
        append_review_decision(
            &fx.output,
            ReviewDecisionRequest::AcceptAnyway {
                finding_id: fx.black.finding_id.clone(),
                reason: "  Intentional fade  ".to_owned(),
            },
            id(n),
            AT.to_owned(),
        )
    }

    fn reason(error: &VideoCommandError) -> String {
        error.details["reason"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    #[test]
    fn blocked_until_accepted_and_rights_never_resolve() {
        let fx = fixture();
        let state = read_review_state(&fx.output).unwrap();
        assert!(
            matches!(state.release, ReleaseDecision::Blocked { ref unresolved_finding_ids } if unresolved_finding_ids.len() == 2)
        );
        let (decision, state) = accept(&fx, 1).unwrap();
        assert!(
            matches!(decision.body, ReviewDecisionBody::AcceptAnyway { ref reason } if reason == "Intentional fade")
        );
        assert_eq!(
            state.release,
            ReleaseDecision::Blocked {
                unresolved_finding_ids: vec![fx.rights.finding_id.clone()]
            }
        );
        let error = append_review_decision(
            &fx.output,
            ReviewDecisionRequest::AcceptAnyway {
                finding_id: fx.rights.finding_id.clone(),
                reason: "Please".to_owned(),
            },
            id(2),
            AT.to_owned(),
        )
        .unwrap_err();
        assert_eq!(error.code, VideoErrorCode::InvalidReviewRecord);
        assert_eq!(reason(&error), "rights_not_overridable");
    }

    #[test]
    fn appends_never_rewrite_existing_lines() {
        let fx = fixture();
        accept(&fx, 1).unwrap();
        let record = review_record_path_for(&fx.output).unwrap();
        let before = std::fs::read(&record).unwrap();
        accept(&fx, 2).unwrap();
        let after = std::fs::read(&record).unwrap();
        assert!(after.len() > before.len());
        assert_eq!(&after[..before.len()], &before[..]);
        assert_eq!(after.iter().filter(|byte| **byte == b'\n').count(), 2);
    }

    #[test]
    fn digest_mismatch_malformed_lines_and_changed_output_fail_closed() {
        let fx = fixture();
        accept(&fx, 1).unwrap();
        let record = review_record_path_for(&fx.output).unwrap();
        let good = std::fs::read_to_string(&record).unwrap();

        let foreign = good.replace(
            &read_review_state(&fx.output).unwrap().manifest_sha256,
            &"f".repeat(64),
        );
        std::fs::write(&record, &foreign).unwrap();
        assert_eq!(
            reason(&read_review_state(&fx.output).unwrap_err()),
            "digest_mismatch"
        );

        for malformed in [
            format!("{good}not json\n"),
            format!("{good}{{}}\n"),
            good.trim_end().to_owned(),
            // Unknown field: no longer equal to its canonical form.
            good.replacen("{\"decisionId\"", "{\"approvedBy\":\"x\",\"decisionId\"", 1),
        ] {
            std::fs::write(&record, malformed).unwrap();
            assert_eq!(
                reason(&read_review_state(&fx.output).unwrap_err()),
                "malformed_line"
            );
        }
        // A broken record also refuses new appends rather than appending past it.
        assert!(accept(&fx, 3).is_err());

        std::fs::write(&record, &good).unwrap();
        std::fs::write(&fx.output, b"different bytes").unwrap();
        assert_eq!(
            reason(&read_review_state(&fx.output).unwrap_err()),
            "output_changed"
        );
    }

    #[test]
    fn forged_rights_override_lines_are_ignored_on_read() {
        let fx = fixture();
        let state = read_review_state(&fx.output).unwrap();
        let forged = ReviewDecision {
            schema_version: 1,
            decision_id: id(9),
            finding_id: fx.rights.finding_id.clone(),
            output_sha256: state.manifest.output.sha256.clone(),
            manifest_sha256: state.manifest_sha256.clone(),
            recorded_at: AT.to_owned(),
            body: ReviewDecisionBody::AcceptAnyway {
                reason: "forged".to_owned(),
            },
        };
        let mut line = serde_json_canonicalizer::to_vec(&forged).unwrap();
        line.push(b'\n');
        std::fs::write(review_record_path_for(&fx.output).unwrap(), line).unwrap();
        let state = read_review_state(&fx.output).unwrap();
        assert!(state.decisions.is_empty());
        assert!(matches!(state.release, ReleaseDecision::Blocked { .. }));
    }

    fn repair(
        fx: &Fixture,
        n: u8,
        proposal: &str,
        outcome: RepairOutcome,
    ) -> Result<(ReviewDecision, ReviewState), VideoCommandError> {
        append_review_decision(
            &fx.output,
            ReviewDecisionRequest::RepairAttempt {
                finding_id: fx.black.finding_id.clone(),
                proposal_id: proposal.to_owned(),
                outcome,
            },
            id(n),
            AT.to_owned(),
        )
    }

    #[test]
    fn repair_attempts_are_limited_to_three_per_finding() {
        let fx = fixture();
        for (n, proposal) in [(1, "p1"), (2, "p2"), (3, "p3")] {
            let (decision, _) = repair(&fx, n, proposal, RepairOutcome::Proposed).unwrap();
            assert!(
                matches!(decision.body, ReviewDecisionBody::RepairAttempt { attempt, .. } if attempt == u64::from(n))
            );
        }
        // Outcomes for an existing proposal keep its attempt number.
        let (decision, _) = repair(&fx, 4, "p2", RepairOutcome::Undone).unwrap();
        assert!(matches!(
            decision.body,
            ReviewDecisionBody::RepairAttempt { attempt: 2, .. }
        ));
        assert_eq!(
            reason(&repair(&fx, 5, "p4", RepairOutcome::Proposed).unwrap_err()),
            "repair_attempt_limit"
        );
        assert_eq!(
            reason(&repair(&fx, 6, "unknown", RepairOutcome::Applied).unwrap_err()),
            "unknown_proposal"
        );
        let (stopped, _) = append_review_decision(
            &fx.output,
            ReviewDecisionRequest::RepairStopped {
                finding_id: fx.black.finding_id.clone(),
            },
            id(7),
            AT.to_owned(),
        )
        .unwrap();
        assert!(matches!(
            stopped.body,
            ReviewDecisionBody::RepairStopped {
                reason: RepairStopReason::AttemptLimit
            }
        ));
    }

    #[test]
    fn explicit_stop_ends_repair_but_still_allows_accept() {
        let fx = fixture();
        repair(&fx, 1, "p1", RepairOutcome::Proposed).unwrap();
        let (stopped, _) = append_review_decision(
            &fx.output,
            ReviewDecisionRequest::RepairStopped {
                finding_id: fx.black.finding_id.clone(),
            },
            id(2),
            AT.to_owned(),
        )
        .unwrap();
        assert!(matches!(
            stopped.body,
            ReviewDecisionBody::RepairStopped {
                reason: RepairStopReason::UserStopped
            }
        ));
        assert_eq!(
            reason(&repair(&fx, 3, "p2", RepairOutcome::Proposed).unwrap_err()),
            "repair_stopped"
        );
        assert!(accept(&fx, 4).is_ok());
    }
}
