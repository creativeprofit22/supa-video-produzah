use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    commands::{apply_group, AppliedGroup},
    hash::{canonical_hash, state_hash},
    integrity::{is_canonical_uuid, validate_snapshot},
    types::{
        CommandGroupRequest, JournalRecordKind, ProjectCommand, ProjectHistoryEntryV2,
        ProjectRevisionDescriptorV2, VideoProjectSnapshotV2, MAX_HISTORY_ENTRIES, MAX_SAFE_INTEGER,
    },
};
use crate::video::error::{VideoCommandError, VideoErrorCode};

#[derive(Debug, Clone)]
pub struct HistoryTransition {
    pub snapshot: VideoProjectSnapshotV2,
    pub kind: JournalRecordKind,
    pub operation_id: String,
    pub group_id: String,
    pub history_group: ProjectHistoryEntryV2,
    pub applied: AppliedGroup,
    pub prior_revision: ProjectRevisionDescriptorV2,
}

pub fn command_group_payload_hash(
    request: &CommandGroupRequest,
) -> Result<String, VideoCommandError> {
    canonical_hash(request)
}

pub fn reject_duplicate_conflict(
    existing_payload_hash: &str,
    request: &CommandGroupRequest,
) -> Result<(), VideoCommandError> {
    if existing_payload_hash == command_group_payload_hash(request)? {
        Ok(())
    } else {
        Err(error(VideoErrorCode::DuplicateConflict, "group_id_reuse"))
    }
}

fn error(code: VideoErrorCode, category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        code,
        "Project history operation was rejected",
        "project_history",
        category,
    )
}

fn revision_id(operation_id: &str, number: u64, hash: &str) -> String {
    let digest =
        Sha256::digest(format!("supa-video-revision:{operation_id}:{number}:{hash}").as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).hyphenated().to_string()
}

fn push_bounded<T>(items: &mut Vec<T>, item: T) {
    if items.len() == MAX_HISTORY_ENTRIES {
        items.remove(0);
    }
    items.push(item);
}

fn next_revision(
    prior: &ProjectRevisionDescriptorV2,
    operation_id: &str,
    committed_at: &str,
    resulting_hash: String,
) -> Result<ProjectRevisionDescriptorV2, VideoCommandError> {
    if !is_canonical_uuid(operation_id) {
        return Err(error(VideoErrorCode::InvalidCommand, "operation_id"));
    }
    let number = prior
        .number
        .checked_add(1)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| error(VideoErrorCode::InvalidCommand, "revision_overflow"))?;
    Ok(ProjectRevisionDescriptorV2 {
        number,
        id: revision_id(operation_id, number, &resulting_hash),
        parent_id: Some(prior.id.clone()),
        committed_at: committed_at.to_owned(),
        operation_id: operation_id.to_owned(),
        state_hash: resulting_hash,
    })
}

pub fn commit_transition(
    snapshot: &VideoProjectSnapshotV2,
    request: &CommandGroupRequest,
    committed_at: &str,
) -> Result<HistoryTransition, VideoCommandError> {
    if request.project_id != snapshot.id {
        return Err(error(VideoErrorCode::InvalidCommand, "project_mismatch"));
    }
    if request.base_revision != snapshot.revision.number {
        return Err(error(VideoErrorCode::StaleRevision, "base_revision"));
    }
    if request
        .commands
        .iter()
        .any(ProjectCommand::is_private_inverse)
    {
        return Err(error(VideoErrorCode::InvalidCommand, "private_inverse"));
    }
    let applied = apply_group(&snapshot.state, &request.commands)?;
    let history_group = ProjectHistoryEntryV2 {
        group_id: request.group_id.clone(),
        summary: applied.summary.clone(),
        forward_commands: request.commands.clone(),
        inverse_commands: applied.inverse_commands.clone(),
        affected_ranges: applied.affected_ranges.clone(),
        cache_invalidations: applied.cache_invalidations.clone(),
    };
    let prior_revision = snapshot.revision.clone();
    let revision = next_revision(
        &prior_revision,
        &request.group_id,
        committed_at,
        state_hash(&applied.state)?,
    )?;
    let mut next = snapshot.clone();
    next.state = applied.state.clone();
    next.revision = revision;
    next.updated_at = committed_at.to_owned();
    push_bounded(&mut next.history.undo_stack, history_group.clone());
    next.history.redo_stack.clear();
    validate_snapshot(&next)?;
    Ok(HistoryTransition {
        snapshot: next,
        kind: JournalRecordKind::Commit,
        operation_id: request.group_id.clone(),
        group_id: request.group_id.clone(),
        history_group,
        applied,
        prior_revision,
    })
}

pub fn undo_transition(
    snapshot: &VideoProjectSnapshotV2,
    base_revision: u64,
    operation_id: &str,
    committed_at: &str,
) -> Result<HistoryTransition, VideoCommandError> {
    if base_revision != snapshot.revision.number {
        return Err(error(VideoErrorCode::StaleRevision, "base_revision"));
    }
    let history_group = snapshot
        .history
        .undo_stack
        .last()
        .cloned()
        .ok_or_else(|| error(VideoErrorCode::InvalidCommand, "nothing_to_undo"))?;
    let applied = apply_group(&snapshot.state, &history_group.inverse_commands)?;
    let prior_revision = snapshot.revision.clone();
    let revision = next_revision(
        &prior_revision,
        operation_id,
        committed_at,
        state_hash(&applied.state)?,
    )?;
    let mut next = snapshot.clone();
    next.state = applied.state.clone();
    next.revision = revision;
    next.updated_at = committed_at.to_owned();
    next.history.undo_stack.pop();
    push_bounded(&mut next.history.redo_stack, history_group.clone());
    validate_snapshot(&next)?;
    Ok(HistoryTransition {
        snapshot: next,
        kind: JournalRecordKind::Undo,
        operation_id: operation_id.to_owned(),
        group_id: history_group.group_id.clone(),
        history_group,
        applied,
        prior_revision,
    })
}

pub fn redo_transition(
    snapshot: &VideoProjectSnapshotV2,
    base_revision: u64,
    operation_id: &str,
    committed_at: &str,
) -> Result<HistoryTransition, VideoCommandError> {
    if base_revision != snapshot.revision.number {
        return Err(error(VideoErrorCode::StaleRevision, "base_revision"));
    }
    let history_group = snapshot
        .history
        .redo_stack
        .last()
        .cloned()
        .ok_or_else(|| error(VideoErrorCode::InvalidCommand, "nothing_to_redo"))?;
    let applied = apply_group(&snapshot.state, &history_group.forward_commands)?;
    let prior_revision = snapshot.revision.clone();
    let revision = next_revision(
        &prior_revision,
        operation_id,
        committed_at,
        state_hash(&applied.state)?,
    )?;
    let mut next = snapshot.clone();
    next.state = applied.state.clone();
    next.revision = revision;
    next.updated_at = committed_at.to_owned();
    next.history.redo_stack.pop();
    push_bounded(&mut next.history.undo_stack, history_group.clone());
    validate_snapshot(&next)?;
    Ok(HistoryTransition {
        snapshot: next,
        kind: JournalRecordKind::Redo,
        operation_id: operation_id.to_owned(),
        group_id: history_group.group_id.clone(),
        history_group,
        applied,
        prior_revision,
    })
}
