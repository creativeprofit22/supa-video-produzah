use super::*;
use crate::rights::types::{
    LicenseCode, LicenseId, MediaKind, PolicyDecision, PolicyOutcome, PolicyReasonCode, ProviderId,
    StructuredAttribution, UsePolicyProfile,
};
use crate::video::media_store::{MediaContentAlgorithm, MediaContentIdentityV1};

pub(crate) fn sample_blobs(seed: &str) -> Vec<SnapshotBlob> {
    vec![
        SnapshotBlob::new(
            SnapshotKind::ApiRecord,
            "https://commons.wikimedia.org/w/api.php?action=query".into(),
            "application/json".into(),
            1_000,
            format!("{{\"record\":\"{seed}\"}}").into_bytes(),
        ),
        SnapshotBlob::new(
            SnapshotKind::LicensePage,
            "https://creativecommons.org/licenses/by/4.0/".into(),
            "text/html".into(),
            1_000,
            b"<html>CC BY 4.0</html>".to_vec(),
        ),
    ]
}

pub(crate) fn sample_receipt(digest: &str, blobs: &[SnapshotBlob]) -> AcquisitionReceipt {
    let license = LicenseId {
        code: LicenseCode::By,
        version: Some("4.0".into()),
        url: Some("https://creativecommons.org/licenses/by/4.0/".into()),
    };
    AcquisitionReceipt {
        schema_version: 1,
        receipt_id: uuid::Uuid::new_v4(),
        provider_id: ProviderId::WikimediaCommons,
        provider_item_id: "File:Example.webm".into(),
        project_id: uuid::Uuid::from_u128(7),
        intended_use: UsePolicyProfile::CommercialOnline,
        media_kind: MediaKind::Video,
        media_type: "video/webm".into(),
        content: MediaContentIdentityV1 {
            schema_version: 1,
            algorithm: MediaContentAlgorithm::Sha256,
            digest: digest.into(),
            byte_length: 10,
        },
        license: license.clone(),
        item_license: license,
        collection_license: None,
        policy: PolicyDecision {
            outcome: PolicyOutcome::Allow,
            reasons: vec![PolicyReasonCode::AttributionRequired],
        },
        attribution: StructuredAttribution {
            title: Some("Example".into()),
            creator: Some("Jane".into()),
            creator_url: None,
            source_url: Some("https://commons.wikimedia.org/wiki/File:Example.webm".into()),
            provider_name: "Wikimedia Commons".into(),
            license_name: "CC BY 4.0".into(),
            license_url: Some("https://creativecommons.org/licenses/by/4.0/".into()),
        },
        snapshots: blobs.iter().map(|b| b.meta.clone()).collect(),
        etag: Some("\"v1\"".into()),
        acquired_at_ms: 1_000,
        last_refresh_at_ms: 1_000,
        last_refresh_status: RefreshStatus::Unchanged,
    }
}

fn digest(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

#[test]
fn commit_then_lookup_by_id_and_digest() {
    let dir = tempfile::tempdir().expect("dir");
    let store = ReceiptStore::open(dir.path()).expect("open");
    let blobs = sample_blobs("a");
    let receipt = sample_receipt(&digest(1), &blobs);
    store.commit_receipt(&receipt, &blobs).expect("commit");

    assert_eq!(
        store.receipt(&receipt.receipt_id).expect("read"),
        Some(receipt.clone())
    );
    let by_digest = store.receipts_for_digest(&digest(1)).expect("by digest");
    assert_eq!(by_digest, vec![Ok(receipt.clone())]);
    assert_eq!(
        store.receipt_count_for_digest(&digest(2)).expect("count"),
        0
    );
    for snapshot in &receipt.snapshots {
        assert_eq!(
            store.check_snapshot(snapshot).expect("check"),
            SnapshotCheck::Ok
        );
    }
    // Reopen: schema persists.
    let reopened = ReceiptStore::open(dir.path()).expect("reopen");
    assert_eq!(reopened.receipt_count().expect("count"), 1);
}

#[test]
fn snapshot_blobs_are_immutable_and_content_addressed() {
    let dir = tempfile::tempdir().expect("dir");
    let store = ReceiptStore::open(dir.path()).expect("open");
    let blobs = sample_blobs("a");
    let first = sample_receipt(&digest(1), &blobs);
    let second = sample_receipt(&digest(1), &blobs);
    store.commit_receipt(&first, &blobs).expect("commit first");
    store
        .commit_receipt(&second, &blobs)
        .expect("commit second shares blobs");
    assert_eq!(
        store.snapshot_blob_count().expect("count"),
        2,
        "identical bytes dedupe"
    );

    let error = store
        .raw_connection()
        .execute("UPDATE snapshot_blobs SET bytes = x'00'", [])
        .expect_err("update is refused");
    assert!(error.to_string().contains("immutable"));
}

#[test]
fn mismatched_blob_hash_or_metadata_is_refused_and_nothing_is_written() {
    let dir = tempfile::tempdir().expect("dir");
    let store = ReceiptStore::open(dir.path()).expect("open");
    let mut blobs = sample_blobs("a");
    let receipt = sample_receipt(&digest(1), &blobs);
    blobs[0].bytes.push(b'!');
    assert!(matches!(
        store.commit_receipt(&receipt, &blobs),
        Err(ReceiptStoreError::ReceiptInconsistent | ReceiptStoreError::SnapshotDigestMismatch)
    ));
    let other = sample_blobs("b");
    assert!(matches!(
        store.commit_receipt(&receipt, &other),
        Err(ReceiptStoreError::ReceiptInconsistent)
    ));
    assert_eq!(store.receipt_count().expect("count"), 0);
    assert_eq!(store.snapshot_blob_count().expect("count"), 0);
}

#[test]
fn failed_commit_rolls_back_blobs_and_receipt_together() {
    let dir = tempfile::tempdir().expect("dir");
    let store = ReceiptStore::open(dir.path()).expect("open");
    let blobs = sample_blobs("a");
    let receipt = sample_receipt(&digest(1), &blobs);
    store.fail_next_commit();
    assert!(matches!(
        store.commit_receipt(&receipt, &blobs),
        Err(ReceiptStoreError::InjectedFailure)
    ));
    assert_eq!(store.receipt_count().expect("count"), 0);
    assert_eq!(store.snapshot_blob_count().expect("count"), 0);
}

#[test]
fn tampered_and_missing_snapshots_are_detected() {
    let dir = tempfile::tempdir().expect("dir");
    let store = ReceiptStore::open(dir.path()).expect("open");
    let blobs = sample_blobs("a");
    let receipt = sample_receipt(&digest(1), &blobs);
    store.commit_receipt(&receipt, &blobs).expect("commit");
    let connection = store.raw_connection();
    connection
        .execute_batch("DROP TRIGGER snapshot_blobs_immutable; PRAGMA foreign_keys = OFF;")
        .expect("attacker bypass");
    connection
        .execute(
            "UPDATE snapshot_blobs SET bytes = x'00' WHERE digest = ?1",
            [&receipt.snapshots[0].digest],
        )
        .expect("tamper");
    connection
        .execute(
            "DELETE FROM snapshot_blobs WHERE digest = ?1",
            [&receipt.snapshots[1].digest],
        )
        .expect("delete");
    assert_eq!(
        store.check_snapshot(&receipt.snapshots[0]).expect("check"),
        SnapshotCheck::Tampered
    );
    assert_eq!(
        store.check_snapshot(&receipt.snapshots[1]).expect("check"),
        SnapshotCheck::Missing
    );
}

#[test]
fn corrupt_receipt_rows_surface_as_unreadable() {
    let dir = tempfile::tempdir().expect("dir");
    let store = ReceiptStore::open(dir.path()).expect("open");
    let blobs = sample_blobs("a");
    let receipt = sample_receipt(&digest(1), &blobs);
    store.commit_receipt(&receipt, &blobs).expect("commit");
    store
        .raw_connection()
        .execute("UPDATE receipts SET receipt_json = '{\"bad\":1}'", [])
        .expect("corrupt");
    assert_eq!(
        store.receipts_for_digest(&digest(1)).expect("rows"),
        vec![Err(receipt.receipt_id)]
    );
    assert_eq!(
        store.receipt_count_for_digest(&digest(1)).expect("count"),
        1
    );
}

#[test]
fn refresh_is_sticky_for_changed_and_withdrawn_and_keeps_history() {
    let dir = tempfile::tempdir().expect("dir");
    let store = ReceiptStore::open(dir.path()).expect("open");
    let blobs = sample_blobs("a");
    let receipt = sample_receipt(&digest(1), &blobs);
    store.commit_receipt(&receipt, &blobs).expect("commit");
    let refreshed = SnapshotBlob::new(
        SnapshotKind::ApiRecord,
        "https://commons.wikimedia.org/w/api.php".into(),
        "application/json".into(),
        2_000,
        b"{}".to_vec(),
    );
    let updated = store
        .record_refresh(
            &receipt.receipt_id,
            2_000,
            RefreshStatus::Withdrawn,
            Some(&refreshed),
        )
        .expect("refresh");
    assert_eq!(updated.last_refresh_status, RefreshStatus::Withdrawn);
    assert_eq!(
        updated.snapshots, receipt.snapshots,
        "acquisition evidence is unchanged"
    );
    let later = store
        .record_refresh(&receipt.receipt_id, 3_000, RefreshStatus::Unchanged, None)
        .expect("refresh");
    assert_eq!(later.last_refresh_status, RefreshStatus::Withdrawn);
    assert_eq!(later.last_refresh_at_ms, 3_000);
    let history = store.refresh_history(&receipt.receipt_id).expect("history");
    assert_eq!(history.len(), 2);
    assert_eq!(
        history[0].snapshot_digest.as_deref(),
        Some(refreshed.meta.digest.as_str())
    );
    assert_eq!(store.sweep_unreferenced_snapshots().expect("sweep"), 0);
}

#[test]
fn sweep_removes_only_unreferenced_blobs() {
    let dir = tempfile::tempdir().expect("dir");
    let store = ReceiptStore::open(dir.path()).expect("open");
    let blobs = sample_blobs("a");
    let receipt = sample_receipt(&digest(1), &blobs);
    store.commit_receipt(&receipt, &blobs).expect("commit");
    store
        .raw_connection()
        .execute(
            "INSERT INTO snapshot_blobs (digest, byte_length, bytes) VALUES (?1, 1, x'00')",
            [digest(9)],
        )
        .expect("orphan");
    assert_eq!(store.sweep_unreferenced_snapshots().expect("sweep"), 1);
    assert_eq!(store.snapshot_blob_count().expect("count"), 2);
}

#[test]
fn foreign_database_is_refused() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join(DATABASE_FILENAME);
    let connection = Connection::open(&path).expect("create");
    connection
        .pragma_update(None, "application_id", 42_i64)
        .expect("app id");
    drop(connection);
    assert!(matches!(
        ReceiptStore::open(dir.path()),
        Err(ReceiptStoreError::ForeignDatabase)
    ));
}
