//! Proposal operations on an open project session. Child of `service` so it can
//! reach session internals; all persistence helpers live in `proposal`.

use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    lock_open_session, now, resolve_project_asset_sources, IdempotencyEntry, ProjectSession,
    VideoProjectService,
};
use crate::video::{
    error::{VideoCommandError, VideoErrorCode},
    grants::VideoPathGrants,
    project::{
        history::{
            attribute_commit, command_group_payload_hash, commit_transition,
            reject_duplicate_conflict, undo_transition,
        },
        integrity::is_canonical_uuid,
        journal::{journal_path, scan},
        proposal::{
            affected_ranges, load_proposal_store, ranges_are_offered, reconcile_with_journal,
            refresh_open_proposals, save_proposal_store, validate_proposal, JournalProposalCommit,
            NativeProposalStatus, ProposalAudit, ProposalAuditAction, ProposalDeletedRange,
            ProposalStoreV1, ProposalView, StoreWriteFailpoint, StoredProposal, MAX_OPEN_PROPOSALS,
        },
        types::{CommandGroupRequest, CommandResult, JournalRecordKind},
    },
};

pub const DEFAULT_PROPOSAL_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
/// Matches the `statusReason` bound in the shared contract.
const MAX_STATUS_REASON_CHARS: usize = 512;

/// What the review UI needs: open and recently resolved proposals plus audit.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalListing {
    pub proposals: Vec<StoredProposal>,
    pub audit: Vec<ProposalAudit>,
    /// True when an unreadable store was set aside on load.
    pub store_discarded: bool,
}

fn listing(store: &ProposalStoreV1, discarded: bool) -> ProposalListing {
    ProposalListing {
        proposals: store.proposals.clone(),
        audit: store.audit.clone(),
        store_discarded: discarded,
    }
}

fn proposal_error(code: VideoErrorCode, category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        code,
        "Edit proposal was rejected",
        "project_proposal",
        category,
    )
}

impl VideoProjectService {
    #[cfg(test)]
    pub(crate) fn set_proposal_store_failpoint(&self, failpoint: StoreWriteFailpoint) {
        *self.proposal_store_failpoint.lock().unwrap() = failpoint;
    }

    fn store_failpoint(&self) -> StoreWriteFailpoint {
        #[cfg(test)]
        {
            *self.proposal_store_failpoint.lock().unwrap()
        }
        #[cfg(not(test))]
        StoreWriteFailpoint::None
    }

    /// Loads the store, settles proposals the journal shows as applied (a crash
    /// between the journal append and the store write), and refreshes expiry.
    /// Returns whether the store changed and so needs saving.
    fn load_settled_store(
        session: &ProjectSession,
        now_ms: u64,
    ) -> Result<(ProposalStoreV1, bool, bool), VideoCommandError> {
        let loaded = load_proposal_store(&session.path, &session.snapshot.id)?;
        let mut store = loaded.store;
        let mut changed = loaded.discarded;
        if store.open_count() > 0 {
            let commits: Vec<JournalProposalCommit> = scan(&journal_path(&session.path)?)?
                .records
                .into_iter()
                .filter(|record| record.kind == JournalRecordKind::Commit)
                .filter_map(|record| {
                    record.proposal_audit.map(|audit| JournalProposalCommit {
                        group_id: record.group_id,
                        base_revision: record.base_revision,
                        audit,
                    })
                })
                .collect();
            changed |= reconcile_with_journal(&mut store, &commits) > 0;
        }
        changed |=
            !refresh_open_proposals(&mut store, &session.snapshot.revision, now_ms).is_empty();
        Ok((store, changed, loaded.discarded))
    }

    pub fn list_proposals(
        &self,
        owner: &str,
        project_id: &str,
        now_ms: u64,
    ) -> Result<ProposalListing, VideoCommandError> {
        let session = self.session(owner, project_id)?;
        let session = lock_open_session(&session)?;
        let (mut store, changed, discarded) = Self::load_settled_store(&session, now_ms)?;
        if changed {
            save_proposal_store(&session.path, &mut store, self.store_failpoint())?;
        }
        Ok(listing(&store, discarded))
    }

    /// Validates a proposal against the open project and stores it as pending.
    /// Submitting the same proposal again is a no-op.
    pub fn submit_proposal(
        &self,
        owner: &str,
        project_id: &str,
        proposal: &Value,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<StoredProposal, VideoCommandError> {
        let session = self.session(owner, project_id)?;
        let session = lock_open_session(&session)?;
        let view = validate_proposal(proposal, &session.snapshot)?;
        let (mut store, _, _) = Self::load_settled_store(&session, now_ms)?;
        if let Some(existing) = store.find(&view.proposal_id) {
            if existing.proposal != *proposal {
                return Err(proposal_error(
                    VideoErrorCode::DuplicateConflict,
                    "proposal_id_reuse",
                ));
            }
            return Ok(existing.clone());
        }
        if store.open_count() >= MAX_OPEN_PROPOSALS {
            return Err(proposal_error(
                VideoErrorCode::StorageLimit,
                "proposal_open_limit",
            ));
        }
        let stored = StoredProposal {
            proposal_id: view.proposal_id,
            producer: view.producer,
            sequence_id: view.sequence_id,
            track_id: view.track_id,
            base_revision: view.project_revision,
            status: NativeProposalStatus::Pending,
            status_reason: None,
            created_at_ms: now_ms,
            expires_at_ms: now_ms.saturating_add(ttl_ms.clamp(1, DEFAULT_PROPOSAL_TTL_MS * 7)),
            applied_group_id: None,
            pre_apply_revision: None,
            approved_range_ids: Vec::new(),
            restore_operation_id: None,
            restore_steps: 0,
            proposal: proposal.clone(),
        };
        store.proposals.push(stored.clone());
        save_proposal_store(&session.path, &mut store, self.store_failpoint())?;
        Ok(stored)
    }

    pub fn reject_proposal(
        &self,
        owner: &str,
        project_id: &str,
        proposal_id: &str,
        now_ms: u64,
    ) -> Result<StoredProposal, VideoCommandError> {
        let session = self.session(owner, project_id)?;
        let session = lock_open_session(&session)?;
        let (mut store, _, _) = Self::load_settled_store(&session, now_ms)?;
        let stored = store
            .find_mut(proposal_id)
            .ok_or_else(|| proposal_error(VideoErrorCode::InvalidCommand, "proposal_unknown"))?;
        match stored.status {
            NativeProposalStatus::Rejected => return Ok(stored.clone()),
            NativeProposalStatus::Pending => {}
            _ => {
                return Err(proposal_error(
                    VideoErrorCode::InvalidCommand,
                    "proposal_not_open",
                ))
            }
        }
        stored.status = NativeProposalStatus::Rejected;
        stored.status_reason = Some("Rejected by user".to_owned());
        let result = stored.clone();
        store.push_audit(ProposalAudit {
            action: ProposalAuditAction::Rejected,
            proposal_id: result.proposal_id.clone(),
            applied_proposal_id: None,
            producer: result.producer.clone(),
            approved_range_ids: Vec::new(),
            base_revision: result.base_revision.number,
            resulting_revision: None,
            affected_ranges: Vec::new(),
            at_ms: now_ms,
        });
        save_proposal_store(&session.path, &mut store, self.store_failpoint())?;
        Ok(result)
    }

    /// Marks a pending proposal stale, for when the review UI finds it can no
    /// longer be re-based onto the current project. Already stale is a no-op
    /// (saving anything the refresh just settled), so a retry is safe; any
    /// other resolved status is refused.
    pub fn mark_proposal_stale(
        &self,
        owner: &str,
        project_id: &str,
        proposal_id: &str,
        reason: &str,
        now_ms: u64,
    ) -> Result<StoredProposal, VideoCommandError> {
        let session = self.session(owner, project_id)?;
        let session = lock_open_session(&session)?;
        let (mut store, changed, _) = Self::load_settled_store(&session, now_ms)?;
        let stored = store
            .find_mut(proposal_id)
            .ok_or_else(|| proposal_error(VideoErrorCode::InvalidCommand, "proposal_unknown"))?;
        match stored.status {
            NativeProposalStatus::Stale => {
                let result = stored.clone();
                if changed {
                    save_proposal_store(&session.path, &mut store, self.store_failpoint())?;
                }
                return Ok(result);
            }
            NativeProposalStatus::Pending => {}
            _ => {
                return Err(proposal_error(
                    VideoErrorCode::InvalidCommand,
                    "proposal_not_open",
                ))
            }
        }
        let reason = reason.trim();
        stored.status = NativeProposalStatus::Stale;
        stored.status_reason = Some(if reason.is_empty() {
            "Proposal can no longer be applied".to_owned()
        } else {
            reason.chars().take(MAX_STATUS_REASON_CHARS).collect()
        });
        let result = stored.clone();
        store.push_audit(ProposalAudit {
            action: ProposalAuditAction::Stale,
            proposal_id: result.proposal_id.clone(),
            applied_proposal_id: None,
            producer: result.producer.clone(),
            approved_range_ids: Vec::new(),
            base_revision: result.base_revision.number,
            resulting_revision: None,
            affected_ranges: Vec::new(),
            at_ms: now_ms,
        });
        save_proposal_store(&session.path, &mut store, self.store_failpoint())?;
        Ok(result)
    }

    /// Applies the approved part of a pending proposal as one atomic, undoable
    /// command group. `approved` is the proposal re-derived by the UI for the
    /// approved ranges against the current revision; it must come from the same
    /// producer and may only cut source ranges (per asset) the stored proposal
    /// offered, wherever those frames sit now (a clip split keeps them valid).
    ///
    /// Before applying, the current state is checkpointed so "restore to before
    /// this proposal" has a durable restore point. The journal commit record
    /// carries the audit, so apply and audit are atomic.
    pub fn apply_proposal(
        &self,
        owner: &str,
        project_id: &str,
        proposal_id: &str,
        approved: &Value,
        now_ms: u64,
        grants: &VideoPathGrants,
    ) -> Result<CommandResult, VideoCommandError> {
        let session = self.session(owner, project_id)?;
        let mut session = lock_open_session(&session)?;
        // A retried apply arrives after its own commit moved the revision on;
        // answer it from the idempotency cache rather than as stale.
        if let Ok(request) =
            serde_json::from_value::<CommandGroupRequest>(approved["commandGroup"].clone())
        {
            if let Some(existing) = session.idempotency.get(&request.group_id) {
                reject_duplicate_conflict(&existing.payload_hash, &request)?;
                return Ok(existing.result.clone());
            }
        }
        let view = validate_proposal(approved, &session.snapshot)?;
        let (mut store, _, _) = Self::load_settled_store(&session, now_ms)?;
        let stored = store
            .find(proposal_id)
            .cloned()
            .ok_or_else(|| proposal_error(VideoErrorCode::InvalidCommand, "proposal_unknown"))?;
        if stored.status != NativeProposalStatus::Pending {
            save_proposal_store(&session.path, &mut store, self.store_failpoint())?;
            return Err(proposal_error(
                VideoErrorCode::StaleRevision,
                "proposal_not_open",
            ));
        }
        if stored.producer != view.producer
            || stored.sequence_id != view.sequence_id
            || stored.track_id != view.track_id
        {
            return Err(proposal_error(
                VideoErrorCode::InvalidCommand,
                "proposal_mismatch",
            ));
        }
        let offered = validate_offered_ranges(&stored)?;
        let approved_range_ids: Vec<String> = view
            .deleted_ranges
            .iter()
            .map(|range| range.range_id())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if !ranges_are_offered(&offered, &view.deleted_ranges) {
            return Err(proposal_error(
                VideoErrorCode::InvalidCommand,
                "proposal_range_not_offered",
            ));
        }

        let request = view.command_group.clone();
        let payload_hash = command_group_payload_hash(&request)?;
        let mut transition = commit_transition(&session.snapshot, &request, &now())?;
        attribute_commit(&mut transition, &stored.producer.id)?;
        let (sources, relative_grants) = resolve_project_asset_sources(
            owner,
            &session.path,
            &transition.snapshot.state.assets,
            grants,
        )?;
        // Pre-apply restore point. Fail closed: no checkpoint, no cut.
        self.automatic_checkpoint(&session)
            .map_err(|_| proposal_error(VideoErrorCode::ProjectIo, "proposal_checkpoint"))?;
        session.snapshot_revision = session.snapshot.revision.number;
        let pre_apply_revision = session.snapshot.revision.clone();
        grants.grant_opened_project_sources(owner, session.path.clone(), relative_grants)?;
        let audit = ProposalAudit {
            action: ProposalAuditAction::Applied,
            proposal_id: stored.proposal_id.clone(),
            applied_proposal_id: Some(view.proposal_id.clone()),
            producer: stored.producer.clone(),
            approved_range_ids: approved_range_ids.clone(),
            base_revision: pre_apply_revision.number,
            resulting_revision: Some(transition.snapshot.revision.number),
            affected_ranges: affected_ranges(&view),
            at_ms: now_ms,
        };
        let result = self.finish_transition(
            &mut session,
            transition,
            sources,
            payload_hash.clone(),
            Some(audit.clone()),
        )?;
        session.idempotency.insert(
            request.group_id.clone(),
            IdempotencyEntry {
                payload_hash,
                result: result.clone(),
            },
        );
        // The cut is durable in the journal now. If this store write fails the
        // next load settles the proposal from the journal audit.
        if let Some(entry) = store.find_mut(proposal_id) {
            entry.status = NativeProposalStatus::Applied;
            entry.status_reason = None;
            entry.applied_group_id = Some(request.group_id);
            entry.pre_apply_revision = Some(pre_apply_revision);
            entry.approved_range_ids = approved_range_ids;
        }
        store.push_audit(audit);
        let _ = save_proposal_store(&session.path, &mut store, self.store_failpoint());
        Ok(result)
    }

    /// "Restore to before this proposal": undoes the proposal's commit and any
    /// later edits, as ordinary undo steps, so every step stays redoable. The
    /// steps are simulated first and only run if they land exactly on the
    /// pre-apply state recorded at apply time. Retrying with the same
    /// operation id returns the same results.
    pub fn restore_before_proposal(
        &self,
        owner: &str,
        project_id: &str,
        proposal_id: &str,
        operation_id: &str,
        now_ms: u64,
        grants: &VideoPathGrants,
    ) -> Result<Vec<CommandResult>, VideoCommandError> {
        if !is_canonical_uuid(operation_id) {
            return Err(proposal_error(
                VideoErrorCode::InvalidCommand,
                "operation_id",
            ));
        }
        let session = self.session(owner, project_id)?;
        let mut session = lock_open_session(&session)?;
        let (mut store, _, _) = Self::load_settled_store(&session, now_ms)?;
        let stored = store
            .find(proposal_id)
            .cloned()
            .ok_or_else(|| proposal_error(VideoErrorCode::InvalidCommand, "proposal_unknown"))?;

        // Retry: answer from the idempotency cache while the session remembers it.
        let first_step = restore_step_id(operation_id, 0);
        if session.idempotency.contains_key(&first_step) {
            return Ok((0..)
                .map(|index| restore_step_id(operation_id, index))
                .map_while(|id| {
                    session
                        .idempotency
                        .get(&id)
                        .map(|entry| entry.result.clone())
                })
                .collect());
        }
        if stored.status != NativeProposalStatus::Applied {
            return Err(proposal_error(
                VideoErrorCode::InvalidCommand,
                "proposal_not_applied",
            ));
        }
        let (Some(group_id), Some(pre_apply)) = (
            stored.applied_group_id.clone(),
            stored.pre_apply_revision.clone(),
        ) else {
            return Err(proposal_error(
                VideoErrorCode::InvalidProject,
                "proposal_restore_point",
            ));
        };
        let undo_stack = &session.snapshot.history.undo_stack;
        let Some(position) = undo_stack
            .iter()
            .rposition(|entry| entry.group_id == group_id)
        else {
            return Err(proposal_error(
                VideoErrorCode::StaleRevision,
                "proposal_restore_unavailable",
            ));
        };
        let steps = undo_stack.len() - position;

        // Dry run on a copy: the restore must land exactly on the pre-apply state.
        let mut simulated = session.snapshot.clone();
        for index in 0..steps {
            let id = restore_step_id(operation_id, index);
            let number = simulated.revision.number;
            simulated = undo_transition(&simulated, number, &id, &now())?.snapshot;
        }
        if simulated.revision.state_hash != pre_apply.state_hash {
            return Err(proposal_error(
                VideoErrorCode::StaleRevision,
                "proposal_restore_mismatch",
            ));
        }

        let mut results = Vec::with_capacity(steps);
        for index in 0..steps {
            let base = session.snapshot.revision.number;
            results.push(self.history_step_locked(
                &mut session,
                owner,
                base,
                &restore_step_id(operation_id, index),
                false,
                grants,
            )?);
        }
        let resulting = session.snapshot.revision.number;
        if let Some(entry) = store.find_mut(proposal_id) {
            entry.status = NativeProposalStatus::Restored;
            entry.status_reason = Some("Restored to before this proposal".to_owned());
            entry.restore_operation_id = Some(operation_id.to_owned());
            entry.restore_steps = steps as u64;
        }
        store.push_audit(ProposalAudit {
            action: ProposalAuditAction::Restored,
            proposal_id: stored.proposal_id.clone(),
            applied_proposal_id: None,
            producer: stored.producer.clone(),
            approved_range_ids: stored.approved_range_ids.clone(),
            base_revision: pre_apply.number,
            resulting_revision: Some(resulting),
            affected_ranges: Vec::new(),
            at_ms: now_ms,
        });
        // The undo steps are durable in the journal; a failed store write only
        // leaves the listing saying "applied", which a later restore reports as
        // unavailable rather than cutting anything.
        let _ = save_proposal_store(&session.path, &mut store, self.store_failpoint());
        Ok(results)
    }
}

/// Deterministic per-step operation id for a restore, derived like inverse ids.
fn restore_step_id(operation_id: &str, index: usize) -> String {
    let digest = Sha256::digest(format!(
        "supa-video-proposal-restore:{operation_id}:{index}"
    ));
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).hyphenated().to_string()
}

fn validate_offered_ranges(
    stored: &StoredProposal,
) -> Result<Vec<ProposalDeletedRange>, VideoCommandError> {
    let original: ProposalView = serde_json::from_value(stored.proposal.clone())
        .map_err(|_| proposal_error(VideoErrorCode::InvalidProject, "proposal_store_entry"))?;
    Ok(original.deleted_ranges)
}
