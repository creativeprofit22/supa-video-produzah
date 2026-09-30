//! Refresh: re-fetch the authoritative record and compare it with the receipt.
//! A different ETag, license or download target is `changed`; a 404/410 or an
//! empty/missing record is `withdrawn`. Transport failures record nothing, so a
//! flaky network can never refresh evidence (the gate's freshness window then
//! blocks once the last successful refresh is too old).

use super::{
    acquire::{fetch_record, AcquireError},
    net::{CancelToken, NetPolicy, ProviderKeyStore},
    providers::{self, ItemParse, ProviderEndpoints},
    store::{ReceiptStore, ReceiptStoreError, SnapshotBlob},
    types::{AcquisitionReceipt, RefreshStatus, SnapshotKind},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshError {
    NotFound,
    Acquire(AcquireError),
    Store(&'static str),
}

impl RefreshError {
    pub fn code(&self) -> &'static str {
        match self {
            RefreshError::NotFound => "receipt_not_found",
            RefreshError::Acquire(error) => error.code(),
            RefreshError::Store(_) => "store_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            RefreshError::NotFound => "No rights receipt has that id.".into(),
            RefreshError::Acquire(error) => error.message(),
            RefreshError::Store(_) => "The rights receipt could not be updated.".into(),
        }
    }
}

impl From<ReceiptStoreError> for RefreshError {
    fn from(error: ReceiptStoreError) -> Self {
        match error {
            ReceiptStoreError::NotFound => RefreshError::NotFound,
            _ => RefreshError::Store("receipt"),
        }
    }
}

pub struct RefreshContext<'a> {
    pub endpoints: &'a ProviderEndpoints,
    pub keys: &'a dyn ProviderKeyStore,
    pub store: &'a ReceiptStore,
    pub net_policy: &'a dyn Fn(super::types::ProviderId) -> NetPolicy,
    pub now_ms: u64,
    pub cancel: CancelToken,
}

pub fn refresh_receipt(
    ctx: &RefreshContext<'_>,
    receipt_id: &uuid::Uuid,
) -> Result<AcquisitionReceipt, RefreshError> {
    let receipt = ctx
        .store
        .receipt(receipt_id)?
        .ok_or(RefreshError::NotFound)?;
    let policy = (ctx.net_policy)(receipt.provider_id);
    let record = fetch_record(
        ctx.endpoints,
        ctx.keys,
        &policy,
        receipt.provider_id,
        &receipt.provider_item_id,
        &ctx.cancel,
    )
    .map_err(RefreshError::Acquire)?;
    let (status, snapshot) = match &record.parsed {
        ItemParse::Withdrawn => (RefreshStatus::Withdrawn, None),
        ItemParse::Found(item) => {
            let rights = providers::normalize_item(item);
            let etag_changed = matches!(
                (&receipt.etag, &record.meta.etag),
                (Some(before), Some(now)) if before != now
            );
            let rights_changed = rights.license != receipt.license
                || rights.item_license != receipt.item_license
                || rights.collection_license != receipt.collection_license
                || rights.attribution != receipt.attribution;
            let status = if etag_changed || rights_changed {
                RefreshStatus::Changed
            } else {
                RefreshStatus::Unchanged
            };
            let blob = SnapshotBlob::new(
                SnapshotKind::ApiRecord,
                record.meta.final_url.clone(),
                record
                    .meta
                    .content_type
                    .clone()
                    .unwrap_or_else(|| "application/octet-stream".into()),
                ctx.now_ms,
                record.bytes.clone(),
            );
            (status, Some(blob))
        }
    };
    Ok(ctx
        .store
        .record_refresh(receipt_id, ctx.now_ms, status, snapshot.as_ref())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rights::{
        net::Secret,
        store::tests::{sample_blobs, sample_receipt},
        test_server::{FixtureServer, Route},
        types::ProviderId,
    };

    struct NoKeys;
    impl ProviderKeyStore for NoKeys {
        fn key(&self, _: ProviderId) -> Option<Secret> {
            None
        }
    }

    fn record(license_short: &str, license_url: &str) -> Vec<u8> {
        serde_json::json!({
            "query": { "pages": [ {
                "ns": 6,
                "title": "File:Example.webm",
                "imageinfo": [ {
                    "url": "https://upload.wikimedia.org/a/Example.webm",
                    "descriptionurl": "https://commons.wikimedia.org/wiki/File:Example.webm",
                    "mediatype": "VIDEO",
                    "extmetadata": {
                        "ObjectName": { "value": "Example" },
                        "Artist": { "value": "Jane" },
                        "LicenseShortName": { "value": license_short },
                        "LicenseUrl": { "value": license_url }
                    }
                } ]
            } ] }
        })
        .to_string()
        .into_bytes()
    }

    fn run(
        routes: Vec<Route>,
        stored_etag: Option<&str>,
    ) -> (RefreshStatus, ReceiptStore, tempfile::TempDir) {
        let server = FixtureServer::start(routes);
        let dir = tempfile::tempdir().expect("dir");
        let store = ReceiptStore::open(dir.path()).expect("store");
        let blobs = sample_blobs("a");
        let mut receipt = sample_receipt(&"ab".repeat(32), &blobs);
        receipt.etag = stored_etag.map(str::to_owned);
        store.commit_receipt(&receipt, &blobs).expect("commit");
        let base = server.base().to_owned();
        let policy = move |id: ProviderId| NetPolicy::routed_for_tests(id, &base);
        let ctx = RefreshContext {
            endpoints: &ProviderEndpoints::production(),
            keys: &NoKeys,
            store: &store,
            net_policy: &policy,
            now_ms: 5_000,
            cancel: CancelToken::new(),
        };
        let updated = refresh_receipt(&ctx, &receipt.receipt_id).expect("refresh");
        assert_eq!(updated.last_refresh_at_ms, 5_000);
        (updated.last_refresh_status, store, dir)
    }

    const BY: (&str, &str) = ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/");

    #[test]
    fn same_record_is_unchanged_and_snapshotted() {
        let (status, store, _dir) = run(
            vec![
                Route::ok("/w/api.php", "application/json", record(BY.0, BY.1))
                    .with_header("ETag", "\"v1\""),
            ],
            Some("\"v1\""),
        );
        assert_eq!(status, RefreshStatus::Unchanged);
        assert_eq!(
            store.snapshot_blob_count().expect("count"),
            3,
            "refresh snapshot kept"
        );
    }

    #[test]
    fn different_etag_is_changed() {
        let (status, ..) = run(
            vec![
                Route::ok("/w/api.php", "application/json", record(BY.0, BY.1))
                    .with_header("ETag", "\"v2\""),
            ],
            Some("\"v1\""),
        );
        assert_eq!(status, RefreshStatus::Changed);
    }

    #[test]
    fn different_license_is_changed() {
        let (status, ..) = run(
            vec![Route::ok(
                "/w/api.php",
                "application/json",
                record(
                    "CC BY-NC 4.0",
                    "https://creativecommons.org/licenses/by-nc/4.0/",
                ),
            )],
            None,
        );
        assert_eq!(status, RefreshStatus::Changed);
    }

    #[test]
    fn http_404_and_410_and_missing_pages_are_withdrawn() {
        for route in [
            Route::status("/w/api.php", 404),
            Route::status("/w/api.php", 410),
            Route::ok(
                "/w/api.php",
                "application/json",
                br#"{"query":{"pages":[{"ns":6,"title":"File:Example.webm","missing":true}]}}"#
                    .to_vec(),
            ),
        ] {
            let (status, ..) = run(vec![route], None);
            assert_eq!(status, RefreshStatus::Withdrawn);
        }
    }

    #[test]
    fn transport_failures_record_nothing() {
        let server = FixtureServer::start(vec![Route::status("/w/api.php", 503)]);
        let dir = tempfile::tempdir().expect("dir");
        let store = ReceiptStore::open(dir.path()).expect("store");
        let blobs = sample_blobs("a");
        let receipt = sample_receipt(&"ab".repeat(32), &blobs);
        store.commit_receipt(&receipt, &blobs).expect("commit");
        let base = server.base().to_owned();
        let policy = move |id: ProviderId| NetPolicy::routed_for_tests(id, &base);
        let ctx = RefreshContext {
            endpoints: &ProviderEndpoints::production(),
            keys: &NoKeys,
            store: &store,
            net_policy: &policy,
            now_ms: 5_000,
            cancel: CancelToken::new(),
        };
        assert!(refresh_receipt(&ctx, &receipt.receipt_id).is_err());
        let after = store
            .receipt(&receipt.receipt_id)
            .expect("read")
            .expect("exists");
        assert_eq!(after.last_refresh_at_ms, receipt.last_refresh_at_ms);
        assert!(store
            .refresh_history(&receipt.receipt_id)
            .expect("history")
            .is_empty());
    }

    #[test]
    fn unknown_receipt_is_not_found() {
        let dir = tempfile::tempdir().expect("dir");
        let store = ReceiptStore::open(dir.path()).expect("store");
        let policy = |id: ProviderId| NetPolicy::for_provider(id);
        let ctx = RefreshContext {
            endpoints: &ProviderEndpoints::production(),
            keys: &NoKeys,
            store: &store,
            net_policy: &policy,
            now_ms: 1,
            cancel: CancelToken::new(),
        };
        assert_eq!(
            refresh_receipt(&ctx, &uuid::Uuid::new_v4()),
            Err(RefreshError::NotFound)
        );
    }
}
