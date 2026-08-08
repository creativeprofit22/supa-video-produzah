use std::{fs, io::Write, path::Path};

use serde::Serialize;
use tempfile::NamedTempFile;

use super::{
    history::{commit_transition, redo_transition, undo_transition, HistoryTransition},
    journal::{
        initialize_journal, journal_path, repair_to_prefix, scan, sidecar_path, JournalScan,
        TailClassification,
    },
    snapshot::{checkpoint, previous_snapshot_path, read_snapshot},
    types::{
        CommandGroupRequest, JournalHeader, JournalRecord, JournalRecordKind, LastCommandMetadata,
        RecoveryReport, RecoveryStatus, VideoProjectSnapshotV2,
    },
};
use crate::video::error::{VideoCommandError, VideoErrorCode};

#[derive(Debug)]
pub struct RecoveredProject {
    pub snapshot: VideoProjectSnapshotV2,
    pub report: RecoveryReport,
    pub replayed_record_count: u64,
    pub last_command: Option<LastCommandMetadata>,
}

fn error(category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        VideoErrorCode::InvalidProject,
        "Project recovery could not prove a valid state",
        "recover_project",
        category,
    )
}

fn candidate_compatible(snapshot: &VideoProjectSnapshotV2, scanned: &JournalScan) -> bool {
    if snapshot.id != scanned.header.project_id
        || snapshot.storage_generation_id != scanned.header.storage_generation_id
    {
        return false;
    }
    if snapshot.last_applied_record_number == 0 {
        snapshot.revision == scanned.header.base_revision
            && snapshot.revision.state_hash == scanned.header.base_state_hash
    } else {
        scanned
            .records
            .iter()
            .find(|record| record.record_number == snapshot.last_applied_record_number)
            .is_some_and(|record| {
                record.resulting_revision == snapshot.revision
                    && record.record_hash == snapshot.last_record_hash
            })
    }
}

fn replay_record(
    snapshot: &VideoProjectSnapshotV2,
    record: &JournalRecord,
) -> Result<HistoryTransition, VideoCommandError> {
    if snapshot.revision != record.base_revision
        || snapshot.revision.state_hash != record.previous_state_hash
    {
        return Err(error("record_base"));
    }
    let transition = match record.kind {
        JournalRecordKind::Commit => commit_transition(
            snapshot,
            &CommandGroupRequest {
                group_id: record.group_id.clone(),
                project_id: snapshot.id.clone(),
                base_revision: record.base_revision.number,
                commands: record.replay_commands().to_vec(),
            },
            &record.committed_at,
        )?,
        JournalRecordKind::Undo => undo_transition(
            snapshot,
            record.base_revision.number,
            &record.operation_id,
            &record.committed_at,
        )?,
        JournalRecordKind::Redo => redo_transition(
            snapshot,
            record.base_revision.number,
            &record.operation_id,
            &record.committed_at,
        )?,
    };
    if transition.snapshot.revision != record.resulting_revision
        || transition.snapshot.revision.state_hash != record.resulting_state_hash
        || transition.history_group != record.history_group
        || transition.applied.affected_ranges != record.affected_ranges
        || transition.applied.cache_invalidations != record.cache_invalidations
    {
        return Err(error("record_replay"));
    }
    Ok(transition)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecoveryReport<'a> {
    report: &'a RecoveryReport,
    journal_tail_sha256: Option<String>,
}

fn write_recovery_report(
    project_path: &Path,
    report: &RecoveryReport,
    tail_hash: Option<String>,
) -> Result<(), VideoCommandError> {
    let sidecar = sidecar_path(project_path)?;
    fs::create_dir_all(&sidecar).map_err(|_| error("report_directory"))?;
    let destination = sidecar.join("recovery-report.json");
    let mut bytes = serde_json::to_vec_pretty(&StoredRecoveryReport {
        report,
        journal_tail_sha256: tail_hash,
    })
    .map_err(|_| error("report_serialize"))?;
    bytes.push(b'\n');
    let mut temporary = NamedTempFile::new_in(&sidecar).map_err(|_| error("report_temp"))?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.flush())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| error("report_sync"))?;
    temporary
        .persist(destination)
        .map_err(|_| error("report_promote"))?;
    Ok(())
}

fn report(
    status: RecoveryStatus,
    revision: u64,
    replayed: u64,
    discarded: u64,
    message: &str,
    legacy_history_reset: bool,
) -> RecoveryReport {
    RecoveryReport {
        status,
        recovered_revision: revision,
        replayed_record_count: replayed,
        discarded_tail_bytes: discarded,
        message: message.to_owned(),
        legacy_history_reset,
    }
}

pub fn create_journal_for_snapshot(
    project_path: &Path,
    snapshot: &mut VideoProjectSnapshotV2,
) -> Result<JournalHeader, VideoCommandError> {
    let path = journal_path(project_path)?;
    let header = initialize_journal(
        &path,
        &JournalHeader {
            journal_version: 1,
            project_id: snapshot.id.clone(),
            storage_generation_id: snapshot.storage_generation_id.clone(),
            base_revision: snapshot.revision.clone(),
            base_state_hash: snapshot.revision.state_hash.clone(),
            created_at: snapshot.created_at.clone(),
            header_hash: String::new(),
        },
    )?;
    snapshot.last_record_hash = header.header_hash.clone();
    Ok(header)
}

pub fn recover(project_path: &Path) -> Result<RecoveredProject, VideoCommandError> {
    let main = read_snapshot(project_path).ok();
    let previous_path = previous_snapshot_path(project_path)?;
    let previous = read_snapshot(&previous_path).ok();
    let journal = journal_path(project_path)?;
    if !journal.exists() {
        let mut snapshot = main.or(previous).ok_or_else(|| error("no_snapshot"))?;
        snapshot.last_applied_record_number = 0;
        create_journal_for_snapshot(project_path, &mut snapshot)?;
        checkpoint(project_path, &snapshot)?;
        let recovery = report(
            RecoveryStatus::JournalRecreated,
            snapshot.revision.number,
            0,
            0,
            "Recovery journal recreated from the validated snapshot.",
            false,
        );
        write_recovery_report(project_path, &recovery, None)?;
        return Ok(RecoveredProject {
            snapshot,
            report: recovery,
            replayed_record_count: 0,
            last_command: None,
        });
    }

    let scanned = scan(&journal)?;
    let main_compatible = main
        .as_ref()
        .is_some_and(|snapshot| candidate_compatible(snapshot, &scanned));
    let previous_compatible = previous
        .as_ref()
        .is_some_and(|snapshot| candidate_compatible(snapshot, &scanned));
    let used_previous = !main_compatible && previous_compatible;
    let mut snapshot = [main, previous]
        .into_iter()
        .flatten()
        .filter(|candidate| candidate_compatible(candidate, &scanned))
        .max_by_key(|candidate| candidate.revision.number)
        .ok_or_else(|| error("no_compatible_snapshot"))?;
    let mut replayed = 0_u64;
    let starting_record_number = snapshot.last_applied_record_number;
    for record in scanned
        .records
        .iter()
        .filter(|record| record.record_number > starting_record_number)
    {
        let transition = replay_record(&snapshot, record).map_err(|_| error("record_replay"))?;
        snapshot = transition.snapshot;
        snapshot.last_applied_record_number = record.record_number;
        snapshot.last_record_hash = record.record_hash.clone();
        replayed += 1;
    }
    let replay_prefix_len = scanned.valid_prefix_len;
    let needs_repair = scanned.tail != TailClassification::Clean;
    let status = if scanned.tail == TailClassification::Corrupt {
        RecoveryStatus::Degraded
    } else if used_previous || scanned.tail == TailClassification::Torn || replayed > 0 {
        RecoveryStatus::Recovered
    } else {
        RecoveryStatus::Clean
    };
    let discarded = scanned.discarded_tail_bytes as u64;
    let recovery = report(
        status.clone(),
        snapshot.revision.number,
        replayed,
        discarded,
        match status {
            RecoveryStatus::Clean => "Project opened with a clean journal.",
            RecoveryStatus::Recovered => "Project recovered from durable journal data.",
            RecoveryStatus::Degraded => {
                "Project recovered to the last verified record; later bytes were discarded."
            }
            _ => "Project recovery completed.",
        },
        false,
    );
    if needs_repair {
        let bytes = fs::read(&journal).map_err(|_| error("journal_read"))?;
        let tail_hash = bytes
            .get(replay_prefix_len..)
            .filter(|tail| !tail.is_empty())
            .map(super::hash::sha256_hex);
        write_recovery_report(project_path, &recovery, tail_hash)?;
        repair_to_prefix(&journal, replay_prefix_len)?;
    }
    if used_previous || replayed > 0 || needs_repair {
        checkpoint(project_path, &snapshot)?;
    }
    let last_command = if snapshot.last_applied_record_number == 0 {
        None
    } else {
        let record = scanned
            .records
            .iter()
            .find(|record| record.record_number == snapshot.last_applied_record_number)
            .filter(|record| {
                record.resulting_revision == snapshot.revision
                    && record.record_hash == snapshot.last_record_hash
            })
            .ok_or_else(|| error("last_applied_record"))?;
        Some(LastCommandMetadata {
            operation_id: record.operation_id.clone(),
            group_id: record.group_id.clone(),
            summary: record.summary.clone(),
        })
    };
    Ok(RecoveredProject {
        snapshot,
        report: recovery,
        replayed_record_count: replayed,
        last_command,
    })
}
