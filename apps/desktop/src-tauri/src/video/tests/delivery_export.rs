//! Deliver gate and preset renders (plan step 9).

use std::collections::BTreeMap;

use serde_json::json;

use super::qc_export::{bundled_programs, make_fixture, CLEAN_AUDIO, CLEAN_VIDEO};
use super::*;
use crate::rights::{gate::RenderRights, store::ReceiptStore};
use crate::video::{
    delivery::{prepare_delivery, DeliveryRequest, DELIVERY_PRESETS},
    qc::{
        DeliveryGate, EditorialEvaluation, QcFinding, QcFindingKind, QcRange, QcSeverity, QcSource,
        QcStatus, RenderQcContext,
    },
    render::{RenderWorkerHooks, ValidatedRenderPlan},
    render_manifest::{
        manifest_path_for, write_manifest, ManifestEditorial, ManifestOutput, ManifestProject,
        ManifestQc, RenderManifest,
    },
    review_record::{append_review_decision, ReviewDecisionRequest},
};

const OWNER: &str = RENDER_INTEGRATION_OWNER;
pub(super) const STATE: &str = "5555555555555555555555555555555555555555555555555555555555555555";
const AT: &str = "2026-10-01T00:00:00.000Z";

fn finding(
    kind: QcFindingKind,
    severity: QcSeverity,
    source: QcSource,
    subject: &str,
) -> QcFinding {
    QcFinding::new(
        kind,
        severity,
        source,
        subject,
        QcRange {
            start_us: 500_000,
            end_us: 1_500_000,
        },
        "Problem".to_owned(),
        STATE,
    )
}

pub(super) fn editorial_warning() -> QcFinding {
    finding(
        QcFindingKind::RepeatedAsset,
        QcSeverity::Warning,
        QcSource::Editorial,
        "66666666-6666-4666-8666-6666666666c1",
    )
}

fn editorial_blocker() -> QcFinding {
    finding(
        QcFindingKind::UncoveredBeat,
        QcSeverity::Blocker,
        QcSource::Editorial,
        "beat-0000000000000001",
    )
}

pub(super) fn editorial_json(findings: &[QcFinding]) -> Value {
    serde_json::to_value(EditorialEvaluation {
        evaluator_version: "editorial-v1".to_owned(),
        revision_id: RENDER_REVISION_ID.to_owned(),
        revision_state_hash: STATE.to_owned(),
        findings: findings.to_vec(),
    })
    .unwrap()
}

fn fake_review_export(dir: &Path, grants: &VideoPathGrants, findings: Vec<QcFinding>) -> PathBuf {
    fake_review_export_for(OWNER, dir, grants, findings)
}

/// Writes a review export (fake bytes + manifest) and grants it as an output.
pub(super) fn fake_review_export_for(
    owner: &str,
    dir: &Path,
    grants: &VideoPathGrants,
    findings: Vec<QcFinding>,
) -> PathBuf {
    let output = grants
        .grant_destination(owner, GrantCategory::Output, &dir.join("review.mp4"))
        .unwrap();
    fs::write(&output, b"review bytes").unwrap();
    let (sha256, size_bytes) = crate::rights::gate::hash_file(&output).unwrap();
    let status = if findings.iter().any(|f| f.severity == QcSeverity::Blocker) {
        QcStatus::Blocked
    } else if findings.is_empty() {
        QcStatus::Passed
    } else {
        QcStatus::Warnings
    };
    let manifest = RenderManifest {
        schema_version: 1,
        kind: "review".to_owned(),
        preset_id: None,
        project: ManifestProject {
            revision_id: RENDER_REVISION_ID.to_owned(),
            revision_state_hash: STATE.to_owned(),
        },
        render_plan_sha256: STATE.to_owned(),
        toolchain_id: "ffmpeg-test".to_owned(),
        inputs: vec![],
        output: ManifestOutput {
            file_name: "review.mp4".to_owned(),
            sha256,
            size_bytes,
            duration_microseconds: 2_000_000,
            width: 320,
            height: 180,
            video_codec: "h264".to_owned(),
            audio_codec: Some("aac".to_owned()),
        },
        loudness: None,
        qc: ManifestQc {
            status,
            detector_version: "qc-v1".to_owned(),
            findings,
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
    output
}

pub(super) fn accept(output: &Path, finding_id: &str, decision_id: &str) {
    append_review_decision(
        output,
        ReviewDecisionRequest::AcceptAnyway {
            finding_id: finding_id.to_owned(),
            reason: "Intentional".to_owned(),
        },
        decision_id.to_owned(),
        AT.to_owned(),
    )
    .unwrap();
}

struct Gate {
    dir: tempfile::TempDir,
    grants: VideoPathGrants,
    store: ReceiptStore,
    source: PathBuf,
}

fn gate(source_media: Option<PathBuf>) -> Gate {
    let dir = tempdir().unwrap();
    let source = match source_media {
        Some(path) => path,
        None => {
            let path = dir.path().join("source.mp4");
            fs::write(&path, b"source").unwrap();
            path
        }
    };
    let grants = VideoPathGrants::default();
    let source = grants
        .grant_existing_file(OWNER, GrantCategory::Source, &source)
        .unwrap();
    let store = ReceiptStore::open(&dir.path().join("rights")).unwrap();
    Gate {
        dir,
        grants,
        store,
        source,
    }
}

impl Gate {
    fn preset_plan(&self, index: usize, width: u64, height: u64) -> Value {
        let output = self
            .grants
            .grant_destination(
                OWNER,
                GrantCategory::Output,
                &self.dir.path().join(format!("deliver-{index}.mp4")),
            )
            .unwrap();
        render_plan_value_for_profile(
            &self.source,
            &output,
            true,
            &format!("88888888-8888-4888-8888-88888888880{index}"),
            60,
            30,
            1,
            width,
            height,
        )
    }

    fn request(&self, source_output: &Path, editorial: &[QcFinding]) -> DeliveryRequest {
        serde_json::from_value(json!({
            "sourceOutputPath": source_output.to_string_lossy(),
            "presets": DELIVERY_PRESETS.iter().enumerate().map(|(index, preset)| json!({
                "presetId": preset.id,
                "plan": self.preset_plan(index, preset.width, preset.height),
                "editorial": editorial_json(editorial),
            })).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    fn prepare(
        &self,
        request: DeliveryRequest,
        state_hash: Option<&str>,
    ) -> Result<Vec<ValidatedRenderPlan>, Value> {
        let rights = RenderRights {
            lookup: &self.store,
            now_ms: 1_800_000_000_000,
            freshness: Duration::from_secs(30 * 24 * 60 * 60),
        };
        let lookup = |_: &str| state_hash.map(str::to_owned);
        prepare_delivery(OWNER, &self.grants, &rights, request, &lookup)
            .map_err(|error| serde_json::to_value(error).unwrap())
    }
}

#[test]
fn blocked_review_export_refuses_delivery() {
    let gate = gate(None);
    let blocker = finding(
        QcFindingKind::BlackFrames,
        QcSeverity::Blocker,
        QcSource::Deterministic,
        "",
    );
    let source = fake_review_export(gate.dir.path(), &gate.grants, vec![blocker.clone()]);
    let error = gate
        .prepare(gate.request(&source, &[]), Some(STATE))
        .unwrap_err();
    assert_eq!(error["code"], "qc_release_blocked");
    assert_eq!(error["details"]["findingIds"], json!([blocker.finding_id]));
    // Accepting it makes the same source deliverable.
    accept(
        &source,
        &blocker.finding_id,
        "00000000-0000-4000-8000-0000000000d1",
    );
    assert_eq!(
        gate.prepare(gate.request(&source, &[]), Some(STATE))
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn unaccepted_editorial_blocker_refuses_delivery_before_any_render() {
    let gate = gate(None);
    let source = fake_review_export(gate.dir.path(), &gate.grants, vec![]);
    let blocker = editorial_blocker();
    let error = gate
        .prepare(
            gate.request(&source, std::slice::from_ref(&blocker)),
            Some(STATE),
        )
        .unwrap_err();
    assert_eq!(error["code"], "qc_release_blocked");
    assert_eq!(error["details"]["findingIds"], json!([blocker.finding_id]));
    for index in 0..3 {
        assert!(!gate
            .dir
            .path()
            .join(format!("deliver-{index}.mp4"))
            .exists());
    }
}

#[test]
fn changed_revision_wrong_frame_size_and_unknown_preset_are_refused() {
    let gate = gate(None);
    let source = fake_review_export(gate.dir.path(), &gate.grants, vec![]);
    let changed = gate
        .prepare(gate.request(&source, &[]), Some(&"6".repeat(64)))
        .unwrap_err();
    assert_eq!(changed["details"]["reason"], "revision_changed");
    let closed = gate.prepare(gate.request(&source, &[]), None).unwrap_err();
    assert_eq!(closed["details"]["reason"], "revision_changed");

    let mut request = gate.request(&source, &[]);
    request.presets[1].plan = gate.preset_plan(1, 1920, 1080);
    let wrong = gate.prepare(request, Some(STATE)).unwrap_err();
    assert_eq!(wrong["details"]["category"], "delivery_frame_size");

    let mut request = gate.request(&source, &[]);
    request.presets[0].preset_id = "cinema_4k".to_owned();
    let unknown = gate.prepare(request, Some(STATE)).unwrap_err();
    assert_eq!(unknown["details"]["category"], "delivery_preset");
}

fn delivery_context(
    validated: &ValidatedRenderPlan,
    accepted: BTreeMap<String, String>,
) -> RenderQcContext {
    let preset = &DELIVERY_PRESETS[0];
    RenderQcContext {
        revision_state_hash: STATE.to_owned(),
        editorial: EditorialEvaluation {
            evaluator_version: "editorial-v1".to_owned(),
            revision_id: validated.plan.revision_id().as_str().to_owned(),
            revision_state_hash: STATE.to_owned(),
            findings: vec![],
        },
        delivery: Some(DeliveryGate {
            preset_id: preset.id.to_owned(),
            width: preset.width,
            height: preset.height,
            thumbnail_at_permille: preset.thumbnail_at_permille,
            source_manifest_sha256: STATE.to_owned(),
            accepted,
        }),
    }
}

#[tokio::test]
async fn preset_render_with_a_new_blocker_is_not_promoted() {
    let workspace = tempdir().unwrap();
    let programs = bundled_programs(workspace.path());
    let black = make_fixture(
        workspace.path(),
        "black",
        "color=black:s=320x180:r=30:d=4",
        CLEAN_AUDIO,
    );
    let mut validated = validated_system_render_fixture(
        workspace.path(),
        &black,
        true,
        "88888888-8888-4888-8888-8888888888a1",
        CANONICAL_RENDER_PROFILE,
    );
    validated.qc = Some(delivery_context(&validated, BTreeMap::new()));
    let output = validated.output_path.clone();
    let partial = partial_render_path(&validated).unwrap();
    let (request, captured) = registered_render_worker(
        validated,
        false,
        workspace.path().join("app-cache"),
        programs,
    );
    run_render_worker(request).await;
    let events = captured_render_events(&captured);
    let Some(VideoRenderEvent::Failed { error, .. }) = events.last() else {
        panic!("blocked preset must fail: {:?}", events.last());
    };
    assert_eq!(error.code, VideoErrorCode::QcReleaseBlocked);
    assert!(!output.exists() && !partial.exists());
    assert!(!manifest_path_for(&output).unwrap().exists());
    assert!(!workspace
        .path()
        .read_dir()
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().contains(".thumbnail")));
}

/// Review export → accept an editorial warning → deliver all three presets.
#[tokio::test]
async fn accepted_editorial_warning_carries_over_to_all_three_presets() {
    let workspace = tempdir().unwrap();
    let programs = bundled_programs(workspace.path());
    let media = make_fixture(workspace.path(), "source", CLEAN_VIDEO, CLEAN_AUDIO);
    let gate = gate(Some(media));
    let warning = editorial_warning();

    // 1. Review export with the editorial warning.
    let review_output = gate
        .grants
        .grant_destination(
            OWNER,
            GrantCategory::Output,
            &gate.dir.path().join("review.mp4"),
        )
        .unwrap();
    let plan = render_plan_value_for_profile(
        &gate.source,
        &review_output,
        true,
        "88888888-8888-4888-8888-8888888888b0",
        60,
        30,
        1,
        320,
        180,
    );
    let mut validated = parse_and_validate_render_plan(plan, OWNER, &gate.grants).unwrap();
    validated.qc = Some(RenderQcContext {
        revision_state_hash: STATE.to_owned(),
        editorial: serde_json::from_value(editorial_json(std::slice::from_ref(&warning))).unwrap(),
        delivery: None,
    });
    let (request, captured) = registered_render_worker(
        validated,
        false,
        workspace.path().join("app-cache"),
        programs.clone(),
    );
    run_render_worker(request).await;
    let events = captured_render_events(&captured);
    let Some(VideoRenderEvent::Completed { output, .. }) = events.last() else {
        panic!("review export must complete: {:?}", events.last());
    };
    let review_manifest_sha256 = output.qc.as_ref().unwrap().manifest_sha256.clone();

    // 2. Accept the warning in the review record.
    let decision_id = "00000000-0000-4000-8000-0000000000e1";
    accept(&review_output, &warning.finding_id, decision_id);

    // 3. Deliver all three presets from the same revision.
    let prepared = gate
        .prepare(
            gate.request(&review_output, std::slice::from_ref(&warning)),
            Some(STATE),
        )
        .unwrap();
    assert_eq!(prepared.len(), 3);
    for (validated, preset) in prepared.into_iter().zip(DELIVERY_PRESETS.iter()) {
        let output_path = validated.output_path.clone();
        let (mut request, captured) = registered_render_worker(
            validated,
            false,
            workspace.path().join("app-cache"),
            programs.clone(),
        );
        request.hooks = RenderWorkerHooks::default();
        run_render_worker(request).await;
        let events = captured_render_events(&captured);
        let Some(VideoRenderEvent::Completed { output, .. }) = events.last() else {
            panic!("preset {} must complete: {:?}", preset.id, events.last());
        };
        assert_eq!(
            (output.probe.width, output.probe.height),
            (preset.width, preset.height)
        );
        let manifest: Value =
            serde_json::from_slice(&fs::read(manifest_path_for(&output_path).unwrap()).unwrap())
                .unwrap();
        assert_eq!(manifest["kind"], "delivery");
        assert_eq!(manifest["presetId"], preset.id);
        assert_eq!(manifest["output"]["width"], preset.width);
        assert_eq!(
            manifest["source"]["reviewManifestSha256"],
            review_manifest_sha256
        );
        assert_eq!(
            manifest["source"]["acceptedDecisionIds"],
            json!([decision_id])
        );
        let ids: Vec<&str> = manifest["qc"]["findings"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|finding| finding["findingId"].as_str())
            .collect();
        assert_eq!(
            ids,
            vec![warning.finding_id.as_str()],
            "preset {}",
            preset.id
        );
        let name = output_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let thumbnail =
            fs::read(output_path.with_file_name(format!("{name}.thumbnail.jpg"))).unwrap();
        assert_eq!(&thumbnail[..2], &[0xFF, 0xD8], "thumbnail must be a JPEG");
        let metadata: Value = serde_json::from_slice(
            &fs::read(output_path.with_file_name(format!("{name}.metadata.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["presetId"], preset.id);
        assert_eq!(metadata["outputSha256"], manifest["output"]["sha256"]);
    }
}
