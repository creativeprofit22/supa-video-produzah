use std::fs;

use serde_json::{json, Value};
use tempfile::tempdir;

use super::{
    proposal::{
        load_proposal_store, proposal_store_path, refresh_open_proposals, save_proposal_store,
        validate_proposal, NativeProposalStatus, ProposalAuditAction, ProposalStoreV1,
        StoreWriteFailpoint, StoredProposal, MAX_REVISION_DRIFT,
    },
    speed_edit_tests::fixture,
    types::VideoProjectSnapshotV2,
};

pub(super) fn pid(value: u64) -> String {
    format!("72000000-0000-4000-8000-{value:012x}")
}

fn time(value: u64) -> Value {
    json!({"value": value, "rateNumerator": 30, "rateDenominator": 1})
}

/// A transcript-style cut on the first video track: split twice, ripple-delete the middle.
pub(super) fn sample_proposal(snapshot: &VideoProjectSnapshotV2, seed: u64) -> Value {
    let sequence = &snapshot.state.sequences[0];
    let track = &sequence.tracks[0];
    let clip_id = track.clips().unwrap()[0].id.clone();
    let asset_id = match &track.clips().unwrap()[0].source {
        super::types::ClipSource::Asset { asset_id } => asset_id.clone(),
        super::types::ClipSource::Sequence { .. } => unreachable!("fixture clip is an asset"),
    };
    let (right, middle) = (pid(seed + 1), pid(seed + 2));
    let command = |kind: &str, extra: Value, index: u64| {
        let mut value = json!({
            "type": kind,
            "commandId": pid(seed + 10 + index),
            "sequenceId": sequence.id,
            "trackId": track.id(),
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        value
    };
    let range = json!({"start": time(100), "end": time(200)});
    json!({
        "schemaVersion": 2,
        "proposalId": pid(seed),
        "projectId": snapshot.id,
        "projectRevision": snapshot.revision,
        "sequenceId": sequence.id,
        "trackId": track.id(),
        "producer": {"id": "silence-gap", "version": "1", "kind": "rule", "parameters": {"minGapMs": 800}},
        "deletedGaps": [],
        "selectedOccurrenceIds": [],
        "deletedRanges": [{"clipId": clip_id, "assetId": asset_id, "sourceRange": range, "originalTimelineRange": range, "selectedWords": []}],
        "commandGroup": {
            "groupId": pid(seed + 3),
            "projectId": snapshot.id,
            "baseRevision": snapshot.revision.number,
            "commands": [
                command("SplitClip", json!({"clipId": clip_id, "splitAt": time(100), "rightClipId": middle}), 0),
                command("SplitClip", json!({"clipId": middle, "splitAt": time(200), "rightClipId": right}), 1),
                command("RippleDeleteClip", json!({"clipId": middle}), 2),
            ],
        },
    })
}

fn stored(view_json: &Value, snapshot: &VideoProjectSnapshotV2, created: u64) -> StoredProposal {
    let view = validate_proposal(view_json, snapshot).unwrap();
    StoredProposal {
        proposal_id: view.proposal_id,
        producer: view.producer,
        sequence_id: view.sequence_id,
        track_id: view.track_id,
        base_revision: view.project_revision,
        status: NativeProposalStatus::Pending,
        status_reason: None,
        created_at_ms: created,
        expires_at_ms: created + 1_000,
        applied_group_id: None,
        pre_apply_revision: None,
        approved_range_ids: Vec::new(),
        restore_operation_id: None,
        restore_steps: 0,
        proposal: view_json.clone(),
    }
}

fn category(
    result: Result<impl std::fmt::Debug, crate::video::error::VideoCommandError>,
) -> String {
    result.unwrap_err().details["category"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn valid_proposal_passes_native_validation() {
    let snapshot = fixture();
    let view = validate_proposal(&sample_proposal(&snapshot, 100), &snapshot).unwrap();
    assert_eq!(view.producer.id, "silence-gap");
    assert_eq!(view.command_group.commands.len(), 3);
}

#[test]
fn producer_reasons_pass_validation_and_stay_in_the_stored_proposal() {
    let snapshot = fixture();
    let mut proposal = sample_proposal(&snapshot, 100);
    proposal["reasons"] = json!([{"rangeId": "clip:100:200", "text": "Pause of about 2000 ms"}]);
    validate_proposal(&proposal, &snapshot).unwrap();
    let entry = stored(&proposal, &snapshot, 1);
    assert_eq!(entry.proposal["reasons"], proposal["reasons"]);
}

type Mutation = Box<dyn Fn(&mut Value)>;

#[test]
fn native_validation_rejects_bad_schema_revision_policy_and_locked_tracks() {
    let snapshot = fixture();
    let cases: Vec<(&str, Mutation)> = vec![
        (
            "proposal_schema_version",
            Box::new(|v| v["schemaVersion"] = json!(1)),
        ),
        (
            "proposal_schema",
            Box::new(|v| v["commandGroup"] = json!("nope")),
        ),
        (
            "proposal_ids",
            Box::new(|v| v["proposalId"] = json!("not-a-uuid")),
        ),
        (
            "proposal_producer",
            Box::new(|v| v["producer"]["id"] = json!("Bad Id")),
        ),
        (
            "proposal_producer",
            Box::new(|v| v["producer"]["parameters"]["nested"] = json!({"a": 1})),
        ),
        (
            "proposal_project",
            Box::new(|v| v["projectId"] = json!(pid(999))),
        ),
        (
            "proposal_base_revision",
            Box::new(|v| v["commandGroup"]["baseRevision"] = json!(5)),
        ),
        (
            "proposal_base_revision",
            Box::new(|v| v["projectRevision"]["stateHash"] = json!("0".repeat(64))),
        ),
        (
            "proposal_empty",
            Box::new(|v| v["deletedRanges"] = json!([])),
        ),
        (
            "proposal_command_policy",
            Box::new(|v| {
                let mut moved = v["commandGroup"]["commands"][2].clone();
                moved["type"] = json!("MoveClip");
                moved["timelineStart"] = time(900);
                v["commandGroup"]["commands"][2] = moved;
            }),
        ),
        (
            "proposal_command_scope",
            Box::new(|v| v["commandGroup"]["commands"][0]["trackId"] = json!(pid(7))),
        ),
    ];
    for (expected, mutate) in cases {
        let mut value = sample_proposal(&snapshot, 100);
        mutate(&mut value);
        assert_eq!(
            category(validate_proposal(&value, &snapshot)),
            expected,
            "mutation for {expected}"
        );
    }

    let mut locked = snapshot.clone();
    locked.state.sequences[0].tracks[0].set_locked(true);
    let value = sample_proposal(&locked, 100);
    assert_eq!(
        category(validate_proposal(&value, &locked)),
        "proposal_track_locked"
    );
}

#[test]
fn store_round_trips_atomically_and_quarantines_tampering() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("p.svpvideo");
    let snapshot = fixture();
    let loaded = load_proposal_store(&path, &snapshot.id).unwrap();
    assert!(!loaded.discarded);
    assert!(loaded.store.proposals.is_empty());

    let mut store = ProposalStoreV1::empty(&snapshot.id);
    store
        .proposals
        .push(stored(&sample_proposal(&snapshot, 100), &snapshot, 10));
    save_proposal_store(&path, &mut store, StoreWriteFailpoint::None).unwrap();
    let reloaded = load_proposal_store(&path, &snapshot.id).unwrap();
    assert!(!reloaded.discarded);
    assert_eq!(reloaded.store, store);

    // A failed write leaves the previous durable store intact.
    let mut changed = store.clone();
    changed.proposals.clear();
    assert!(save_proposal_store(&path, &mut changed, StoreWriteFailpoint::BeforeReplace).is_err());
    assert_eq!(
        load_proposal_store(&path, &snapshot.id).unwrap().store,
        store
    );

    // Tampering breaks the hash: the file is set aside and review starts empty.
    let store_path = proposal_store_path(&path).unwrap();
    let text = fs::read_to_string(&store_path)
        .unwrap()
        .replace("silence-gap", "filler-words");
    fs::write(&store_path, text).unwrap();
    let recovered = load_proposal_store(&path, &snapshot.id).unwrap();
    assert!(recovered.discarded);
    assert!(recovered.store.proposals.is_empty());
    assert!(store_path.with_extension("rejected.json").exists());
    assert!(!store_path.exists());
}

#[test]
fn refresh_marks_expired_and_stale_and_audits_them() {
    let snapshot = fixture();
    let mut store = ProposalStoreV1::empty(&snapshot.id);
    store
        .proposals
        .push(stored(&sample_proposal(&snapshot, 100), &snapshot, 10));
    store
        .proposals
        .push(stored(&sample_proposal(&snapshot, 200), &snapshot, 500));
    // Same revision, first one timed out.
    let audits = refresh_open_proposals(&mut store, &snapshot.revision, 1_100);
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0].action, ProposalAuditAction::Expired);
    assert_eq!(store.proposals[0].status, NativeProposalStatus::Expired);
    assert_eq!(store.proposals[1].status, NativeProposalStatus::Pending);
    // A few later edits are within the repair budget.
    let mut newer = snapshot.revision.clone();
    newer.number += MAX_REVISION_DRIFT;
    assert!(refresh_open_proposals(&mut store, &newer, 1_100).is_empty());
    // Same number, different revision: history diverged, so it is stale.
    let mut diverged = snapshot.revision.clone();
    diverged.id = pid(4242);
    let mut diverged_store = store.clone();
    let audits = refresh_open_proposals(&mut diverged_store, &diverged, 1_100);
    assert_eq!(audits[0].action, ProposalAuditAction::Stale);
    // Too far past the base: expired.
    newer.number += 1;
    let audits = refresh_open_proposals(&mut store, &newer, 1_100);
    assert_eq!(audits[0].action, ProposalAuditAction::Expired);
    assert_eq!(store.proposals[1].status, NativeProposalStatus::Expired);
    assert_eq!(store.audit.len(), 2);
    assert!(refresh_open_proposals(&mut store, &newer, 9_999).is_empty());
}

// ---- Service-level: apply, audit, restore, restart -------------------------

use super::{
    hash::canonical_bytes,
    journal::{journal_path, scan},
    service::VideoProjectService,
    snapshot::read_snapshot,
};
use crate::video::VideoPathGrants;

const OWNER: &str = "proposal-tests";
const NOW_MS: u64 = 1_750_000_000_000;

pub(super) struct OpenProject {
    pub _directory: tempfile::TempDir,
    pub path: std::path::PathBuf,
    pub grants: VideoPathGrants,
    pub original: VideoProjectSnapshotV2,
}

pub(super) fn open_project(service: &VideoProjectService) -> OpenProject {
    let directory = tempdir().unwrap();
    let path = directory.path().join("proposal.svpvideo");
    let original = fixture();
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
    let grants = VideoPathGrants::default();
    service.open(OWNER, &path, &grants).unwrap();
    OpenProject {
        _directory: directory,
        path,
        grants,
        original,
    }
}

#[test]
fn apply_commits_atomically_with_a_journal_audit_that_survives_replay() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = sample_proposal(snapshot, 100);
    let stored = service
        .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
        .unwrap();
    assert_eq!(stored.status, NativeProposalStatus::Pending);
    // Same proposal again is a no-op; a different body under the same id is refused.
    assert_eq!(
        service
            .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS + 5, 60_000)
            .unwrap(),
        stored
    );
    let mut conflicting = proposal.clone();
    conflicting["producer"]["version"] = json!("2");
    assert_eq!(
        category(service.submit_proposal(OWNER, &snapshot.id, &conflicting, NOW_MS, 60_000)),
        "proposal_id_reuse"
    );

    let result = service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &proposal,
            NOW_MS + 10,
            &project.grants,
        )
        .unwrap();
    assert_eq!(result.prior_revision, snapshot.revision);
    assert_eq!(result.new_revision.number, 1);
    // Retrying the same apply returns the same result.
    assert_eq!(
        service
            .apply_proposal(
                OWNER,
                &snapshot.id,
                &pid(100),
                &proposal,
                NOW_MS + 11,
                &project.grants
            )
            .unwrap(),
        result
    );

    let records = scan(&journal_path(&project.path).unwrap()).unwrap().records;
    assert_eq!(records.len(), 1);
    let audit = records[0].proposal_audit.as_ref().unwrap();
    assert_eq!(audit.action, ProposalAuditAction::Applied);
    assert_eq!(audit.proposal_id, pid(100));
    assert_eq!(audit.producer.id, "silence-gap");
    assert_eq!(audit.base_revision, 0);
    assert_eq!(audit.resulting_revision, Some(1));
    assert_eq!(audit.approved_range_ids.len(), 1);
    assert_eq!(audit.affected_ranges.len(), 1);
    // History provenance: the undo entry and lastCommand name the producer.
    assert!(records[0]
        .history_group
        .summary
        .contains("suggested by silence-gap"));
    assert!(records[0].summary.contains("silence-gap"));
    let last_command = result.projection.last_command.as_ref().unwrap();
    assert!(last_command.summary.contains("silence-gap"));

    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 20)
        .unwrap();
    assert_eq!(listing.proposals[0].status, NativeProposalStatus::Applied);
    assert_eq!(
        listing.proposals[0].pre_apply_revision.as_ref(),
        Some(&snapshot.revision)
    );
    assert_eq!(listing.audit.last().unwrap(), audit);

    // Pre-apply checkpoint: the on-disk snapshot is the state before the cut.
    assert_eq!(
        read_snapshot(&project.path).unwrap().revision,
        snapshot.revision
    );

    // Crash without checkpoint: replay keeps the audit and the cut.
    drop(service);
    let service = VideoProjectService::default();
    let reopened = service.open(OWNER, &project.path, &project.grants).unwrap();
    assert_eq!(reopened.projection.revision, result.new_revision);
    assert_eq!(reopened.projection.state, result.projection.state);
    assert_eq!(
        reopened.projection.last_command.as_ref(),
        Some(last_command)
    );
    let recovered = read_snapshot(&project.path).unwrap();
    assert_eq!(recovered.revision, result.new_revision);
    assert_eq!(
        recovered.history.undo_stack.last().unwrap().summary,
        records[0].history_group.summary
    );
    let records = scan(&journal_path(&project.path).unwrap()).unwrap().records;
    assert_eq!(records[0].proposal_audit.as_ref(), Some(audit));
}

/// Splits the proposal's clip before the cut, so the cut words sit in a clip
/// with a new id while their asset and source frames are unchanged.
fn split_before_cut(
    snapshot: &VideoProjectSnapshotV2,
) -> (super::types::CommandGroupRequest, String) {
    let sequence = &snapshot.state.sequences[0];
    let track = &sequence.tracks[0];
    let new_clip = pid(900);
    let request = serde_json::from_value(json!({
        "groupId": pid(901),
        "projectId": snapshot.id,
        "baseRevision": snapshot.revision.number,
        "commands": [{
            "type": "SplitClip",
            "commandId": pid(902),
            "sequenceId": sequence.id,
            "trackId": track.id(),
            "clipId": track.clips().unwrap()[0].id,
            "splitAt": time(50),
            "rightClipId": new_clip,
        }],
    }))
    .unwrap();
    (request, new_clip)
}

#[test]
fn apply_accepts_a_repair_whose_cut_sits_in_a_new_clip_with_the_same_source_frames() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = sample_proposal(snapshot, 100);
    service
        .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
        .unwrap();
    let (split, new_clip) = split_before_cut(snapshot);
    let edited = service.execute(OWNER, split, &project.grants).unwrap();
    assert_eq!(edited.new_revision.number, 1);

    // Re-derived against revision 1: same asset and source frames, new clip id.
    let mut repaired = sample_proposal(snapshot, 300);
    repaired["projectRevision"] = serde_json::to_value(&edited.new_revision).unwrap();
    repaired["commandGroup"]["baseRevision"] = json!(edited.new_revision.number);
    repaired["commandGroup"]["commands"][0]["clipId"] = json!(new_clip);
    repaired["deletedRanges"][0]["clipId"] = json!(new_clip);

    // Frames outside the offered range, or on another asset, are still refused.
    let mut wider = repaired.clone();
    wider["deletedRanges"][0]["sourceRange"]["end"] = time(250);
    let mut other_asset = repaired.clone();
    other_asset["deletedRanges"][0]["assetId"] = json!(pid(777));
    for refused in [&wider, &other_asset] {
        assert_eq!(
            category(service.apply_proposal(
                OWNER,
                &snapshot.id,
                &pid(100),
                refused,
                NOW_MS + 1,
                &project.grants
            )),
            "proposal_range_not_offered"
        );
    }

    let result = service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &repaired,
            NOW_MS + 2,
            &project.grants,
        )
        .unwrap();
    assert_eq!(result.new_revision.number, 2);
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 3)
        .unwrap();
    assert_eq!(listing.proposals[0].status, NativeProposalStatus::Applied);
    // The audit names the clip the applied cut really touched.
    let approved = &listing.audit.last().unwrap().approved_range_ids;
    assert_eq!(approved.len(), 1);
    assert!(approved[0].starts_with(&new_clip));
}

fn offered_range(asset: u64, start: u64, end: u64) -> super::proposal::ProposalDeletedRange {
    serde_json::from_value(json!({
        "clipId": pid(1),
        "assetId": pid(asset),
        "sourceRange": {"start": time(start), "end": time(end)},
        "originalTimelineRange": {"start": time(start), "end": time(end)},
    }))
    .unwrap()
}

#[test]
fn offered_check_uses_the_union_of_ranges_per_asset() {
    use super::proposal::ranges_are_offered;
    let offered = [offered_range(5, 10, 20), offered_range(5, 20, 30)];
    // Inside one range, and across two touching ranges.
    assert!(ranges_are_offered(&offered, &[offered_range(5, 12, 18)]));
    assert!(ranges_are_offered(&offered, &[offered_range(5, 15, 25)]));
    // Past the union, before it, on another asset, or empty.
    assert!(!ranges_are_offered(&offered, &[offered_range(5, 25, 31)]));
    assert!(!ranges_are_offered(&offered, &[offered_range(5, 5, 12)]));
    assert!(!ranges_are_offered(&offered, &[offered_range(6, 12, 18)]));
    assert!(!ranges_are_offered(&offered, &[offered_range(5, 15, 15)]));
    let gapped = [offered_range(5, 10, 20), offered_range(5, 22, 30)];
    assert!(!ranges_are_offered(&gapped, &[offered_range(5, 15, 25)]));
}

#[test]
fn apply_rejects_unoffered_ranges_mismatched_producers_and_closed_proposals() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = sample_proposal(snapshot, 100);
    service
        .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
        .unwrap();

    let mut other_producer = sample_proposal(snapshot, 300);
    other_producer["producer"]["id"] = json!("filler-words");
    assert_eq!(
        category(service.apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &other_producer,
            NOW_MS,
            &project.grants
        )),
        "proposal_mismatch"
    );
    let mut extra_range = sample_proposal(snapshot, 300);
    extra_range["deletedRanges"][0]["sourceRange"]["end"] = time(250);
    assert_eq!(
        category(service.apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &extra_range,
            NOW_MS,
            &project.grants
        )),
        "proposal_range_not_offered"
    );
    assert_eq!(
        category(service.apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(999),
            &proposal,
            NOW_MS,
            &project.grants
        )),
        "proposal_unknown"
    );
    // Nothing was committed by the refused attempts.
    assert!(scan(&journal_path(&project.path).unwrap())
        .unwrap()
        .records
        .is_empty());

    let rejected = service
        .reject_proposal(OWNER, &snapshot.id, &pid(100), NOW_MS + 1)
        .unwrap();
    assert_eq!(rejected.status, NativeProposalStatus::Rejected);
    assert_eq!(
        category(service.apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &proposal,
            NOW_MS + 2,
            &project.grants
        )),
        "proposal_not_open"
    );
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 3)
        .unwrap();
    assert_eq!(
        listing.audit.last().unwrap().action,
        ProposalAuditAction::Rejected
    );
}

fn later_gain_edit(
    snapshot: &VideoProjectSnapshotV2,
    base_revision: u64,
) -> super::types::CommandGroupRequest {
    let sequence = &snapshot.state.sequences[0];
    let track = &sequence.tracks[1];
    serde_json::from_value(json!({
        "groupId": pid(700),
        "projectId": snapshot.id,
        "baseRevision": base_revision,
        "commands": [{
            "type": "SetClipGain",
            "commandId": pid(701),
            "sequenceId": sequence.id,
            "trackId": track.id(),
            "clipId": track.clips().unwrap()[0].id,
            "gainMilliDecibels": -6000,
        }],
    }))
    .unwrap()
}

#[test]
fn restore_before_proposal_lands_on_the_pre_apply_state_and_stays_redoable() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = sample_proposal(snapshot, 100);
    service
        .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
        .unwrap();
    let applied = service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &proposal,
            NOW_MS + 1,
            &project.grants,
        )
        .unwrap();
    let later = service
        .execute(OWNER, later_gain_edit(snapshot, 1), &project.grants)
        .unwrap();
    assert_eq!(later.new_revision.number, 2);

    let results = service
        .restore_before_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &pid(800),
            NOW_MS + 2,
            &project.grants,
        )
        .unwrap();
    assert_eq!(results.len(), 2, "undoes the later edit and the proposal");
    let restored = results.last().unwrap();
    assert_eq!(restored.projection.state, snapshot.state);
    assert_eq!(restored.state_hash, snapshot.revision.state_hash);
    // Retry with the same operation id is answered, not repeated.
    assert_eq!(
        service
            .restore_before_proposal(
                OWNER,
                &snapshot.id,
                &pid(100),
                &pid(800),
                NOW_MS + 3,
                &project.grants
            )
            .unwrap(),
        results
    );
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 4)
        .unwrap();
    assert_eq!(listing.proposals[0].status, NativeProposalStatus::Restored);
    assert_eq!(
        listing.audit.last().unwrap().action,
        ProposalAuditAction::Restored
    );
    // A different restore attempt is refused: it is no longer applied.
    assert_eq!(
        category(service.restore_before_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &pid(801),
            NOW_MS + 5,
            &project.grants
        )),
        "proposal_not_applied"
    );

    // Both steps are ordinary history: redo brings the cut and the later edit back.
    let base = restored.new_revision.number;
    let redo_cut = service
        .redo(OWNER, &snapshot.id, base, &pid(810), &project.grants)
        .unwrap();
    assert_eq!(redo_cut.projection.state, applied.projection.state);
    let redo_later = service
        .redo(OWNER, &snapshot.id, base + 1, &pid(811), &project.grants)
        .unwrap();
    assert_eq!(redo_later.projection.state, later.projection.state);
}

#[test]
fn restore_is_unavailable_once_the_cut_left_the_undo_history() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = sample_proposal(snapshot, 100);
    service
        .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
        .unwrap();
    service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &proposal,
            NOW_MS + 1,
            &project.grants,
        )
        .unwrap();
    service
        .undo(OWNER, &snapshot.id, 1, &pid(820), &project.grants)
        .unwrap();
    assert_eq!(
        category(service.restore_before_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &pid(821),
            NOW_MS + 2,
            &project.grants
        )),
        "proposal_restore_unavailable"
    );
    assert_eq!(
        category(service.restore_before_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            "bad",
            NOW_MS + 2,
            &project.grants
        )),
        "operation_id"
    );
}

fn open_again(project: &OpenProject) -> VideoProjectService {
    let service = VideoProjectService::default();
    service.open(OWNER, &project.path, &project.grants).unwrap();
    service
}

#[test]
fn pending_proposal_survives_a_restart_and_can_still_be_applied() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = sample_proposal(snapshot, 100);
    service
        .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
        .unwrap();
    drop(service); // crash while the user is reviewing

    let service = open_again(&project);
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 1)
        .unwrap();
    assert_eq!(listing.proposals.len(), 1);
    assert_eq!(listing.proposals[0].status, NativeProposalStatus::Pending);
    assert_eq!(listing.proposals[0].proposal, proposal);
    assert!(!listing.store_discarded);
    service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &proposal,
            NOW_MS + 2,
            &project.grants,
        )
        .unwrap();
}

#[test]
fn proposal_goes_stale_when_replay_lands_before_its_base() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let edited = service
        .execute(OWNER, later_gain_edit(snapshot, 0), &project.grants)
        .unwrap();
    let mut at_rev1 = snapshot.clone();
    at_rev1.revision = edited.new_revision.clone();
    at_rev1.state = edited.projection.state.clone();
    let proposal = sample_proposal(&at_rev1, 100);
    service
        .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
        .unwrap();
    drop(service);

    // Tear the last journal record, as if the edit's append never finished.
    let journal = journal_path(&project.path).unwrap();
    let bytes = fs::read(&journal).unwrap();
    fs::write(&journal, &bytes[..bytes.len() - 40]).unwrap();

    let service = open_again(&project);
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 1)
        .unwrap();
    assert_eq!(listing.proposals[0].status, NativeProposalStatus::Stale);
    assert_eq!(
        listing.audit.last().unwrap().action,
        ProposalAuditAction::Stale
    );
    assert_eq!(
        category(service.apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &proposal,
            NOW_MS + 2,
            &project.grants
        )),
        "proposal_base_revision"
    );
}

#[test]
fn marking_a_proposal_stale_is_audited_idempotent_and_survives_reload() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = sample_proposal(snapshot, 100);
    service
        .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
        .unwrap();

    let stale = service
        .mark_proposal_stale(
            OWNER,
            &snapshot.id,
            &pid(100),
            "Project changed",
            NOW_MS + 1,
        )
        .unwrap();
    assert_eq!(stale.status, NativeProposalStatus::Stale);
    assert_eq!(stale.status_reason.as_deref(), Some("Project changed"));

    // A retry changes nothing and adds no second audit entry.
    let again = service
        .mark_proposal_stale(OWNER, &snapshot.id, &pid(100), "Other", NOW_MS + 2)
        .unwrap();
    assert_eq!(again, stale);
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 3)
        .unwrap();
    let stale_audits: Vec<_> = listing
        .audit
        .iter()
        .filter(|entry| entry.action == ProposalAuditAction::Stale)
        .collect();
    assert_eq!(stale_audits.len(), 1);
    assert_eq!(stale_audits[0].proposal_id, pid(100));
    assert_eq!(stale_audits[0].at_ms, NOW_MS + 1);

    // Unknown proposals are refused, and a stale one can no longer be applied.
    assert_eq!(
        category(service.mark_proposal_stale(OWNER, &snapshot.id, &pid(999), "x", NOW_MS + 4)),
        "proposal_unknown"
    );
    assert_eq!(
        category(service.apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &proposal,
            NOW_MS + 5,
            &project.grants
        )),
        "proposal_not_open"
    );

    // The mark and its audit are durable across a restart.
    drop(service);
    let service = open_again(&project);
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 6)
        .unwrap();
    assert_eq!(listing.proposals[0].status, NativeProposalStatus::Stale);
    assert_eq!(
        listing.proposals[0].status_reason.as_deref(),
        Some("Project changed")
    );
    assert_eq!(
        listing
            .audit
            .iter()
            .filter(|entry| entry.action == ProposalAuditAction::Stale)
            .count(),
        1
    );
}

#[test]
fn crash_after_commit_before_store_write_is_settled_from_the_journal() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = sample_proposal(snapshot, 100);
    service
        .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
        .unwrap();
    service.set_proposal_store_failpoint(StoreWriteFailpoint::BeforeReplace);
    let applied = service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &proposal,
            NOW_MS + 1,
            &project.grants,
        )
        .unwrap();
    // The store on disk still says pending: the write was lost.
    let on_disk = load_proposal_store(&project.path, &snapshot.id)
        .unwrap()
        .store;
    assert_eq!(on_disk.proposals[0].status, NativeProposalStatus::Pending);
    drop(service);

    let service = open_again(&project);
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 2)
        .unwrap();
    let settled = &listing.proposals[0];
    assert_eq!(settled.status, NativeProposalStatus::Applied);
    assert_eq!(
        settled.pre_apply_revision.as_ref(),
        Some(&snapshot.revision)
    );
    assert_eq!(
        listing.audit.last().unwrap().action,
        ProposalAuditAction::Applied
    );
    // A retry is answered from the replayed journal, not cut twice, and
    // restore still works from the recovered record.
    let retried = service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &proposal,
            NOW_MS + 3,
            &project.grants,
        )
        .unwrap();
    assert_eq!(retried.new_revision, applied.new_revision);
    let restored = service
        .restore_before_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &pid(900),
            NOW_MS + 4,
            &project.grants,
        )
        .unwrap();
    assert_eq!(restored.last().unwrap().projection.state, snapshot.state);
    assert_ne!(applied.projection.state, snapshot.state);
}

#[test]
fn failed_store_write_on_submit_keeps_nothing_half_written() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    service.set_proposal_store_failpoint(StoreWriteFailpoint::BeforeReplace);
    assert!(service
        .submit_proposal(
            OWNER,
            &snapshot.id,
            &sample_proposal(snapshot, 100),
            NOW_MS,
            60_000
        )
        .is_err());
    service.set_proposal_store_failpoint(StoreWriteFailpoint::None);
    let listing = service.list_proposals(OWNER, &snapshot.id, NOW_MS).unwrap();
    assert!(listing.proposals.is_empty());
}

/// Graphics commands stay outside the agent proposal surface until phase 19 (ADR 0003).
fn graphics_proposal(snapshot: &VideoProjectSnapshotV2, seed: u64, command: Value) -> Value {
    let mut proposal = sample_proposal(snapshot, seed);
    let mut graphics = command;
    graphics["commandId"] = json!(pid(seed + 20));
    graphics["sequenceId"] = proposal["sequenceId"].clone();
    graphics["trackId"] = proposal["trackId"].clone();
    proposal["commandGroup"]["commands"]
        .as_array_mut()
        .unwrap()
        .push(graphics);
    proposal
}

fn hold(value: f64) -> Value {
    json!([{ "timeMicroseconds": 0, "value": value }])
}

fn graphics_layers() -> Value {
    json!([{
        "kind": "rect", "width": 100, "height": 50, "cornerRadius": 0, "fill": "#FFFFFF",
        "x": hold(0.0), "y": hold(0.0), "scale": hold(1.0), "rotation": hold(0.0), "opacity": hold(1.0),
    }])
}

fn graphics_commands() -> [(&'static str, Value); 2] {
    [
        (
            "AddGraphicsClip",
            json!({
                "type": "AddGraphicsClip",
                "graphicsClip": {
                    "graphicsVersion": 1,
                    "id": pid(501),
                    "timelineStart": time(0),
                    "duration": time(30),
                    "fontKey": "segoe-ui-bold",
                    "layers": graphics_layers(),
                },
            }),
        ),
        (
            "SetGraphicsClipLayers",
            json!({
                "type": "SetGraphicsClipLayers",
                "graphicsClipId": pid(501),
                "fontKey": "segoe-ui-bold",
                "layers": graphics_layers(),
            }),
        ),
    ]
}

#[test]
fn proposals_carrying_graphics_commands_are_rejected_by_policy() {
    let snapshot = fixture();
    for (name, command) in graphics_commands() {
        let proposal = graphics_proposal(&snapshot, 100, command);
        let error = validate_proposal(&proposal, &snapshot).unwrap_err();
        assert_eq!(
            error.code,
            crate::video::error::VideoErrorCode::InvalidCommand,
            "{name}"
        );
        assert_eq!(
            error.details["category"], "proposal_command_policy",
            "{name}"
        );
    }
}

#[test]
fn submitting_a_graphics_proposal_leaves_no_pending_proposal() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    for (name, command) in graphics_commands() {
        let proposal = graphics_proposal(snapshot, 100, command);
        let error = service
            .submit_proposal(OWNER, &snapshot.id, &proposal, NOW_MS, 60_000)
            .unwrap_err();
        assert_eq!(
            error.code,
            crate::video::error::VideoErrorCode::InvalidCommand,
            "{name}"
        );
    }
    let listing = service.list_proposals(OWNER, &snapshot.id, NOW_MS).unwrap();
    assert!(listing.proposals.is_empty());
}
