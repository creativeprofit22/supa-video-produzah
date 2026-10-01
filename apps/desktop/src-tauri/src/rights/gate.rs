//! Release gate, enforced by the render authority inside
//! `validate_render_plan_with_inputs` (fresh and persisted render paths).
//!
//! Remote inputs are identified by content digest, never by UI claims: every
//! input whose size matches some receipt is hashed and looked up in the
//! receipt store. Inputs with no receipt are local imports and pass exactly as
//! before. For inputs with a receipt, the render fails closed on missing or
//! unreadable receipts, missing/tampered snapshots, stale refreshes, changed or
//! withdrawn upstream records, a blocked intended use or incomplete attribution.

use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    attribution::{missing_attribution_fields, render_credits_text, CreditEntry},
    policy::evaluate_policy,
    store::{ReceiptStore, ReceiptStoreError, SnapshotCheck},
    types::{
        AcquisitionReceipt, LicenseId, PolicyOutcome, PolicyReasonCode, ProviderId, RefreshStatus,
        ReleaseGateReason, StructuredAttribution, UsePolicyProfile,
    },
};
use crate::video::media_store::MediaContentIdentityV1;

/// Read access the gate needs. Implemented by the real store; tests may supply
/// an empty lookup, which behaves exactly like a store with no receipts.
pub trait ReceiptLookup: Sync {
    fn any_receipt_with_byte_length(&self, byte_length: u64) -> Result<bool, ReceiptStoreError>;
    #[allow(clippy::type_complexity)]
    fn receipts_for_digest(
        &self,
        digest: &str,
    ) -> Result<Vec<Result<AcquisitionReceipt, uuid::Uuid>>, ReceiptStoreError>;
    fn check_snapshot(
        &self,
        snapshot: &super::types::LicenseSnapshot,
    ) -> Result<SnapshotCheck, ReceiptStoreError>;
    fn receipt_exists(&self, receipt_id: &uuid::Uuid) -> Result<bool, ReceiptStoreError>;
}

impl ReceiptLookup for ReceiptStore {
    fn any_receipt_with_byte_length(&self, byte_length: u64) -> Result<bool, ReceiptStoreError> {
        ReceiptStore::any_receipt_with_byte_length(self, byte_length)
    }

    fn receipts_for_digest(
        &self,
        digest: &str,
    ) -> Result<Vec<Result<AcquisitionReceipt, uuid::Uuid>>, ReceiptStoreError> {
        ReceiptStore::receipts_for_digest(self, digest)
    }

    fn check_snapshot(
        &self,
        snapshot: &super::types::LicenseSnapshot,
    ) -> Result<SnapshotCheck, ReceiptStoreError> {
        ReceiptStore::check_snapshot(self, snapshot)
    }

    fn receipt_exists(&self, receipt_id: &uuid::Uuid) -> Result<bool, ReceiptStoreError> {
        ReceiptStore::receipt_id_exists(self, receipt_id)
    }
}

/// A lookup with no receipts at all (test wrappers for the pre-rights render suite).
#[cfg(test)]
pub struct NoReceipts;

#[cfg(test)]
impl ReceiptLookup for NoReceipts {
    fn any_receipt_with_byte_length(&self, _: u64) -> Result<bool, ReceiptStoreError> {
        Ok(false)
    }

    fn receipts_for_digest(
        &self,
        _: &str,
    ) -> Result<Vec<Result<AcquisitionReceipt, uuid::Uuid>>, ReceiptStoreError> {
        Ok(Vec::new())
    }

    fn check_snapshot(
        &self,
        _: &super::types::LicenseSnapshot,
    ) -> Result<SnapshotCheck, ReceiptStoreError> {
        Ok(SnapshotCheck::Missing)
    }

    fn receipt_exists(&self, _: &uuid::Uuid) -> Result<bool, ReceiptStoreError> {
        Ok(false)
    }
}

/// Everything the render authority passes to the gate.
#[derive(Clone, Copy)]
pub struct RenderRights<'a> {
    pub lookup: &'a dyn ReceiptLookup,
    pub now_ms: u64,
    pub freshness: Duration,
}

/// One render input as the authority sees it (asset id is absent for V1 plans).
pub struct GateInput<'a> {
    pub asset_id: Option<&'a str>,
    pub path: &'a Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateFailure {
    pub digest: String,
    pub receipt_id: Option<uuid::Uuid>,
    pub reason: ReleaseGateReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditRecord {
    pub receipt_id: uuid::Uuid,
    pub provider_id: ProviderId,
    pub provider_item_id: String,
    pub content: MediaContentIdentityV1,
    pub license: LicenseId,
    pub attribution: StructuredAttribution,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateOutcome {
    Pass { credits: Vec<CreditRecord> },
    Blocked { failures: Vec<GateFailure> },
}

pub(crate) fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        total,
    ))
}

fn check_receipt(
    rights: &RenderRights<'_>,
    receipt: &AcquisitionReceipt,
    digest: &str,
    intended_use: Option<UsePolicyProfile>,
) -> Result<(), ReleaseGateReason> {
    if receipt.content.digest != digest {
        return Err(ReleaseGateReason::ReceiptMismatch);
    }
    for snapshot in &receipt.snapshots {
        match rights.lookup.check_snapshot(snapshot) {
            Ok(SnapshotCheck::Ok) => {}
            Ok(SnapshotCheck::Missing) => return Err(ReleaseGateReason::SnapshotMissing),
            Ok(SnapshotCheck::Tampered) | Err(_) => {
                return Err(ReleaseGateReason::SnapshotTampered)
            }
        }
    }
    let age_ms = rights.now_ms.saturating_sub(receipt.last_refresh_at_ms);
    if u128::from(age_ms) > rights.freshness.as_millis() {
        return Err(ReleaseGateReason::RefreshStale);
    }
    match receipt.last_refresh_status {
        RefreshStatus::Unchanged => {}
        RefreshStatus::Changed => return Err(ReleaseGateReason::UpstreamChanged),
        RefreshStatus::Withdrawn => return Err(ReleaseGateReason::UpstreamWithdrawn),
    }
    let conflict = receipt
        .policy
        .reasons
        .contains(&PolicyReasonCode::LicenseConflict);
    // Without an export-level intended use, the use declared at acquisition applies.
    let profile = intended_use.unwrap_or(receipt.intended_use);
    if evaluate_policy(receipt.license.code, profile, conflict).outcome == PolicyOutcome::Block {
        return Err(ReleaseGateReason::UseBlocked);
    }
    if !missing_attribution_fields(receipt.license.code, &receipt.attribution).is_empty() {
        return Err(ReleaseGateReason::AttributionIncomplete);
    }
    Ok(())
}

/// Runs the gate over every input. `claimed` maps asset ids to the receipt ids
/// the project claims (advisory; a mismatch fails, an omission changes nothing).
pub fn release_gate(
    rights: &RenderRights<'_>,
    inputs: &[GateInput<'_>],
    intended_use: Option<UsePolicyProfile>,
    claimed: &BTreeMap<String, uuid::Uuid>,
) -> GateOutcome {
    let mut failures = Vec::new();
    let mut credits: BTreeMap<uuid::Uuid, CreditRecord> = BTreeMap::new();
    for input in inputs {
        let claim = input.asset_id.and_then(|id| claimed.get(id)).copied();
        let fail = |failures: &mut Vec<GateFailure>, digest: &str, receipt_id, reason| {
            failures.push(GateFailure {
                digest: digest.to_owned(),
                receipt_id,
                reason,
            })
        };
        let size = match std::fs::metadata(input.path) {
            Ok(metadata) => metadata.len(),
            Err(_) => {
                fail(&mut failures, "", claim, ReleaseGateReason::ReceiptMissing);
                continue;
            }
        };
        let maybe_remote = match rights.lookup.any_receipt_with_byte_length(size) {
            Ok(value) => value,
            Err(_) => {
                fail(&mut failures, "", claim, ReleaseGateReason::ReceiptMissing);
                continue;
            }
        };
        if !maybe_remote && claim.is_none() {
            continue; // Local import: no receipt can match this size.
        }
        let digest = match hash_file(input.path) {
            Ok((digest, length)) if length == size => digest,
            _ => {
                fail(&mut failures, "", claim, ReleaseGateReason::ReceiptMissing);
                continue;
            }
        };
        let rows = match rights.lookup.receipts_for_digest(&digest) {
            Ok(rows) => rows,
            Err(_) => {
                fail(
                    &mut failures,
                    &digest,
                    claim,
                    ReleaseGateReason::ReceiptMissing,
                );
                continue;
            }
        };
        // A claimed receipt that is not one of this content's receipts either does not
        // exist (missing) or belongs to different bytes (mismatch).
        let claim_failure = |id: &uuid::Uuid| match rights.lookup.receipt_exists(id) {
            Ok(true) => ReleaseGateReason::ReceiptMismatch,
            Ok(false) | Err(_) => ReleaseGateReason::ReceiptMissing,
        };
        if rows.is_empty() {
            if let Some(id) = claim {
                fail(&mut failures, &digest, claim, claim_failure(&id));
            }
            continue; // Local import.
        }
        if let Some(unreadable) = rows.iter().find_map(|row| row.as_ref().err()) {
            fail(
                &mut failures,
                &digest,
                Some(*unreadable),
                ReleaseGateReason::ReceiptMissing,
            );
            continue;
        }
        let receipts: Vec<&AcquisitionReceipt> =
            rows.iter().filter_map(|row| row.as_ref().ok()).collect();
        // Negative upstream evidence on any receipt for these bytes is sticky.
        if let Some(bad) = receipts
            .iter()
            .find(|r| r.last_refresh_status == RefreshStatus::Withdrawn)
        {
            fail(
                &mut failures,
                &digest,
                Some(bad.receipt_id),
                ReleaseGateReason::UpstreamWithdrawn,
            );
            continue;
        }
        if let Some(bad) = receipts
            .iter()
            .find(|r| r.last_refresh_status == RefreshStatus::Changed)
        {
            fail(
                &mut failures,
                &digest,
                Some(bad.receipt_id),
                ReleaseGateReason::UpstreamChanged,
            );
            continue;
        }
        let selected = match claim {
            Some(id) => match receipts.iter().find(|r| r.receipt_id == id) {
                Some(receipt) => *receipt,
                None => {
                    fail(&mut failures, &digest, Some(id), claim_failure(&id));
                    continue;
                }
            },
            None => match receipts.iter().max_by(|a, b| {
                a.last_refresh_at_ms
                    .cmp(&b.last_refresh_at_ms)
                    .then_with(|| a.receipt_id.cmp(&b.receipt_id))
            }) {
                Some(receipt) => *receipt,
                None => {
                    fail(
                        &mut failures,
                        &digest,
                        None,
                        ReleaseGateReason::ReceiptMissing,
                    );
                    continue;
                }
            },
        };
        match check_receipt(rights, selected, &digest, intended_use) {
            Ok(()) => {
                credits.insert(
                    selected.receipt_id,
                    CreditRecord {
                        receipt_id: selected.receipt_id,
                        provider_id: selected.provider_id,
                        provider_item_id: selected.provider_item_id.clone(),
                        content: selected.content.clone(),
                        license: selected.license.clone(),
                        attribution: selected.attribution.clone(),
                    },
                );
            }
            Err(reason) => fail(&mut failures, &digest, Some(selected.receipt_id), reason),
        }
    }
    if failures.is_empty() {
        GateOutcome::Pass {
            credits: credits.into_values().collect(),
        }
    } else {
        failures.sort_by(|a, b| {
            (a.reason.render_field(), &a.digest, a.receipt_id).cmp(&(
                b.reason.render_field(),
                &b.digest,
                b.receipt_id,
            ))
        });
        GateOutcome::Blocked { failures }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditsDocument<'a> {
    schema_version: u8,
    output_file_name: &'a str,
    credits: &'a [CreditRecord],
}

pub fn credits_sidecar_paths(output_path: &Path) -> Option<(PathBuf, PathBuf)> {
    let parent = output_path.parent()?;
    let name = output_path.file_name()?.to_str()?;
    Some((
        parent.join(format!("{name}.credits.json")),
        parent.join(format!("{name}.CREDITS.txt")),
    ))
}

fn write_atomic(parent: &Path, target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(target) {
        if !metadata.file_type().is_file() {
            return Err(std::io::Error::other(
                "sidecar target is not a regular file",
            ));
        }
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".svp-credits-")
        .suffix(".part")
        .tempfile_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(target).map_err(|error| error.error)?;
    Ok(())
}

/// Writes `<output>.credits.json` and `<output>.CREDITS.txt` next to the output.
pub fn write_credits_sidecar(
    output_path: &Path,
    credits: &[CreditRecord],
) -> std::io::Result<(PathBuf, PathBuf)> {
    let (json_path, text_path) = credits_sidecar_paths(output_path)
        .ok_or_else(|| std::io::Error::other("output path has no parent"))?;
    let parent = output_path
        .parent()
        .ok_or_else(|| std::io::Error::other("output path has no parent"))?;
    let name = output_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| std::io::Error::other("output name"))?;
    let document = CreditsDocument {
        schema_version: 1,
        output_file_name: name,
        credits,
    };
    let mut json = serde_json::to_vec_pretty(&document).map_err(std::io::Error::other)?;
    json.push(b'\n');
    let entries: Vec<CreditEntry> = credits
        .iter()
        .map(|c| CreditEntry {
            receipt_id: c.receipt_id.to_string(),
            attribution: c.attribution.clone(),
        })
        .collect();
    write_atomic(parent, &json_path, &json)?;
    write_atomic(parent, &text_path, render_credits_text(&entries).as_bytes())?;
    Ok((json_path, text_path))
}
