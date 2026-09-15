use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tempfile::{tempdir, TempDir};

use super::{
    clip_timing::ClipSpeed,
    commands::apply_group,
    hash::{canonical_bytes, state_hash},
    history::{commit_transition, redo_transition, undo_transition},
    integrity::{validate_snapshot, validate_state},
    service::VideoProjectService,
    types::{
        CacheInvalidation, CommandGroupRequest, ProjectClip, ProjectCommand, ProjectTrack,
        VideoProjectSnapshotV2,
    },
};
use crate::video::{caption::CaptionArtifactV1, VideoPathGrants};

const OWNER: &str = "speed-test";
const NOW: &str = "2026-09-14T09:00:00.000Z";
fn id(value: u64) -> String {
    format!("80000000-0000-4000-8000-{value:012x}")
}
fn time(value: u64) -> Value {
    json!({"value":value,"rateNumerator":30,"rateDenominator":1})
}
fn speed(numerator: u64, denominator: u64) -> ClipSpeed {
    ClipSpeed {
        numerator,
        denominator,
    }
}
fn clip(snapshot: &VideoProjectSnapshotV2) -> &ProjectClip {
    &snapshot.state.sequences[0].tracks[0].clips().unwrap()[0]
}
fn clip_mut(snapshot: &mut VideoProjectSnapshotV2) -> &mut ProjectClip {
    let ProjectTrack::Video { clips, .. } = &mut snapshot.state.sequences[0].tracks[0] else {
        panic!("video fixture");
    };
    &mut clips[0]
}
pub(super) fn fixture() -> VideoProjectSnapshotV2 {
    let mut value: Value = serde_json::from_str(include_str!("../../../../../../packages/video-contracts/fixtures/project-v2/valid-relative-source.svpvideo")).unwrap();
    value["state"]["assets"][0]["probe"]["durationMicroseconds"] = json!(12_000_000);
    let target = &mut value["state"]["sequences"][0]["tracks"][0]["clips"][0];
    target["timelineStart"] = time(10);
    target["sourceIn"] = time(30);
    target["sourceOut"] = time(330);
    target["transform"]["opacityPermille"] = json!(500);
    target["gainMilliDecibels"] = json!(-3000);
    let mut later = target.clone();
    later["id"] = json!(id(20));
    later["timelineStart"] = time(700);
    let mut cross = target.clone();
    cross["id"] = json!(id(21));
    cross["timelineStart"] = time(12);
    let sequence = &mut value["state"]["sequences"][0];
    sequence["tracks"][0]["muted"] = json!(true);
    sequence["tracks"][0]["hidden"] = json!(true);
    sequence["tracks"][0]["clips"]
        .as_array_mut()
        .unwrap()
        .push(later);
    sequence["tracks"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind":"video","id":id(22),"name":"Other layer","clips":[cross]}));
    sequence["tracks"].as_array_mut().unwrap().push(json!({"kind":"caption","id":id(23),"name":"Manual","captions":[{"id":id(24),"start":time(15),"end":time(45),"text":"Manual caption"}]}));
    sequence["markers"] = json!([{"id":id(25),"time":time(90),"label":"Fixed marker"}]);
    let mut snapshot: VideoProjectSnapshotV2 = serde_json::from_value(value).unwrap();
    refresh(&mut snapshot);
    snapshot
}
fn refresh(snapshot: &mut VideoProjectSnapshotV2) {
    snapshot.revision.state_hash = state_hash(&snapshot.state).unwrap();
    validate_snapshot(snapshot).unwrap();
}
pub(super) fn set(
    snapshot: &VideoProjectSnapshotV2,
    value: ClipSpeed,
    command_id: u64,
) -> ProjectCommand {
    ProjectCommand::SetClipSpeed {
        command_id: id(command_id),
        sequence_id: snapshot.state.sequences[0].id.clone(),
        track_id: snapshot.state.sequences[0].tracks[0].id().to_owned(),
        clip_id: clip(snapshot).id.clone(),
        speed: value,
    }
}
pub(super) fn request(
    snapshot: &VideoProjectSnapshotV2,
    group_id: u64,
    commands: Vec<ProjectCommand>,
) -> CommandGroupRequest {
    CommandGroupRequest {
        group_id: id(group_id),
        project_id: snapshot.id.clone(),
        base_revision: snapshot.revision.number,
        commands,
    }
}

#[test]
fn speed_edits_preserve_positions_and_restore_exact_hashes_through_history() {
    for (value, duration) in [
        (speed(1, 2), 600),
        (speed(1, 1), 300),
        (speed(3, 2), 200),
        (speed(2, 1), 150),
    ] {
        let original = fixture();
        let transition = commit_transition(
            &original,
            &request(&original, 100, vec![set(&original, value, 101)]),
            NOW,
        )
        .unwrap();
        let changed = &transition.snapshot;
        let mut expected = original.state.clone();
        let ProjectTrack::Video { clips, .. } = &mut expected.sequences[0].tracks[0] else {
            panic!("video");
        };
        clips[0].speed = (value != ClipSpeed::default()).then_some(value);
        assert_eq!(changed.state, expected); // All endpoints, starts, other tracks, markers and manual captions unchanged.
        assert_eq!(changed.revision.number, original.revision.number + 1);
        assert_eq!(changed.history.undo_stack.len(), 1);
        assert!(changed.history.redo_stack.is_empty());
        assert_eq!(transition.applied.affected_ranges.len(), 2);
        assert_eq!(transition.applied.affected_ranges[0].start.value, 10);
        assert_eq!(transition.applied.affected_ranges[0].end.value, 310);
        assert_eq!(
            transition.applied.affected_ranges[1].end.value,
            10 + duration
        );
        for invalidation in [
            CacheInvalidation::Timeline,
            CacheInvalidation::Preview,
            CacheInvalidation::AudioMix,
            CacheInvalidation::RenderPlan,
        ] {
            assert!(transition
                .applied
                .cache_invalidations
                .contains(&invalidation));
        }
        assert_eq!(transition.applied.summary, "Updated clip speed");
        let undo = undo_transition(changed, changed.revision.number, &id(102), NOW).unwrap();
        assert_eq!(undo.snapshot.state, original.state);
        assert_eq!(
            undo.snapshot.revision.state_hash,
            original.revision.state_hash
        );
        assert!(undo.snapshot.history.undo_stack.is_empty());
        assert_eq!(undo.snapshot.history.redo_stack.len(), 1);
        let redo =
            redo_transition(&undo.snapshot, undo.snapshot.revision.number, &id(103), NOW).unwrap();
        assert_eq!(redo.snapshot.state, changed.state);
        assert_eq!(
            redo.snapshot.revision.state_hash,
            changed.revision.state_hash
        );
        let reset = commit_transition(
            changed,
            &request(changed, 104, vec![set(changed, speed(1, 1), 105)]),
            NOW,
        )
        .unwrap();
        assert_eq!(clip(&reset.snapshot).speed, None);
        assert_eq!(
            reset.snapshot.revision.state_hash,
            original.revision.state_hash
        );
    }
}

#[test]
fn exact_retimed_adjacency_and_source_edits_round_trip() {
    let mut base = fixture();
    if let ProjectTrack::Video { clips, .. } = &mut base.state.sequences[0].tracks[0] {
        clips[1].timeline_start.value = 610;
    }
    refresh(&mut base);
    let next = apply_group(&base.state, &[set(&base, speed(1, 2), 120)]).unwrap();
    assert_eq!(next.affected_ranges[1].end.value, 610);
    let target = clip(&base);
    for command in [
        ProjectCommand::TrimClip {
            command_id: id(121),
            sequence_id: base.state.sequences[0].id.clone(),
            track_id: base.state.sequences[0].tracks[0].id().to_owned(),
            clip_id: target.id.clone(),
            source_in: target.source_in.clone(),
            source_out: target.source_out.clone(),
        },
        ProjectCommand::SplitClip {
            command_id: id(122),
            sequence_id: base.state.sequences[0].id.clone(),
            track_id: base.state.sequences[0].tracks[0].id().to_owned(),
            clip_id: target.id.clone(),
            split_at: serde_json::from_value(time(100)).unwrap(),
            right_clip_id: id(123),
        },
    ] {
        let edited = apply_group(&next.state, &[command]).unwrap();
        assert_eq!(
            apply_group(&edited.state, &edited.inverse_commands)
                .unwrap()
                .state,
            next.state
        );
    }
}

#[test]
fn explicit_default_representation_and_nondefault_values_survive_inverse_history() {
    for previous in [None, Some(speed(1, 1)), Some(speed(3, 2))] {
        let mut original = fixture();
        clip_mut(&mut original).speed = previous;
        refresh(&mut original);
        let next = commit_transition(
            &original,
            &request(&original, 110, vec![set(&original, speed(2, 1), 111)]),
            NOW,
        )
        .unwrap();
        assert!(
            matches!(next.applied.inverse_commands.as_slice(),[ProjectCommand::RestoreClipSpeed { speed, .. }] if *speed == previous)
        );
        let undo =
            undo_transition(&next.snapshot, next.snapshot.revision.number, &id(112), NOW).unwrap();
        assert_eq!(
            undo.snapshot.revision.state_hash,
            original.revision.state_hash
        );
        assert_eq!(
            canonical_bytes(&undo.snapshot.state).unwrap(),
            canonical_bytes(&original.state).unwrap()
        );
        let reset = commit_transition(
            &original,
            &request(&original, 113, vec![set(&original, speed(1, 1), 114)]),
            NOW,
        )
        .unwrap();
        assert_eq!(clip(&reset.snapshot).speed, None);
        assert_eq!(
            undo_transition(
                &reset.snapshot,
                reset.snapshot.revision.number,
                &id(115),
                NOW
            )
            .unwrap()
            .snapshot
            .state,
            original.state
        );
    }
}

struct Session {
    service: VideoProjectService,
    grants: VideoPathGrants,
    original: VideoProjectSnapshotV2,
    path: PathBuf,
    _directory: TempDir,
}
impl Session {
    fn new(original: VideoProjectSnapshotV2) -> Self {
        let directory = tempdir().unwrap();
        let path = directory.path().join("speed.svpvideo");
        fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
        let service = VideoProjectService::default();
        let grants = VideoPathGrants::default();
        service.open(OWNER, &path, &grants).unwrap();
        Self {
            service,
            grants,
            original,
            path,
            _directory: directory,
        }
    }
    fn files(&self) -> (Vec<u8>, Vec<u8>) {
        // Compare the authoritative snapshot/journal, not the deliberately OS-locked process-lock file.
        (
            fs::read(&self.path).unwrap(),
            fs::read(super::journal::journal_path(&self.path).unwrap()).unwrap(),
        )
    }
    fn reject_unchanged(&self, request: CommandGroupRequest) {
        let before = self.service.inspector(OWNER, &self.original.id).unwrap();
        let bytes = self.files();
        assert!(self
            .service
            .execute(OWNER, request.clone(), &self.grants)
            .is_err());
        assert_eq!(
            self.service.inspector(OWNER, &self.original.id).unwrap(),
            before
        );
        assert_eq!(self.files(), bytes);
        assert!(self
            .service
            .existing_group_result(OWNER, &request)
            .unwrap()
            .is_none());
    }
}

#[test]
fn service_rejects_locked_overlap_invalid_inexact_stale_and_failed_groups_atomically() {
    for case in [
        "locked",
        "overlap",
        "inexact",
        "invalid",
        "overflow",
        "failed_group",
        "zero_range",
        "invalid_bounds",
        "stale",
    ] {
        let mut base = fixture();
        if case == "locked" {
            if let ProjectTrack::Video { locked, .. } = &mut base.state.sequences[0].tracks[0] {
                *locked = true;
            }
        }
        if case == "overlap" {
            if let ProjectTrack::Video { clips, .. } = &mut base.state.sequences[0].tracks[0] {
                clips[1].timeline_start.value = 400;
            }
        }
        if case == "overflow" {
            if let ProjectTrack::Video { clips, .. } = &mut base.state.sequences[0].tracks[0] {
                clips.truncate(1);
                clips[0].source_in.value = 0;
                clips[0].source_out.value = 2;
                clips[0].timeline_start.value = super::types::MAX_SAFE_INTEGER - 2;
            }
        }
        refresh(&mut base);
        let value = match case {
            "inexact" => speed(51, 100),
            "invalid" => speed(3, 1),
            _ => speed(1, 2),
        };
        let mut commands = vec![set(&base, value, 201)];
        if case == "failed_group" {
            commands.push(ProjectCommand::RemoveClip {
                command_id: id(202),
                sequence_id: base.state.sequences[0].id.clone(),
                track_id: base.state.sequences[0].tracks[0].id().to_owned(),
                clip_id: id(999),
            });
        }
        if case == "zero_range" || case == "invalid_bounds" {
            commands.insert(
                0,
                ProjectCommand::TrimClip {
                    command_id: id(203),
                    sequence_id: base.state.sequences[0].id.clone(),
                    track_id: base.state.sequences[0].tracks[0].id().to_owned(),
                    clip_id: clip(&base).id.clone(),
                    source_in: clip(&base).source_in.clone(),
                    source_out: serde_json::from_value(time(if case == "zero_range" {
                        30
                    } else {
                        400
                    }))
                    .unwrap(),
                },
            );
        }
        let mut request = request(&base, 200, commands);
        if case == "stale" {
            request.base_revision += 1;
        }
        let session = Session::new(base);
        session.reject_unchanged(request);
    }
}

#[test]
fn service_retries_and_undo_redo_keep_history_after_a_failed_transaction() {
    let base = fixture();
    let session = Session::new(base.clone());
    let request = request(&base, 300, vec![set(&base, speed(2, 1), 301)]);
    let changed = session
        .service
        .execute(OWNER, request.clone(), &session.grants)
        .unwrap();
    assert_eq!(
        session
            .service
            .execute(OWNER, request, &session.grants)
            .unwrap(),
        changed
    );
    let mut failed = request_for_projection(
        &base,
        changed.new_revision.number,
        302,
        vec![set(&base, speed(51, 100), 303)],
    );
    session.reject_unchanged(failed.clone());
    let undone = session
        .service
        .undo(
            OWNER,
            &base.id,
            changed.new_revision.number,
            &id(304),
            &session.grants,
        )
        .unwrap();
    assert_eq!(undone.new_revision.state_hash, base.revision.state_hash);
    assert!(!undone.projection.can_undo);
    assert!(undone.projection.can_redo);
    let redone = session
        .service
        .redo(
            OWNER,
            &base.id,
            undone.new_revision.number,
            &id(305),
            &session.grants,
        )
        .unwrap();
    assert_eq!(
        redone.new_revision.state_hash,
        changed.new_revision.state_hash
    );
    failed.base_revision = redone.new_revision.number;
    failed.commands = vec![set(&base, speed(1, 1), 306)];
    let reset = session
        .service
        .execute(OWNER, failed, &session.grants)
        .unwrap();
    assert_eq!(reset.new_revision.state_hash, base.revision.state_hash);
}
fn request_for_projection(
    base: &VideoProjectSnapshotV2,
    revision: u64,
    group: u64,
    commands: Vec<ProjectCommand>,
) -> CommandGroupRequest {
    let mut request = request(base, group, commands);
    request.base_revision = revision;
    request
}

#[test]
fn private_speed_inverse_is_required_nullable_strict_and_cannot_be_submitted_live() {
    let base = fixture();
    for value in [None, Some(speed(1, 1)), Some(speed(3, 2))] {
        let restore = ProjectCommand::RestoreClipSpeed {
            command_id: id(400),
            sequence_id: base.state.sequences[0].id.clone(),
            track_id: base.state.sequences[0].tracks[0].id().to_owned(),
            clip_id: clip(&base).id.clone(),
            speed: value,
        };
        let wire = serde_json::to_value(&restore).unwrap();
        assert_eq!(
            serde_json::from_value::<ProjectCommand>(wire.clone()).unwrap(),
            restore
        );
        assert!(commit_transition(&base, &request(&base, 401, vec![restore]), NOW).is_err());
        let mut missing = wire.clone();
        missing.as_object_mut().unwrap().remove("speed");
        assert!(serde_json::from_value::<ProjectCommand>(missing).is_err());
        let mut invalid = wire;
        invalid["speed"] = json!({"numerator":2,"denominator":2});
        assert!(serde_json::from_value::<ProjectCommand>(invalid).is_err());
    }
}

#[test]
fn nested_and_audio_speed_contexts_reject_commands_and_loaded_state() {
    let mut nested = fixture();
    let mut parent = nested.state.sequences[0].clone();
    parent.id = id(500);
    parent.tracks.truncate(1);
    parent.markers.clear();
    if let ProjectTrack::Video {
        id: track_id,
        clips,
        ..
    } = &mut parent.tracks[0]
    {
        *track_id = id(501);
        clips.truncate(1);
        clips[0].id = id(502);
        clips[0].source = super::types::ClipSource::Sequence {
            sequence_id: nested.state.sequences[0].id.clone(),
        };
        clips[0].source_in.value = 0;
        clips[0].source_out.value = 300;
    }
    nested.state.sequences.push(parent);
    refresh(&mut nested);
    Session::new(nested.clone()).reject_unchanged(request(
        &nested,
        510,
        vec![set(&nested, speed(2, 1), 503)],
    ));
    let parent = &nested.state.sequences[1];
    let nested_target = ProjectCommand::SetClipSpeed {
        command_id: id(511),
        sequence_id: parent.id.clone(),
        track_id: parent.tracks[0].id().to_owned(),
        clip_id: parent.tracks[0].clips().unwrap()[0].id.clone(),
        speed: speed(2, 1),
    };
    assert!(apply_group(&nested.state, &[nested_target]).is_err());
    clip_mut(&mut nested).speed = Some(speed(2, 1));
    assert!(validate_state(&nested.state).is_err());
    let mut audio = fixture();
    let mut wire = serde_json::to_value(&audio.state.sequences[0].tracks[0]).unwrap();
    wire["kind"] = json!("audio");
    wire.as_object_mut().unwrap().remove("hidden");
    audio.state.sequences[0].tracks[0] = serde_json::from_value(wire).unwrap();
    refresh(&mut audio);
    let target = audio.state.sequences[0].tracks[0].clips().unwrap()[0]
        .id
        .clone();
    let command = ProjectCommand::SetClipSpeed {
        command_id: id(504),
        sequence_id: audio.state.sequences[0].id.clone(),
        track_id: audio.state.sequences[0].tracks[0].id().to_owned(),
        clip_id: target,
        speed: speed(2, 1),
    };
    assert!(apply_group(&audio.state, &[command]).is_err());
    if let ProjectTrack::Audio { clips, .. } = &mut audio.state.sequences[0].tracks[0] {
        clips[0].speed = Some(speed(2, 1));
    }
    assert!(validate_state(&audio.state).is_err());
}

#[test]
fn caption_lineage_guards_reject_retiming_and_implicit_detachment() {
    let mut base = fixture();
    let mut artifact: CaptionArtifactV1 = serde_json::from_str(include_str!(
        "../../../../../../packages/video-media/fixtures/caption-artifact-v1.json"
    ))
    .unwrap();
    artifact.track_link.project_id = base.id.clone();
    artifact.track_link.project_revision = base.revision.clone();
    artifact.track_link.sequence_id = base.state.sequences[0].id.clone();
    artifact.track_link.caption_track_id = id(600);
    artifact.timeline_rate.numerator = 30;
    for cue in &mut artifact.cues {
        for time in [&mut cue.start, &mut cue.end] {
            time.value = time.value * 5 / 4;
            time.rate_numerator = 30;
        }
    }
    base.state.assets[0].content_identity = Some(artifact.source_identity.clone());
    base.state.sequences[0].tracks.push(
        serde_json::from_value(
            json!({"kind":"caption","id":id(600),"name":"Managed","captions":[]}),
        )
        .unwrap(),
    );
    let apply = ProjectCommand::ApplyCaptionArtifact {
        command_id: id(601),
        sequence_id: base.state.sequences[0].id.clone(),
        track_id: id(600),
        artifact: artifact.clone(),
    };
    base.state = apply_group(&base.state, &[apply]).unwrap().state;
    refresh(&mut base);
    Session::new(base.clone()).reject_unchanged(request(
        &base,
        610,
        vec![set(&base, speed(2, 1), 602)],
    ));
    let clear = ProjectCommand::RestoreActiveCaptionArtifact {
        command_id: id(603),
        sequence_id: base.state.sequences[0].id.clone(),
        track_id: id(600),
        artifact: None,
    };
    assert!(apply_group(&base.state, &[clear, set(&base, speed(2, 1), 604)]).is_err());
    clip_mut(&mut base).speed = Some(speed(2, 1));
    assert!(validate_state(&base.state).is_err());
    clip_mut(&mut base).speed = None;
    base.state.assets[0].content_identity = None;
    assert!(apply_group(&base.state, &[set(&base, speed(2, 1), 605)]).is_err());
    base.state.assets[0].content_identity = Some(artifact.source_identity);
    base.state.assets[0]
        .content_identity
        .as_mut()
        .unwrap()
        .digest = "42".repeat(32);
    let unrelated = apply_group(&base.state, &[set(&base, speed(2, 1), 606)]).unwrap();
    assert_eq!(
        unrelated.state.sequences[0].tracks[3],
        base.state.sequences[0].tracks[3]
    );
}
