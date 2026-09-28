use super::{
    clip_timing::ClipSpeed,
    hash::{canonical_bytes, state_hash},
    journal::journal_path,
    service::VideoProjectService,
    speed_edit_tests::{fixture, request, set},
    types::{ClipFades, ProjectCommand, VideoProjectSnapshotV2},
};
use crate::video::VideoPathGrants;
use std::fs;
use tempfile::tempdir;

fn fades(snapshot: &VideoProjectSnapshotV2, incoming: u64, outgoing: u64) -> ProjectCommand {
    ProjectCommand::SetClipFades {
        command_id: "70000000-0000-4000-8000-000000000001".into(),
        sequence_id: snapshot.state.sequences[0].id.clone(),
        track_id: snapshot.state.sequences[0].tracks[0].id().into(),
        clip_id: snapshot.state.sequences[0].tracks[0].clips().unwrap()[0]
            .id
            .clone(),
        fades: ClipFades {
            in_frames: incoming,
            out_frames: outgoing,
        },
    }
}

#[test]
fn audio_fades_journal_retry_undo_reset_preserve_exact_representation() {
    for previous in [
        None,
        Some(ClipFades {
            in_frames: 0,
            out_frames: 0,
        }),
        Some(ClipFades {
            in_frames: 10,
            out_frames: 20,
        }),
    ] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("audio.svpvideo");
        let grants = VideoPathGrants::default();
        let mut original = fixture();
        original.state.sequences[0].tracks[0].clips_mut().unwrap()[0].fades = previous;
        original.revision.state_hash = state_hash(&original.state).unwrap();
        fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
        let gain = ProjectCommand::SetClipGain {
            command_id: "70000000-0000-4000-8000-000000000005".into(),
            sequence_id: original.state.sequences[0].id.clone(),
            track_id: original.state.sequences[0].tracks[0].id().into(),
            clip_id: original.state.sequences[0].tracks[0].clips().unwrap()[0]
                .id
                .clone(),
            gain_milli_decibels: -6000,
        };
        let edit = request(&original, 910, vec![gain, fades(&original, 100, 100)]);
        let result = {
            let service = VideoProjectService::default();
            service.open("audio", &path, &grants).unwrap();
            service.execute("audio", edit.clone(), &grants).unwrap()
        }; // Journal-only close, not an explicit checkpoint.
        let reopened = VideoProjectService::default();
        let recovered = reopened.open("audio", &path, &grants).unwrap();
        assert_eq!(recovered.projection.state, result.projection.state);
        assert_eq!(reopened.execute("audio", edit, &grants).unwrap(), result);
        let journal_before = fs::read(journal_path(&path).unwrap()).unwrap();
        let mut invalid = request(
            &original,
            920,
            vec![set(
                &original,
                ClipSpeed {
                    numerator: 2,
                    denominator: 1,
                },
                921,
            )],
        );
        invalid.base_revision = 1;
        assert!(reopened.execute("audio", invalid, &grants).is_err());
        assert_eq!(
            fs::read(journal_path(&path).unwrap()).unwrap(),
            journal_before
        );
        assert_eq!(
            reopened
                .undo(
                    "audio",
                    &original.id,
                    1,
                    "70000000-0000-4000-8000-000000000002",
                    &grants
                )
                .unwrap()
                .projection
                .state,
            original.state
        );
        let redone = reopened
            .redo(
                "audio",
                &original.id,
                2,
                "70000000-0000-4000-8000-000000000003",
                &grants,
            )
            .unwrap();
        assert_eq!(redone.projection.state, result.projection.state);
        let mut reset = request(&original, 930, vec![fades(&original, 0, 0)]);
        reset.base_revision = 3;
        let reset_result = reopened.execute("audio", reset, &grants).unwrap();
        assert!(reset_result.projection.state.sequences[0].tracks[0]
            .clips()
            .unwrap()[0]
            .fades
            .is_none());
        assert_eq!(
            reopened
                .undo(
                    "audio",
                    &original.id,
                    4,
                    "70000000-0000-4000-8000-000000000004",
                    &grants
                )
                .unwrap()
                .projection
                .state,
            result.projection.state
        );
        reopened.close("audio", &original.id).unwrap();
    }
}

#[test]
fn audio_fades_reject_public_inverse_and_invalid_envelopes_without_mutation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("audio.svpvideo");
    let original = fixture();
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
    let grants = VideoPathGrants::default();
    let service = VideoProjectService::default();
    service.open("audio", &path, &grants).unwrap();
    for (incoming, outgoing) in [(301, 0), (151, 150), (u64::MAX, 1)] {
        assert!(service
            .execute(
                "audio",
                request(&original, 940, vec![fades(&original, incoming, outgoing)]),
                &grants
            )
            .is_err());
    }
    let mut inverse = serde_json::to_value(fades(&original, 0, 0)).unwrap();
    inverse["type"] = serde_json::json!("RestoreClipFades");
    inverse["fades"] = serde_json::Value::Null;
    let inverse: ProjectCommand = serde_json::from_value(inverse).unwrap();
    assert!(service
        .execute("audio", request(&original, 950, vec![inverse]), &grants)
        .is_err());
    let applied = service
        .execute(
            "audio",
            request(&original, 960, vec![fades(&original, 5, 5)]),
            &grants,
        )
        .unwrap();
    assert_eq!(applied.new_revision.number, 1);
    service.close("audio", &original.id).unwrap();
}

fn role(snapshot: &VideoProjectSnapshotV2, role: super::types::TrackAudioRole) -> ProjectCommand {
    ProjectCommand::SetTrackAudioRole {
        command_id: "71000000-0000-4000-8000-000000000001".into(),
        sequence_id: snapshot.state.sequences[0].id.clone(),
        track_id: snapshot.state.sequences[0].tracks[0].id().into(),
        role: Some(role),
    }
}

fn loudness(snapshot: &VideoProjectSnapshotV2, lufs: i64) -> ProjectCommand {
    ProjectCommand::SetSequenceLoudnessTarget {
        command_id: "71000000-0000-4000-8000-000000000002".into(),
        sequence_id: snapshot.state.sequences[0].id.clone(),
        target: Some(super::types::SequenceLoudnessTarget {
            integrated_lufs: lufs,
            true_peak_ceiling_dbtp: -1,
            ducking: true,
            dialogue_cleanup: true,
        }),
    }
}

#[test]
fn audio_role_and_loudness_target_persist_undo_redo_and_recover_from_journal() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("mix.svpvideo");
    let grants = VideoPathGrants::default();
    let original = fixture();
    // Legacy state serializes without the new optional fields, so hashes are unchanged.
    let legacy = String::from_utf8(canonical_bytes(&original).unwrap()).unwrap();
    assert!(!legacy.contains("audioRole") && !legacy.contains("loudnessTarget"));
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();

    let edit = request(
        &original,
        970,
        vec![
            role(&original, super::types::TrackAudioRole::Dialogue),
            loudness(&original, -16),
        ],
    );
    let result = {
        let service = VideoProjectService::default();
        service.open("mix", &path, &grants).unwrap();
        service.execute("mix", edit.clone(), &grants).unwrap()
    }; // Journal-only close.
    let applied = serde_json::to_value(&result.projection.state).unwrap();
    assert_eq!(
        applied["sequences"][0]["tracks"][0]["audioRole"],
        "dialogue"
    );
    assert_eq!(
        applied["sequences"][0]["loudnessTarget"]["integratedLufs"],
        -16
    );

    let reopened = VideoProjectService::default();
    let recovered = reopened.open("mix", &path, &grants).unwrap();
    assert_eq!(recovered.projection.state, result.projection.state);
    let undone = reopened
        .undo(
            "mix",
            &original.id,
            1,
            "71000000-0000-4000-8000-000000000003",
            &grants,
        )
        .unwrap();
    assert_eq!(
        undone.projection.state, original.state,
        "one undo clears both fields"
    );
    assert_eq!(undone.state_hash, original.revision.state_hash);
    let redone = reopened
        .redo(
            "mix",
            &original.id,
            2,
            "71000000-0000-4000-8000-000000000004",
            &grants,
        )
        .unwrap();
    assert_eq!(redone.projection.state, result.projection.state);
    reopened.close("mix", &original.id).unwrap();

    let checkpointed = VideoProjectService::default();
    let reopened = checkpointed.open("mix", &path, &grants).unwrap();
    assert_eq!(reopened.projection.state, result.projection.state);
    checkpointed.close("mix", &original.id).unwrap();
}

#[test]
fn audio_mix_commands_reject_invalid_targets_and_public_inverses_without_mutation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("mix.svpvideo");
    let original = fixture();
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
    let grants = VideoPathGrants::default();
    let service = VideoProjectService::default();
    service.open("mix", &path, &grants).unwrap();
    for lufs in [-15, 0, -24] {
        assert!(service
            .execute(
                "mix",
                request(&original, 980, vec![loudness(&original, lufs)]),
                &grants
            )
            .is_err());
    }
    let mut bad_peak = serde_json::to_value(loudness(&original, -14)).unwrap();
    bad_peak["target"]["truePeakCeilingDbtp"] = serde_json::json!(0);
    let bad_peak: ProjectCommand = serde_json::from_value(bad_peak).unwrap();
    assert!(service
        .execute("mix", request(&original, 981, vec![bad_peak]), &grants)
        .is_err());
    for inverse in [
        serde_json::json!({
            "type": "RestoreTrackAudioRole",
            "commandId": "71000000-0000-4000-8000-000000000010",
            "sequenceId": original.state.sequences[0].id,
            "trackId": original.state.sequences[0].tracks[0].id(),
            "role": null,
        }),
        serde_json::json!({
            "type": "RestoreSequenceLoudnessTarget",
            "commandId": "71000000-0000-4000-8000-000000000011",
            "sequenceId": original.state.sequences[0].id,
            "target": null,
        }),
    ] {
        let inverse: ProjectCommand = serde_json::from_value(inverse).unwrap();
        assert!(service
            .execute("mix", request(&original, 982, vec![inverse]), &grants)
            .is_err());
    }
    let applied = service
        .execute(
            "mix",
            request(
                &original,
                983,
                vec![role(&original, super::types::TrackAudioRole::Music)],
            ),
            &grants,
        )
        .unwrap();
    assert_eq!(
        applied.new_revision.number, 1,
        "rejections never advanced the revision"
    );
    service.close("mix", &original.id).unwrap();
}

#[test]
fn audio_mix_public_null_clears_to_legacy_state_and_undo_restores_values() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("mix.svpvideo");
    let grants = VideoPathGrants::default();
    let original = fixture();
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
    let service = VideoProjectService::default();
    service.open("mix", &path, &grants).unwrap();
    let set = service
        .execute(
            "mix",
            request(
                &original,
                990,
                vec![
                    role(&original, super::types::TrackAudioRole::Dialogue),
                    loudness(&original, -16),
                ],
            ),
            &grants,
        )
        .unwrap();

    let sequence_id = original.state.sequences[0].id.clone();
    let track_id = original.state.sequences[0].tracks[0].id().to_owned();
    let clear: Vec<ProjectCommand> = [
        serde_json::json!({
            "type": "SetTrackAudioRole",
            "commandId": "71000000-0000-4000-8000-000000000020",
            "sequenceId": sequence_id,
            "trackId": track_id,
            "role": null,
        }),
        serde_json::json!({
            "type": "SetSequenceLoudnessTarget",
            "commandId": "71000000-0000-4000-8000-000000000021",
            "sequenceId": sequence_id,
            "target": null,
        }),
    ]
    .into_iter()
    .map(|value| serde_json::from_value(value).unwrap())
    .collect();
    let mut clear_request = request(&original, 991, clear);
    clear_request.base_revision = 1;
    let cleared = service.execute("mix", clear_request, &grants).unwrap();
    assert_eq!(cleared.projection.state, original.state);
    let bytes = String::from_utf8(canonical_bytes(&cleared.projection.state).unwrap()).unwrap();
    assert!(!bytes.contains("loudnessTarget") && !bytes.contains("audioRole"));

    let undone = service
        .undo(
            "mix",
            &original.id,
            2,
            "71000000-0000-4000-8000-000000000022",
            &grants,
        )
        .unwrap();
    assert_eq!(undone.projection.state, set.projection.state);
    service.close("mix", &original.id).unwrap();
}

#[test]
fn audio_mix_public_set_commands_require_the_value_field_to_be_present() {
    let original = fixture();
    for missing in [
        serde_json::json!({
            "type": "SetTrackAudioRole",
            "commandId": "71000000-0000-4000-8000-000000000030",
            "sequenceId": original.state.sequences[0].id,
            "trackId": original.state.sequences[0].tracks[0].id(),
        }),
        serde_json::json!({
            "type": "SetSequenceLoudnessTarget",
            "commandId": "71000000-0000-4000-8000-000000000031",
            "sequenceId": original.state.sequences[0].id,
        }),
    ] {
        assert!(serde_json::from_value::<ProjectCommand>(missing).is_err());
    }
}

fn frame_size(snapshot: &VideoProjectSnapshotV2, width: u64, height: u64) -> ProjectCommand {
    ProjectCommand::SetSequenceFrameSize {
        command_id: "71000000-0000-4000-8000-000000000020".into(),
        sequence_id: snapshot.state.sequences[0].id.clone(),
        width,
        height,
    }
}

#[test]
fn sequence_frame_size_persists_undoes_and_recovers_from_journal() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("frame.svpvideo");
    let grants = VideoPathGrants::default();
    let original = fixture();
    let (width, height) = (
        original.state.sequences[0].width,
        original.state.sequences[0].height,
    );
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();

    let result = {
        let service = VideoProjectService::default();
        service.open("frame", &path, &grants).unwrap();
        // 9:16 vertical at the same height class.
        service
            .execute(
                "frame",
                request(&original, 990, vec![frame_size(&original, 1_080, 1_920)]),
                &grants,
            )
            .unwrap()
    }; // Journal-only close.
    let sequence = &result.projection.state.sequences[0];
    assert_eq!((sequence.width, sequence.height), (1_080, 1_920));
    assert_eq!(
        sequence.tracks, original.state.sequences[0].tracks,
        "clips are untouched"
    );

    let reopened = VideoProjectService::default();
    let recovered = reopened.open("frame", &path, &grants).unwrap();
    assert_eq!(recovered.projection.state, result.projection.state);
    let undone = reopened
        .undo(
            "frame",
            &original.id,
            1,
            "71000000-0000-4000-8000-000000000021",
            &grants,
        )
        .unwrap();
    let sequence = &undone.projection.state.sequences[0];
    assert_eq!((sequence.width, sequence.height), (width, height));
    assert_eq!(undone.state_hash, original.revision.state_hash);
    reopened.close("frame", &original.id).unwrap();
}

#[test]
fn sequence_frame_size_rejects_odd_zero_and_oversized_frames() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("frame.svpvideo");
    let original = fixture();
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
    let grants = VideoPathGrants::default();
    let service = VideoProjectService::default();
    service.open("frame", &path, &grants).unwrap();
    for (width, height) in [(1_081, 1_920), (1_080, 0), (0, 0), (16_386, 1_080)] {
        assert!(
            service
                .execute(
                    "frame",
                    request(&original, 991, vec![frame_size(&original, width, height)]),
                    &grants,
                )
                .is_err(),
            "{width}x{height} must be rejected"
        );
    }
    let applied = service
        .execute(
            "frame",
            request(&original, 992, vec![frame_size(&original, 1_080, 1_080)]),
            &grants,
        )
        .unwrap();
    assert_eq!(
        applied.new_revision.number, 1,
        "rejections never advanced the revision"
    );
    service.close("frame", &original.id).unwrap();
}
