//! Sessions keep one journal append handle open between commands. These tests pin that every
//! record appended through that handle is replayed exactly on the next open, however the session
//! ended, and that the handle is dropped around checkpoints and after an append failure.

use std::{fs, path::Path};

use super::{clip_opacity_fixture, projected_clip_transform, set_clip_opacity_command};
use crate::video::{
    project::{
        hash::state_hash,
        journal::{journal_path, scan, AppendFailpoint, TailClassification},
        service::VideoProjectService,
        types::{CommandGroupRequest, CommandResult, RecoveryStatus},
    },
    VideoPathGrants,
};

const OWNER: &str = "journal-handle-owner";
const REOPEN_OWNER: &str = "journal-handle-reopen-owner";

fn opacity(index: u64) -> u16 {
    u16::try_from(100 + index * 10).unwrap()
}

fn project_file(directory: &Path, name: &str) -> std::path::PathBuf {
    let project_path = directory.join(name);
    fs::write(
        &project_path,
        serde_json::to_vec(&clip_opacity_fixture()).unwrap(),
    )
    .unwrap();
    project_path
}

fn execute_opacity(
    service: &VideoProjectService,
    project_id: &str,
    index: u64,
    grants: &VideoPathGrants,
) -> Result<CommandResult, crate::video::error::VideoCommandError> {
    service.execute(
        OWNER,
        CommandGroupRequest {
            group_id: format!("69000000-0000-4000-8000-{:012}", index * 2 + 1),
            project_id: project_id.to_owned(),
            base_revision: index,
            commands: vec![set_clip_opacity_command(
                &format!("69000000-0000-4000-8000-{:012}", index * 2 + 2),
                opacity(index),
            )],
        },
        grants,
    )
}

/// Runs `count` commands through one session and returns the last result.
fn run_commands(
    service: &VideoProjectService,
    project_id: &str,
    count: u64,
    grants: &VideoPathGrants,
) -> CommandResult {
    let mut last = None;
    for index in 0..count {
        let result = execute_opacity(service, project_id, index, grants).unwrap();
        assert!(
            service.has_open_journal_handle(OWNER, project_id) || (index + 1) % 25 == 0,
            "the session keeps its append handle between commands"
        );
        last = Some(result);
    }
    last.unwrap()
}

fn assert_reopened_matches(
    project_path: &Path,
    expected: &CommandResult,
    replayed: u64,
    grants: &VideoPathGrants,
) {
    let service = VideoProjectService::default();
    let reopened = service.open(REOPEN_OWNER, project_path, grants).unwrap();
    assert_eq!(reopened.recovery.replayed_record_count, replayed);
    assert_eq!(reopened.projection.revision, expected.new_revision);
    assert_eq!(reopened.projection.state, expected.projection.state);
    assert_eq!(
        state_hash(&reopened.projection.state).unwrap(),
        expected.state_hash
    );
    assert_eq!(reopened.projection.can_undo, expected.projection.can_undo);
    assert_eq!(reopened.projection.can_redo, expected.projection.can_redo);
    let revision = expected.new_revision.number;
    // Replayed history is usable: undo restores the previous command's opacity exactly.
    let undone = service
        .undo(
            REOPEN_OWNER,
            &reopened.projection.project_id,
            revision,
            "69000000-0000-4000-8000-999999999999",
            grants,
        )
        .unwrap();
    assert_eq!(
        projected_clip_transform(&undone.projection.state).opacity_permille,
        u64::from(opacity(revision - 2))
    );
}

#[test]
fn journal_handle_records_replay_exactly_after_clean_close() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = project_file(directory.path(), "handle-clean.svpvideo");
    let grants = VideoPathGrants::default();
    let service = VideoProjectService::default();
    let project_id = service
        .open(OWNER, &project_path, &grants)
        .unwrap()
        .projection
        .project_id;

    let expected = run_commands(&service, &project_id, 7, &grants);
    service.close(OWNER, &project_id).unwrap();

    assert_eq!(
        scan(&journal_path(&project_path).unwrap())
            .unwrap()
            .records
            .len(),
        7
    );
    assert_reopened_matches(&project_path, &expected, 0, &grants);
}

#[test]
fn journal_handle_records_replay_after_session_drops_with_handle_open() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = project_file(directory.path(), "handle-unclean.svpvideo");
    let grants = VideoPathGrants::default();
    let expected = {
        let service = VideoProjectService::default();
        let project_id = service
            .open(OWNER, &project_path, &grants)
            .unwrap()
            .projection
            .project_id;
        let expected = run_commands(&service, &project_id, 7, &grants);
        assert!(service.has_open_journal_handle(OWNER, &project_id));
        expected
    };

    assert_reopened_matches(&project_path, &expected, 7, &grants);
}

#[test]
fn journal_handle_is_dropped_for_checkpoint_and_reopened_for_later_appends() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = project_file(directory.path(), "handle-checkpoint.svpvideo");
    let grants = VideoPathGrants::default();
    let expected = {
        let service = VideoProjectService::default();
        let project_id = service
            .open(OWNER, &project_path, &grants)
            .unwrap()
            .projection
            .project_id;
        run_commands(&service, &project_id, 25, &grants);
        assert!(
            !service.has_open_journal_handle(OWNER, &project_id),
            "record 25 checkpoints, and the handle is closed before the checkpoint"
        );
        let mut last = None;
        for index in 25..30 {
            last = Some(execute_opacity(&service, &project_id, index, &grants).unwrap());
            assert!(service.has_open_journal_handle(OWNER, &project_id));
        }
        last.unwrap()
    };

    // The checkpoint at revision 25 is on disk; the 5 later records replay through recovery.
    assert_reopened_matches(&project_path, &expected, 5, &grants);
}

#[test]
fn journal_handle_is_dropped_after_partial_append_and_reopen_keeps_durable_prefix() {
    let directory = tempfile::tempdir().unwrap();
    let project_path = project_file(directory.path(), "handle-torn.svpvideo");
    let grants = VideoPathGrants::default();
    let durable = {
        let service = VideoProjectService::default();
        let project_id = service
            .open(OWNER, &project_path, &grants)
            .unwrap()
            .projection
            .project_id;
        let durable = run_commands(&service, &project_id, 3, &grants);
        service.fail_append(&project_id, AppendFailpoint::AfterPartialAppend);
        assert!(execute_opacity(&service, &project_id, 3, &grants).is_err());
        assert!(
            !service.has_open_journal_handle(OWNER, &project_id),
            "a failed append drops the handle so nothing is appended onto the torn tail"
        );
        durable
    };

    let scanned = scan(&journal_path(&project_path).unwrap()).unwrap();
    assert_eq!(scanned.tail, TailClassification::Torn);
    assert_eq!(scanned.records.len(), 3);
    let service = VideoProjectService::default();
    let reopened = service.open(REOPEN_OWNER, &project_path, &grants).unwrap();
    assert_eq!(reopened.recovery.status, RecoveryStatus::Recovered);
    assert!(reopened.recovery.discarded_tail_bytes > 0);
    assert_eq!(reopened.projection.revision, durable.new_revision);
    assert_eq!(reopened.projection.state, durable.projection.state);
    let repaired = scan(&journal_path(&project_path).unwrap()).unwrap();
    assert_eq!(repaired.tail, TailClassification::Clean);
    assert_eq!(repaired.records.len(), 3);
}
