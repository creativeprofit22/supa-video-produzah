use std::fs;
use tempfile::tempdir;

use super::{
    clip_timing::ClipSpeed,
    hash::{canonical_bytes, state_hash},
    journal::{journal_path, scan},
    service::VideoProjectService,
    snapshot::{read_snapshot, CheckpointFailpoint},
    speed_edit_tests::{fixture, request, set},
    types::{JournalHealth, ProjectClip, ProjectEvent, RecoveryStatus, VideoProjectStateV2},
};
use crate::video::VideoPathGrants;

const OWNER: &str = "speed-storage-test";
fn id(value: u64) -> String {
    format!("90000000-0000-4000-8000-{value:012x}")
}
fn speed(numerator: u64, denominator: u64) -> ClipSpeed {
    ClipSpeed {
        numerator,
        denominator,
    }
}
fn clip(state: &VideoProjectStateV2) -> &ProjectClip {
    &state.sequences[0].tracks[0].clips().unwrap()[0]
}

#[test]
fn speed_save_close_and_journal_reopen_preserve_history_hashes_and_exact_retry() {
    for close_mode in ["checkpoint", "close", "journal"] {
        for previous in [None, Some(speed(1, 1)), Some(speed(2, 1))] {
            let directory = tempdir().unwrap();
            let path = directory.path().join("speed.svpvideo");
            let grants = VideoPathGrants::default();
            let mut original = fixture();
            original.state.sequences[0].tracks[0].clips_mut().unwrap()[0].speed = previous;
            original.revision.state_hash = state_hash(&original.state).unwrap();
            fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
            let edit = request(&original, 700, vec![set(&original, speed(3, 2), 701)]);
            let (acknowledged, initial) = {
                let service = VideoProjectService::default();
                service.open(OWNER, &path, &grants).unwrap();
                let initial = read_snapshot(&path).unwrap();
                let result = service.execute(OWNER, edit.clone(), &grants).unwrap();
                match close_mode {
                    "close" => service.close(OWNER, &original.id).unwrap(),
                    _ => assert_eq!(read_snapshot(&path).unwrap(), initial),
                }
                (result, initial) // Drop without clean close in journal mode.
            };
            if close_mode == "checkpoint" {
                let recovered = super::recovery::recover(&path).unwrap();
                super::snapshot::checkpoint(&path, &recovered.snapshot).unwrap();
            }
            let disk = read_snapshot(&path).unwrap();
            if close_mode == "journal" {
                assert_eq!(disk, initial);
            } else {
                assert_eq!(disk.state, acknowledged.projection.state);
                assert_eq!(disk.history.undo_stack.len(), 1);
            }
            let reopened = VideoProjectService::default();
            let open = reopened.open(OWNER, &path, &grants).unwrap();
            assert_eq!(open.projection.state, acknowledged.projection.state);
            assert_eq!(open.projection.revision, acknowledged.new_revision);
            assert!(open.projection.can_undo);
            assert!(!open.projection.can_redo);
            if close_mode == "journal" {
                assert_eq!(open.recovery.status, RecoveryStatus::Recovered);
                assert_eq!(open.recovery.replayed_record_count, 1);
            }
            assert_eq!(
                reopened.execute(OWNER, edit.clone(), &grants).unwrap(),
                acknowledged
            );
            let undo = reopened
                .undo(OWNER, &original.id, 1, &id(702), &grants)
                .unwrap();
            assert_eq!(undo.projection.state, original.state);
            assert_eq!(undo.state_hash, original.revision.state_hash);
            reopened.close(OWNER, &original.id).unwrap();
            let saved_undo = read_snapshot(&path).unwrap();
            assert!(saved_undo.history.undo_stack.is_empty());
            assert_eq!(saved_undo.history.redo_stack.len(), 1);
            let again = VideoProjectService::default();
            let open = again.open(OWNER, &path, &grants).unwrap();
            assert_eq!(open.projection.state, original.state);
            assert_eq!(open.projection.revision.number, 2);
            assert!(!open.projection.can_undo);
            assert!(open.projection.can_redo);
            let redo = again
                .redo(OWNER, &original.id, 2, &id(703), &grants)
                .unwrap();
            assert_eq!(redo.projection.state, acknowledged.projection.state);
            assert_eq!(redo.state_hash, acknowledged.state_hash);
            let mut current = original.clone();
            current.state = redo.projection.state;
            current.revision = redo.new_revision;
            let reset = again
                .execute(
                    OWNER,
                    request(&current, 704, vec![set(&current, speed(1, 1), 705)]),
                    &grants,
                )
                .unwrap();
            let mut normal = original.state.clone();
            normal.sequences[0].tracks[0].clips_mut().unwrap()[0].speed = None;
            assert_eq!(reset.projection.state, normal);
            assert_eq!(reset.state_hash, state_hash(&normal).unwrap());
            again.close(OWNER, &original.id).unwrap();
            let final_service = VideoProjectService::default();
            let final_open = final_service.open(OWNER, &path, &grants).unwrap();
            assert_eq!(final_open.projection.state, normal);
            assert_eq!(clip(&final_open.projection.state).speed, None);
            assert_eq!(final_open.projection.revision.number, 4);
            let final_disk = read_snapshot(&path).unwrap();
            assert_eq!(final_disk.history.undo_stack.len(), 2);
            assert!(final_disk.history.redo_stack.is_empty());
            final_service.close(OWNER, &original.id).unwrap();
        }
    }
}

#[test]
fn rejected_speed_group_does_not_appear_after_journal_only_recovery() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("rejected.svpvideo");
    let original = fixture();
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
    let grants = VideoPathGrants::default();
    let valid = request(&original, 710, vec![set(&original, speed(2, 1), 711)]);
    let mut invalid = valid.clone();
    invalid.group_id = id(712);
    invalid.commands = vec![set(&original, speed(51, 100), 713)];
    invalid.base_revision = 1;
    let acknowledged = {
        let service = VideoProjectService::default();
        service.open(OWNER, &path, &grants).unwrap();
        let ack = service.execute(OWNER, valid.clone(), &grants).unwrap();
        let journal = fs::read(journal_path(&path).unwrap()).unwrap();
        assert!(service.execute(OWNER, invalid.clone(), &grants).is_err());
        assert_eq!(fs::read(journal_path(&path).unwrap()).unwrap(), journal);
        ack
    };
    let service = VideoProjectService::default();
    let open = service.open(OWNER, &path, &grants).unwrap();
    assert_eq!(open.recovery.replayed_record_count, 1);
    assert_eq!(open.projection.revision, acknowledged.new_revision);
    assert!(service
        .existing_group_result(OWNER, &invalid)
        .unwrap()
        .is_none());
    assert_eq!(
        service.execute(OWNER, valid, &grants).unwrap(),
        acknowledged
    );
    assert!(service.execute(OWNER, invalid, &grants).is_err());
    assert_eq!(
        service
            .undo(OWNER, &original.id, 1, &id(714), &grants)
            .unwrap()
            .state_hash,
        original.revision.state_hash
    );
    service.close(OWNER, &original.id).unwrap();
}

#[test]
fn speed_close_failure_recovery_keeps_durable_edit_and_private_inverse() {
    for point in [
        CheckpointFailpoint::BeforeTempSync,
        CheckpointFailpoint::AfterTempSyncBeforeReplace,
        CheckpointFailpoint::AfterReplace,
    ] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("failed-close.svpvideo");
        let original = fixture();
        fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
        let grants = VideoPathGrants::default();
        let edit = request(&original, 720, vec![set(&original, speed(1, 2), 721)]);
        let acknowledged = {
            let service = VideoProjectService::default();
            service.open(OWNER, &path, &grants).unwrap();
            let ack = service.execute(OWNER, edit.clone(), &grants).unwrap();
            service.fail_close(&original.id, point);
            assert!(service.close(OWNER, &original.id).is_err());
            assert_eq!(
                service.inspector(OWNER, &original.id).unwrap().revision,
                ack.new_revision
            );
            assert_eq!(
                service.existing_group_result(OWNER, &edit).unwrap(),
                Some(ack.clone())
            );
            ack
        };
        let service = VideoProjectService::default();
        let open = service.open(OWNER, &path, &grants).unwrap();
        assert_eq!(open.projection.state, acknowledged.projection.state);
        assert_eq!(open.projection.revision, acknowledged.new_revision);
        assert_eq!(service.execute(OWNER, edit, &grants).unwrap(), acknowledged);
        assert_eq!(
            service
                .undo(OWNER, &original.id, 1, &id(722), &grants)
                .unwrap()
                .state_hash,
            original.revision.state_hash
        );
        service.close(OWNER, &original.id).unwrap();
    }
}

#[test]
fn automatic_speed_checkpoint_failure_replays_all_edits_and_persisted_undo_redo() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("automatic.svpvideo");
    let original = fixture();
    fs::write(&path, canonical_bytes(&original).unwrap()).unwrap();
    let grants = VideoPathGrants::default();
    let acknowledged = {
        let service = VideoProjectService::default();
        service.open(OWNER, &path, &grants).unwrap();
        service.fail_automatic_checkpoint(
            &original.id,
            CheckpointFailpoint::AfterTempSyncBeforeReplace,
        );
        let mut current = original.clone();
        let mut last = None;
        for revision in 1..=25 {
            let multiplier = if revision % 2 == 1 {
                speed(3, 2)
            } else {
                speed(2, 1)
            };
            let result = service
                .execute(
                    OWNER,
                    request(
                        &current,
                        800 + revision,
                        vec![set(&current, multiplier, 900 + revision)],
                    ),
                    &grants,
                )
                .unwrap();
            current.state = result.projection.state.clone();
            current.revision = result.new_revision.clone();
            last = Some(result);
        }
        let ack = last.unwrap();
        assert_eq!(
            ack.projection.journal_health,
            JournalHealth::SnapshotPending
        );
        assert!(ack
            .events
            .iter()
            .any(|event| matches!(event, ProjectEvent::SnapshotWarning { .. })));
        assert_eq!(read_snapshot(&path).unwrap().revision.number, 0);
        assert_eq!(
            scan(&journal_path(&path).unwrap()).unwrap().records.len(),
            25
        );
        ack
    };
    let service = VideoProjectService::default();
    let open = service.open(OWNER, &path, &grants).unwrap();
    assert_eq!(open.recovery.replayed_record_count, 25);
    assert_eq!(open.projection.state, acknowledged.projection.state);
    assert_eq!(open.projection.revision.number, 25);
    let undo = service
        .undo(OWNER, &original.id, 25, &id(950), &grants)
        .unwrap();
    assert_eq!(clip(&undo.projection.state).speed, Some(speed(2, 1)));
    service.close(OWNER, &original.id).unwrap();
    let service = VideoProjectService::default();
    let open = service.open(OWNER, &path, &grants).unwrap();
    assert_eq!(open.projection.revision, undo.new_revision);
    let redo = service
        .redo(OWNER, &original.id, 26, &id(951), &grants)
        .unwrap();
    assert_eq!(redo.state_hash, acknowledged.state_hash);
    assert_eq!(read_snapshot(&path).unwrap().history.redo_stack.len(), 1); // Snapshot is still the checkpoint taken before redo.
    service.close(OWNER, &original.id).unwrap();
    assert!(read_snapshot(&path).unwrap().history.redo_stack.is_empty());
}

#[test]
fn legacy_v1_import_then_speed_journal_recovery_and_reset_preserve_migrated_hash() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("legacy.svpvideo");
    fs::write(
        &path,
        include_bytes!(
            "../../../../../../packages/video-contracts/fixtures/clip-speed-legacy-v1.json"
        ),
    )
    .unwrap();
    let grants = VideoPathGrants::default();
    let (original, acknowledged) = {
        let service = VideoProjectService::default();
        service.open(OWNER, &path, &grants).unwrap();
        let original = read_snapshot(&path).unwrap();
        assert_eq!(clip(&original.state).speed, None);
        let ack = service
            .execute(
                OWNER,
                request(&original, 960, vec![set(&original, speed(2, 1), 961)]),
                &grants,
            )
            .unwrap();
        (original, ack)
    };
    let service = VideoProjectService::default();
    let open = service.open(OWNER, &path, &grants).unwrap();
    assert_eq!(open.projection.state, acknowledged.projection.state);
    assert_eq!(open.projection.revision.number, 1);
    let mut current = original.clone();
    current.state = open.projection.state;
    current.revision = open.projection.revision;
    let reset = service
        .execute(
            OWNER,
            request(&current, 962, vec![set(&current, speed(1, 1), 963)]),
            &grants,
        )
        .unwrap();
    assert_eq!(reset.state_hash, original.revision.state_hash);
    assert_eq!(reset.projection.state, original.state);
    service.close(OWNER, &original.id).unwrap();
    assert_eq!(read_snapshot(&path).unwrap().state, original.state);
}
