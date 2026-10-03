//! Graphics proposals (ADR 0005): add-only validation, review-before-change,
//! subset apply with byte-equal commands, reject, restore, stale and reload.

use serde_json::{json, Value};

use super::{
    hash::canonical_bytes,
    proposal::{
        validate_proposal, NativeProposalStatus, ProposalAuditAction, ProposalBody,
        MAX_PROPOSAL_BYTES,
    },
    proposal_tests::{open_project, pid, OpenProject},
    service::VideoProjectService,
    snapshot::read_snapshot,
    speed_edit_tests::fixture,
    types::{ProjectTrack, VideoProjectSnapshotV2, MAX_COMMAND_GROUP_BYTES},
};
use crate::video::error::VideoCommandError;

const OWNER: &str = "proposal-tests";
const NOW_MS: u64 = 1_750_000_000_000;
const TRACK_SEED: u64 = 900;

fn time(value: u64) -> Value {
    json!({"value": value, "rateNumerator": 30, "rateDenominator": 1})
}

fn hold(value: f64) -> Value {
    json!([{ "timeMicroseconds": 0, "value": value }])
}

fn clip(id: u64, start: u64) -> Value {
    json!({
        "graphicsVersion": 1,
        "id": pid(id),
        "timelineStart": time(start),
        "duration": time(20),
        "fontKey": "segoe-ui-bold",
        "layers": [{
            "kind": "text", "text": format!("Card {id}"), "fontSize": 48, "fill": "#FFFFFF",
            "x": hold(10.0), "y": hold(10.0), "scale": hold(1.0), "rotation": hold(0.0), "opacity": hold(1.0),
        }],
    })
}

/// Three cards on a new graphics track: an `InsertTrack`, then one
/// `AddGraphicsClip` per item, in item order.
fn graphics_proposal(snapshot: &VideoProjectSnapshotV2, seed: u64) -> Value {
    let sequence = &snapshot.state.sequences[0];
    let track_id = pid(TRACK_SEED);
    let items = ["title", "lower", "end-card"];
    let mut commands = vec![json!({
        "type": "InsertTrack",
        "commandId": pid(seed + 10),
        "sequenceId": sequence.id,
        "index": 0,
        "track": {"kind": "graphics", "id": track_id, "name": "Graphics", "graphicsClips": []},
    })];
    for (index, _) in items.iter().enumerate() {
        let index = index as u64;
        commands.push(json!({
            "type": "AddGraphicsClip",
            "commandId": pid(seed + 20 + index),
            "sequenceId": sequence.id,
            "trackId": track_id,
            "graphicsClip": clip(seed + 30 + index, index * 40),
        }));
    }
    json!({
        "schemaVersion": 1,
        "proposalKind": "graphics",
        "proposalId": pid(seed),
        "projectId": snapshot.id,
        "projectRevision": snapshot.revision,
        "sequenceId": sequence.id,
        "trackId": track_id,
        "producer": {"id": "recipe-graphics", "version": "1", "kind": "rule", "parameters": {"recipeId": "retro"}},
        "description": {"schemaVersion": 1, "recipeId": "retro", "items": []},
        "items": items.iter().enumerate().map(|(index, item)| json!({
            "itemId": item,
            "label": format!("Card · {item}"),
            "graphicsClipId": pid(seed + 30 + index as u64),
        })).collect::<Vec<_>>(),
        "commandGroup": {
            "groupId": pid(seed + 1),
            "projectId": snapshot.id,
            "baseRevision": snapshot.revision.number,
            "commands": commands,
        },
    })
}

/// The proposal re-derived with only `keep` items under a fresh proposal and
/// group id, as the UI lifecycle does for a partial approval.
fn subset(proposal: &Value, keep: &[&str], seed: u64) -> Value {
    let mut approved = proposal.clone();
    let items: Vec<Value> = proposal["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| keep.contains(&item["itemId"].as_str().unwrap()))
        .cloned()
        .collect();
    let clip_ids: Vec<&Value> = items.iter().map(|item| &item["graphicsClipId"]).collect();
    let commands: Vec<Value> = proposal["commandGroup"]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|command| {
            command["type"] == "InsertTrack" || clip_ids.contains(&&command["graphicsClip"]["id"])
        })
        .cloned()
        .collect();
    approved["proposalId"] = json!(pid(seed));
    approved["commandGroup"]["groupId"] = json!(pid(seed + 1));
    approved["items"] = json!(items);
    approved["commandGroup"]["commands"] = json!(commands);
    approved
}

fn category(result: Result<impl std::fmt::Debug, VideoCommandError>) -> String {
    result.unwrap_err().details["category"]
        .as_str()
        .unwrap()
        .to_owned()
}

type Mutation = Box<dyn Fn(&mut Value)>;

#[test]
fn graphics_proposal_passes_native_validation() {
    let snapshot = fixture();
    let view = validate_proposal(&graphics_proposal(&snapshot, 100), &snapshot).unwrap();
    assert!(view.is_graphics());
    let ProposalBody::Graphics { items } = &view.body else {
        panic!("expected a graphics body");
    };
    assert_eq!(items.len(), 3);
    assert_eq!(view.producer.id, "recipe-graphics");
}

#[test]
fn graphics_validation_enforces_the_add_only_policy() {
    let snapshot = fixture();
    let first_add = 1;
    let cases: Vec<(&str, Mutation)> = vec![
        (
            "proposal_schema_version",
            Box::new(|v| v["schemaVersion"] = json!(2)),
        ),
        (
            "proposal_schema",
            Box::new(|v| v["proposalKind"] = json!("transcript")),
        ),
        ("proposal_schema", Box::new(|v| v["extra"] = json!(true))),
        ("proposal_ids", Box::new(|v| v["trackId"] = json!("nope"))),
        (
            "proposal_producer",
            Box::new(|v| v["producer"]["id"] = json!("Bad Id")),
        ),
        (
            "proposal_project",
            Box::new(|v| v["projectId"] = json!(pid(999))),
        ),
        (
            "proposal_base_revision",
            Box::new(|v| v["commandGroup"]["baseRevision"] = json!(4)),
        ),
        ("proposal_empty", Box::new(|v| v["items"] = json!([]))),
        (
            "proposal_items",
            Box::new(|v| v["items"][1]["itemId"] = json!("title")),
        ),
        (
            "proposal_items",
            Box::new(|v| v["items"][0]["graphicsClipId"] = json!(pid(555))),
        ),
        (
            "proposal_items",
            Box::new(|v| {
                v["items"].as_array_mut().unwrap().pop();
            }),
        ),
        (
            "proposal_items",
            Box::new(|v| {
                v["commandGroup"]["commands"].as_array_mut().unwrap().pop();
            }),
        ),
        (
            "proposal_command_scope",
            Box::new(move |v| v["commandGroup"]["commands"][first_add]["trackId"] = json!(pid(7))),
        ),
        (
            "proposal_command_policy",
            Box::new(move |v| {
                v["commandGroup"]["commands"][first_add + 1] = json!({
                    "type": "RemoveGraphicsClip",
                    "commandId": pid(160),
                    "sequenceId": v["sequenceId"],
                    "trackId": v["trackId"],
                    "graphicsClipId": pid(131),
                });
            }),
        ),
        (
            "proposal_command_policy",
            Box::new(move |v| {
                v["commandGroup"]["commands"][first_add + 1] = json!({
                    "type": "SetGraphicsClipLayers",
                    "commandId": pid(160),
                    "sequenceId": v["sequenceId"],
                    "trackId": v["trackId"],
                    "graphicsClipId": pid(131),
                    "fontKey": "segoe-ui-bold",
                    "layers": clip(131, 40)["layers"],
                });
            }),
        ),
        (
            "proposal_command_policy",
            Box::new(|v| {
                let ripple = json!({
                    "type": "RippleDeleteClip",
                    "commandId": pid(161),
                    "sequenceId": v["sequenceId"],
                    "trackId": pid(1),
                    "clipId": pid(2),
                });
                v["commandGroup"]["commands"]
                    .as_array_mut()
                    .unwrap()
                    .push(ripple);
            }),
        ),
        (
            "proposal_insert_track",
            Box::new(|v| {
                let id = v["trackId"].clone();
                v["commandGroup"]["commands"][0]["track"] =
                    json!({"kind": "video", "id": id, "name": "Graphics", "clips": []});
            }),
        ),
        (
            "proposal_insert_track",
            Box::new(|v| v["commandGroup"]["commands"][0]["track"]["locked"] = json!(true)),
        ),
        (
            "proposal_insert_track",
            Box::new(|v| {
                v["commandGroup"]["commands"][0]["track"]["graphicsClips"] = json!([clip(170, 0)])
            }),
        ),
        (
            "proposal_insert_track",
            Box::new(|v| v["commandGroup"]["commands"][0]["track"]["id"] = json!(pid(171))),
        ),
        (
            "proposal_track",
            Box::new(|v| {
                v["commandGroup"]["commands"]
                    .as_array_mut()
                    .unwrap()
                    .remove(0);
            }),
        ),
    ];
    for (expected, mutate) in cases {
        let mut value = graphics_proposal(&snapshot, 100);
        mutate(&mut value);
        assert_eq!(
            category(validate_proposal(&value, &snapshot)),
            expected,
            "mutation for {expected}: {}",
            value["commandGroup"]["commands"]
        );
    }
}

#[test]
fn an_oversized_graphics_command_group_reports_its_byte_limit() {
    let snapshot = fixture();
    let mut value = graphics_proposal(&snapshot, 100);
    value["commandGroup"]["commands"][1]["graphicsClip"]["layers"][0]["text"] =
        json!("a".repeat(MAX_COMMAND_GROUP_BYTES));
    let proposal_bytes = canonical_bytes(&value).unwrap().len();
    assert!(proposal_bytes <= MAX_PROPOSAL_BYTES, "{proposal_bytes}");
    assert_eq!(
        category(validate_proposal(&value, &snapshot)),
        "proposal_command_group_bytes"
    );
}

/// The snapshot with the proposal's graphics track already present.
fn with_graphics_track(snapshot: &VideoProjectSnapshotV2, locked: bool) -> VideoProjectSnapshotV2 {
    let mut next = snapshot.clone();
    next.state.sequences[0].tracks.insert(
        0,
        ProjectTrack::Graphics {
            id: pid(TRACK_SEED),
            name: "Graphics".to_owned(),
            locked,
            hidden: false,
            graphics_clips: Vec::new(),
        },
    );
    next
}

fn without_insert(mut proposal: Value) -> Value {
    proposal["commandGroup"]["commands"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    proposal
}

#[test]
fn graphics_validation_targets_an_existing_unlocked_graphics_track() {
    let snapshot = fixture();
    let open = with_graphics_track(&snapshot, false);
    validate_proposal(&without_insert(graphics_proposal(&open, 100)), &open).unwrap();
    // Inserting a track that already exists is refused.
    assert_eq!(
        category(validate_proposal(&graphics_proposal(&open, 100), &open)),
        "proposal_track"
    );
    let locked = with_graphics_track(&snapshot, true);
    assert_eq!(
        category(validate_proposal(
            &without_insert(graphics_proposal(&locked, 100)),
            &locked
        )),
        "proposal_track_locked"
    );
    // Export skips hidden tracks, so a hidden target is refused.
    let mut hidden = with_graphics_track(&snapshot, false);
    hidden.state.sequences[0].tracks[0]
        .set_hidden(true)
        .unwrap();
    assert_eq!(
        category(validate_proposal(
            &without_insert(graphics_proposal(&hidden, 100)),
            &hidden
        )),
        "proposal_track_hidden"
    );
    // A non-graphics track is not a graphics target.
    let mut video = without_insert(graphics_proposal(&snapshot, 100));
    let video_track = snapshot.state.sequences[0].tracks[0].id().to_owned();
    video["trackId"] = json!(video_track);
    for command in video["commandGroup"]["commands"].as_array_mut().unwrap() {
        command["trackId"] = json!(video_track);
    }
    assert_eq!(
        category(validate_proposal(&video, &snapshot)),
        "proposal_track"
    );
}

fn submitted(service: &VideoProjectService, project: &OpenProject, seed: u64) -> Value {
    let proposal = graphics_proposal(&project.original, seed);
    let stored = service
        .submit_proposal(OWNER, &project.original.id, &proposal, NOW_MS, 60_000)
        .unwrap();
    assert_eq!(stored.status, NativeProposalStatus::Pending);
    proposal
}

#[test]
fn submitting_a_graphics_proposal_changes_nothing_until_approved() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    submitted(&service, &project, 100);
    let inspector = service.inspector(OWNER, &snapshot.id).unwrap();
    assert_eq!(inspector.revision, snapshot.revision);
    assert_eq!(read_snapshot(&project.path).unwrap().state, snapshot.state);
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 1)
        .unwrap();
    assert_eq!(listing.proposals.len(), 1);
    assert_eq!(listing.proposals[0].status, NativeProposalStatus::Pending);
}

fn graphics_track(state: &super::types::VideoProjectStateV2) -> Option<&ProjectTrack> {
    state.sequences[0]
        .tracks
        .iter()
        .find(|track| track.id() == pid(TRACK_SEED))
}

fn clip_ids(track: Option<&ProjectTrack>) -> Vec<String> {
    match track {
        Some(ProjectTrack::Graphics { graphics_clips, .. }) => {
            graphics_clips.iter().map(|clip| clip.id.clone()).collect()
        }
        _ => Vec::new(),
    }
}

#[test]
fn partial_apply_adds_only_the_accepted_items_with_an_audit() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = submitted(&service, &project, 100);
    let approved = subset(&proposal, &["title", "end-card"], 200);
    let result = service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &approved,
            NOW_MS + 1,
            &project.grants,
        )
        .unwrap();
    assert_eq!(result.new_revision.number, snapshot.revision.number + 1);
    assert_eq!(
        clip_ids(graphics_track(&result.projection.state)),
        vec![pid(130), pid(132)]
    );
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 2)
        .unwrap();
    let entry = &listing.proposals[0];
    assert_eq!(entry.status, NativeProposalStatus::Applied);
    assert_eq!(entry.approved_range_ids, vec!["end-card", "title"]);
    let audit = listing.audit.last().unwrap();
    assert_eq!(audit.action, ProposalAuditAction::Applied);
    assert_eq!(
        audit.applied_proposal_id.as_deref(),
        Some(pid(200).as_str())
    );
    assert_eq!(audit.affected_ranges.len(), 2);
    assert_eq!(audit.affected_ranges[1].start.value, 80);
    assert_eq!(audit.affected_ranges[1].end.value, 100);
    assert!(result
        .projection
        .last_command
        .as_ref()
        .unwrap()
        .summary
        .contains("recipe-graphics"));
}

#[test]
fn apply_refuses_anything_the_stored_proposal_did_not_offer() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = submitted(&service, &project, 100);
    let cases: Vec<(&str, Mutation)> = vec![
        (
            "proposal_item_not_offered",
            // Same clip id, different text: not byte-equal.
            Box::new(|v| {
                v["commandGroup"]["commands"][1]["graphicsClip"]["layers"][0]["text"] =
                    json!("Buy now")
            }),
        ),
        (
            "proposal_item_not_offered",
            Box::new(|v| v["items"][0]["label"] = json!("Something else")),
        ),
        (
            "proposal_item_not_offered",
            Box::new(|v| v["commandGroup"]["commands"][0]["track"]["name"] = json!("Mine")),
        ),
        (
            "proposal_mismatch",
            Box::new(|v| v["producer"]["version"] = json!("2")),
        ),
    ];
    for (expected, mutate) in cases {
        let mut approved = subset(&proposal, &["title", "lower", "end-card"], 300);
        mutate(&mut approved);
        assert_eq!(
            category(service.apply_proposal(
                OWNER,
                &snapshot.id,
                &pid(100),
                &approved,
                NOW_MS + 1,
                &project.grants
            )),
            expected
        );
    }
    // Nothing was applied by any of the attempts.
    let inspector = service.inspector(OWNER, &snapshot.id).unwrap();
    assert_eq!(inspector.revision, snapshot.revision);
    // A graphics approval for a transcript proposal id is refused too.
    let transcript = super::proposal_tests::sample_proposal(snapshot, 400);
    service
        .submit_proposal(OWNER, &snapshot.id, &transcript, NOW_MS, 60_000)
        .unwrap();
    let mut cross = subset(&proposal, &["title"], 410);
    cross["producer"] = transcript["producer"].clone();
    cross["trackId"] = transcript["trackId"].clone();
    assert!(service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(400),
            &cross,
            NOW_MS + 1,
            &project.grants
        )
        .is_err());
}

#[test]
fn rejecting_a_graphics_proposal_leaves_the_project_untouched() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = submitted(&service, &project, 100);
    let rejected = service
        .reject_proposal(OWNER, &snapshot.id, &pid(100), NOW_MS + 1)
        .unwrap();
    assert_eq!(rejected.status, NativeProposalStatus::Rejected);
    assert_eq!(
        service.inspector(OWNER, &snapshot.id).unwrap().revision,
        snapshot.revision
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
        "proposal_not_open"
    );
}

#[test]
fn restore_before_a_graphics_proposal_removes_its_clips() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = submitted(&service, &project, 100);
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
    let restored = results.last().unwrap();
    assert_eq!(restored.projection.state, snapshot.state);
    assert!(graphics_track(&restored.projection.state).is_none());
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 3)
        .unwrap();
    assert_eq!(listing.proposals[0].status, NativeProposalStatus::Restored);
}

#[test]
fn a_graphics_proposal_goes_stale_once_the_project_moves_on() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = submitted(&service, &project, 100);
    // Another graphics proposal applied first moves the revision on.
    let mut other = graphics_proposal(snapshot, 500);
    other["trackId"] = json!(pid(901));
    other["commandGroup"]["commands"][0]["track"]["id"] = json!(pid(901));
    for command in other["commandGroup"]["commands"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .skip(1)
    {
        command["trackId"] = json!(pid(901));
    }
    service
        .submit_proposal(OWNER, &snapshot.id, &other, NOW_MS, 60_000)
        .unwrap();
    service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(500),
            &other,
            NOW_MS + 1,
            &project.grants,
        )
        .unwrap();
    // The original proposal is still at the old base: applying it as-is is stale.
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
    let stale = service
        .mark_proposal_stale(
            OWNER,
            &snapshot.id,
            &pid(100),
            "Project changed",
            NOW_MS + 3,
        )
        .unwrap();
    assert_eq!(stale.status, NativeProposalStatus::Stale);
}

#[test]
fn a_pending_graphics_proposal_survives_a_restart_and_can_be_applied() {
    let service = VideoProjectService::default();
    let project = open_project(&service);
    let snapshot = &project.original;
    let proposal = submitted(&service, &project, 100);
    drop(service);
    let service = VideoProjectService::default();
    service.open(OWNER, &project.path, &project.grants).unwrap();
    let listing = service
        .list_proposals(OWNER, &snapshot.id, NOW_MS + 1)
        .unwrap();
    // Floats reload as JSON numbers (1.0 → 1); the canonical form is unchanged.
    assert_eq!(
        canonical_bytes(&listing.proposals[0].proposal).unwrap(),
        canonical_bytes(&proposal).unwrap()
    );
    assert!(!listing.store_discarded);
    let approved = subset(&proposal, &["lower"], 600);
    let result = service
        .apply_proposal(
            OWNER,
            &snapshot.id,
            &pid(100),
            &approved,
            NOW_MS + 2,
            &project.grants,
        )
        .unwrap();
    assert_eq!(
        clip_ids(graphics_track(&result.projection.state)),
        vec![pid(131)]
    );
}
