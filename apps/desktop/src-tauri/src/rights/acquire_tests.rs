//! Acquisition tests against a local fixture server. Logical URLs are the real
//! provider URLs; the test net policy routes them to loopback.

use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use super::*;
use crate::rights::{
    net::{NetPolicy, Secret},
    test_server::{FixtureServer, Route},
    types::{LicenseCode, ProviderId, UsePolicyProfile},
};
use crate::video::media_store::source_object_path_blocking;

const ITEM: &str = "File:Clip.webm";

fn webm_bytes() -> Vec<u8> {
    let mut bytes = vec![0x1A, 0x45, 0xDF, 0xA3];
    bytes.extend((0..4096u32).map(|i| (i % 251) as u8));
    bytes
}

fn record_json(license_short: &str, license_url: &str, download_path: &str) -> Vec<u8> {
    serde_json::json!({
        "query": { "pages": [ {
            "ns": 6,
            "title": ITEM,
            "imageinfo": [ {
                "url": format!("https://upload.wikimedia.org{download_path}"),
                "descriptionurl": "https://commons.wikimedia.org/wiki/File:Clip.webm",
                "mime": "video/webm",
                "mediatype": "VIDEO",
                "width": 640,
                "height": 360,
                "extmetadata": {
                    "ObjectName": { "value": "Clip" },
                    "Artist": { "value": "Jane Doe" },
                    "LicenseShortName": { "value": license_short },
                    "LicenseUrl": { "value": license_url }
                }
            } ]
        } ] }
    })
    .to_string()
    .into_bytes()
}

fn routes_with(record: Vec<u8>, etag: &str, media: Route) -> Vec<Route> {
    vec![
        Route::ok("/w/api.php", "application/json; charset=utf-8", record)
            .with_header("ETag", etag),
        Route::ok(
            "/wiki/File:Clip.webm",
            "text/html",
            b"<html>Clip landing</html>".to_vec(),
        ),
        Route::ok(
            "/licenses/by/4.0/",
            "text/html",
            b"<html>CC BY 4.0 deed</html>".to_vec(),
        ),
        Route::ok(
            "/licenses/by-nc/4.0/",
            "text/html",
            b"<html>CC BY-NC 4.0 deed</html>".to_vec(),
        ),
        media,
    ]
}

fn default_routes() -> Vec<Route> {
    routes_with(
        record_json(
            "CC BY 4.0",
            "https://creativecommons.org/licenses/by/4.0/",
            "/media/clip.webm",
        ),
        "\"v1\"",
        Route::ok("/media/clip.webm", "video/webm", webm_bytes()),
    )
}

struct NoKeys;
impl ProviderKeyStore for NoKeys {
    fn key(&self, _: ProviderId) -> Option<Secret> {
        None
    }
}

struct Verifier(Result<(), &'static str>);
impl MediaVerifier for Verifier {
    fn verify(&self, path: &Path, _: MediaKind, _: &CancelToken) -> Result<(), &'static str> {
        assert!(path.exists(), "verifier sees the quarantined file");
        self.0
    }
}

struct Harness {
    server: FixtureServer,
    cache: tempfile::TempDir,
    store: ReceiptStore,
    endpoints: ProviderEndpoints,
}

impl Harness {
    fn new(routes: Vec<Route>) -> Self {
        let server = FixtureServer::start(routes);
        let cache = tempfile::tempdir().expect("cache");
        let store = ReceiptStore::open(&cache.path().join("rights")).expect("store");
        Self {
            server,
            cache,
            store,
            endpoints: ProviderEndpoints::production(),
        }
    }

    fn run_with(
        &self,
        use_profile: UsePolicyProfile,
        limits: FetchLimits,
        verifier: &dyn MediaVerifier,
        on_stage: &dyn Fn(AcquireStage),
        cancel: CancelToken,
    ) -> Result<AcquireOutcome, AcquireError> {
        let base = self.server.base().to_owned();
        let policy = move |id: ProviderId| NetPolicy::routed_for_tests(id, &base);
        let ctx = AcquireContext {
            endpoints: &self.endpoints,
            keys: &NoKeys,
            store: &self.store,
            app_cache_root: self.cache.path(),
            net_policy: &policy,
            verifier,
            now_ms: &|| 1_700_000_000_000,
            media_limits: limits,
            cancel,
            on_stage,
        };
        acquire(
            &ctx,
            &AcquireRequest {
                provider_id: ProviderId::WikimediaCommons,
                provider_item_id: ITEM.into(),
                intended_use: use_profile,
                project_id: uuid::Uuid::from_u128(42),
            },
        )
    }

    fn run(&self) -> Result<AcquireOutcome, AcquireError> {
        self.run_with(
            UsePolicyProfile::CommercialOnline,
            FetchLimits::MEDIA,
            &Verifier(Ok(())),
            &|_| {},
            CancelToken::new(),
        )
    }

    fn quarantine_files(&self) -> Vec<PathBuf> {
        let dir = quarantine_directory_blocking(self.cache.path()).expect("quarantine dir");
        std::fs::read_dir(dir)
            .expect("read")
            .flatten()
            .map(|e| e.path())
            .collect()
    }

    fn object_exists(&self, digest: &str) -> bool {
        source_object_path_blocking(self.cache.path(), digest)
            .expect("path")
            .exists()
    }

    /// No orphan quarantine files, snapshots, objects or receipts.
    fn assert_clean(&self) {
        assert_eq!(
            self.quarantine_files(),
            Vec::<PathBuf>::new(),
            "quarantine is empty"
        );
        assert_eq!(self.store.receipt_count().expect("count"), 0, "no receipt");
        assert_eq!(
            self.store.snapshot_blob_count().expect("count"),
            0,
            "no snapshot"
        );
        assert!(
            !self.object_exists(&crate::rights::store::sha256_hex(&webm_bytes())),
            "no promoted object"
        );
    }

    fn media_requested(&self) -> bool {
        self.server
            .requests()
            .iter()
            .any(|r| r.starts_with("GET /media/"))
    }
}

#[test]
fn acquires_verifies_promotes_and_commits_receipt() {
    let h = Harness::new(default_routes());
    let outcome = h.run().expect("acquire");
    let receipt = &outcome.receipt;
    assert_eq!(
        receipt.content.digest,
        crate::rights::store::sha256_hex(&webm_bytes())
    );
    assert_eq!(receipt.content.byte_length, webm_bytes().len() as u64);
    assert_eq!(receipt.license.code, LicenseCode::By);
    assert_eq!(receipt.policy.outcome, PolicyOutcome::Allow);
    assert_eq!(receipt.media_type, "video/webm");
    assert_eq!(receipt.etag.as_deref(), Some("\"v1\""));
    assert_eq!(receipt.attribution.creator.as_deref(), Some("Jane Doe"));
    let kinds: Vec<SnapshotKind> = receipt.snapshots.iter().map(|s| s.kind).collect();
    assert_eq!(
        kinds,
        [
            SnapshotKind::ApiRecord,
            SnapshotKind::LandingPage,
            SnapshotKind::LicensePage
        ]
    );
    assert!(receipt
        .snapshots
        .iter()
        .all(|s| s.url.starts_with("https://")));
    assert!(h.object_exists(&receipt.content.digest));
    assert_eq!(
        outcome.object_path,
        source_object_path_blocking(h.cache.path(), &receipt.content.digest).unwrap()
    );
    assert_eq!(
        h.store.receipt(&receipt.receipt_id).expect("read").as_ref(),
        Some(receipt)
    );
    assert!(h.quarantine_files().is_empty());
}

#[test]
fn redirect_off_the_allowlist_is_refused_and_leaves_nothing() {
    let h = Harness::new(routes_with(
        record_json(
            "CC BY 4.0",
            "https://creativecommons.org/licenses/by/4.0/",
            "/media/clip.webm",
        ),
        "\"v1\"",
        Route::redirect("/media/clip.webm", "https://evil.example/clip.webm"),
    ));
    let error = h.run().expect_err("refused");
    assert_eq!(
        error,
        AcquireError::Net {
            stage: AcquireStage::Download,
            error: NetError::HostNotAllowed {
                host: "evil.example".into()
            }
        }
    );
    h.assert_clean();
}

#[test]
fn traversal_item_ids_are_rejected_before_any_request() {
    let h = Harness::new(default_routes());
    for bad in ["File:../../etc/passwd", "File:a/b", "File:..\\x", " File:x"] {
        let base = h.server.base().to_owned();
        let policy = move |id: ProviderId| NetPolicy::routed_for_tests(id, &base);
        let ctx = AcquireContext {
            endpoints: &h.endpoints,
            keys: &NoKeys,
            store: &h.store,
            app_cache_root: h.cache.path(),
            net_policy: &policy,
            verifier: &Verifier(Ok(())),
            now_ms: &|| 1,
            media_limits: FetchLimits::MEDIA,
            cancel: CancelToken::new(),
            on_stage: &|_| {},
        };
        let request = AcquireRequest {
            provider_id: ProviderId::WikimediaCommons,
            provider_item_id: bad.into(),
            intended_use: UsePolicyProfile::PrivatePreview,
            project_id: uuid::Uuid::from_u128(1),
        };
        assert_eq!(
            acquire(&ctx, &request),
            Err(AcquireError::InvalidRequest),
            "{bad}"
        );
    }
    assert_eq!(h.server.hits(), 0);
    h.assert_clean();
}

#[test]
fn download_url_path_traversal_cannot_escape_into_other_content() {
    // `..` segments normalize to the API path; the JSON served there is not media.
    let h = Harness::new(routes_with(
        record_json(
            "CC BY 4.0",
            "https://creativecommons.org/licenses/by/4.0/",
            "/media/../w/api.php",
        ),
        "\"v1\"",
        Route::ok("/media/clip.webm", "video/webm", webm_bytes()),
    ));
    assert_eq!(h.run().expect_err("rejected"), AcquireError::MimeMismatch);
    h.assert_clean();
}

#[test]
fn oversized_downloads_are_refused() {
    let h = Harness::new(default_routes());
    let limits = FetchLimits {
        max_bytes: 1024,
        ..FetchLimits::MEDIA
    };
    let error = h
        .run_with(
            UsePolicyProfile::CommercialOnline,
            limits,
            &Verifier(Ok(())),
            &|_| {},
            CancelToken::new(),
        )
        .expect_err("too large");
    assert!(matches!(
        error,
        AcquireError::Net {
            stage: AcquireStage::Download,
            error: NetError::TooLarge { limit: 1024 }
        }
    ));
    h.assert_clean();

    // Chunked responses without Content-Length are capped while streaming.
    let chunked = Harness::new(routes_with(
        record_json(
            "CC BY 4.0",
            "https://creativecommons.org/licenses/by/4.0/",
            "/media/clip.webm",
        ),
        "\"v1\"",
        Route::ok("/media/clip.webm", "video/webm", webm_bytes()).chunked(),
    ));
    let error = chunked
        .run_with(
            UsePolicyProfile::CommercialOnline,
            limits,
            &Verifier(Ok(())),
            &|_| {},
            CancelToken::new(),
        )
        .expect_err("too large");
    assert!(matches!(
        error,
        AcquireError::Net {
            error: NetError::TooLarge { .. },
            ..
        }
    ));
    chunked.assert_clean();
}

#[test]
fn mime_mismatches_are_refused() {
    let png = {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend([0u8; 64]);
        b
    };
    for media in [
        Route::ok("/media/clip.webm", "video/webm", png),
        Route::ok("/media/clip.webm", "image/png", webm_bytes()),
        Route::ok(
            "/media/clip.webm",
            "video/webm",
            b"#!/bin/sh\necho hi".to_vec(),
        ),
    ] {
        let h = Harness::new(routes_with(
            record_json(
                "CC BY 4.0",
                "https://creativecommons.org/licenses/by/4.0/",
                "/media/clip.webm",
            ),
            "\"v1\"",
            media,
        ));
        assert_eq!(h.run().expect_err("mismatch"), AcquireError::MimeMismatch);
        h.assert_clean();
    }
}

#[test]
fn probe_failure_discards_the_download() {
    let h = Harness::new(default_routes());
    let error = h
        .run_with(
            UsePolicyProfile::CommercialOnline,
            FetchLimits::MEDIA,
            &Verifier(Err("unsupported_metadata")),
            &|_| {},
            CancelToken::new(),
        )
        .expect_err("probe");
    assert_eq!(error, AcquireError::ProbeFailed("unsupported_metadata"));
    h.assert_clean();
}

#[test]
fn interrupted_downloads_leave_nothing() {
    let h = Harness::new(routes_with(
        record_json(
            "CC BY 4.0",
            "https://creativecommons.org/licenses/by/4.0/",
            "/media/clip.webm",
        ),
        "\"v1\"",
        Route::truncated(
            "/media/clip.webm",
            "video/webm",
            10_000,
            webm_bytes()[..100].to_vec(),
        ),
    ));
    let error = h.run().expect_err("interrupted");
    assert!(
        matches!(
            error,
            AcquireError::Net {
                stage: AcquireStage::Download,
                ..
            }
        ),
        "{error:?}"
    );
    h.assert_clean();
}

#[test]
fn etag_change_during_download_aborts_before_promotion() {
    let h = Harness::new(default_routes());
    let server = &h.server;
    let on_stage = |stage: AcquireStage| {
        if stage == AcquireStage::Reverify {
            server.set_routes(routes_with(
                record_json(
                    "CC BY 4.0",
                    "https://creativecommons.org/licenses/by/4.0/",
                    "/media/clip.webm",
                ),
                "\"v2\"",
                Route::ok("/media/clip.webm", "video/webm", webm_bytes()),
            ));
        }
    };
    let error = h
        .run_with(
            UsePolicyProfile::CommercialOnline,
            FetchLimits::MEDIA,
            &Verifier(Ok(())),
            &on_stage,
            CancelToken::new(),
        )
        .expect_err("changed");
    assert_eq!(error, AcquireError::UpstreamChanged);
    h.assert_clean();
}

#[test]
fn license_change_or_withdrawal_during_download_aborts() {
    for replacement in [
        routes_with(
            record_json(
                "CC BY-NC 4.0",
                "https://creativecommons.org/licenses/by-nc/4.0/",
                "/media/clip.webm",
            ),
            "\"v1\"",
            Route::ok("/media/clip.webm", "video/webm", webm_bytes()),
        ),
        vec![Route::status("/w/api.php", 410)],
    ] {
        let h = Harness::new(default_routes());
        let server = &h.server;
        let replacement = RefCell::new(Some(replacement));
        let on_stage = |stage: AcquireStage| {
            if stage == AcquireStage::Reverify {
                if let Some(routes) = replacement.borrow_mut().take() {
                    server.set_routes(routes);
                }
            }
        };
        let error = h
            .run_with(
                UsePolicyProfile::PrivatePreview,
                FetchLimits::MEDIA,
                &Verifier(Ok(())),
                &on_stage,
                CancelToken::new(),
            )
            .expect_err("changed");
        assert!(
            matches!(
                error,
                AcquireError::UpstreamChanged | AcquireError::Withdrawn
            ),
            "{error:?}"
        );
        h.assert_clean();
    }
}

#[test]
fn blocked_policy_downloads_no_bytes_and_writes_no_receipt() {
    let h = Harness::new(routes_with(
        record_json(
            "CC BY-NC 4.0",
            "https://creativecommons.org/licenses/by-nc/4.0/",
            "/media/clip.webm",
        ),
        "\"v1\"",
        Route::ok("/media/clip.webm", "video/webm", webm_bytes()),
    ));
    let error = h.run().expect_err("blocked");
    match error {
        AcquireError::PolicyBlocked(decision) => {
            assert_eq!(decision.outcome, PolicyOutcome::Block);
        }
        other => panic!("unexpected {other:?}"),
    }
    assert!(!h.media_requested(), "no media bytes were requested");
    h.assert_clean();
}

#[test]
fn withdrawn_items_are_refused_up_front() {
    let h = Harness::new(vec![Route::status("/w/api.php", 404)]);
    assert_eq!(h.run().expect_err("withdrawn"), AcquireError::Withdrawn);
    h.assert_clean();
}

#[test]
fn cancellation_at_every_stage_leaves_nothing_behind() {
    for target in [
        AcquireStage::FetchMetadata,
        AcquireStage::Snapshot,
        AcquireStage::Policy,
        AcquireStage::Download,
        AcquireStage::Validate,
        AcquireStage::Reverify,
        AcquireStage::Promote,
        AcquireStage::Commit,
    ] {
        let h = Harness::new(default_routes());
        let cancel = CancelToken::new();
        let hook_cancel = cancel.clone();
        let seen = RefCell::new(Vec::new());
        let on_stage = |stage: AcquireStage| {
            seen.borrow_mut().push(stage);
            if stage == target {
                hook_cancel.cancel();
            }
        };
        let error = h
            .run_with(
                UsePolicyProfile::CommercialOnline,
                FetchLimits::MEDIA,
                &Verifier(Ok(())),
                &on_stage,
                cancel,
            )
            .expect_err("cancelled");
        assert_eq!(error, AcquireError::Cancelled, "stage {target:?}");
        assert!(
            seen.borrow().contains(&target),
            "stage {target:?} was reached"
        );
        h.assert_clean();
    }
}

#[test]
fn failed_receipt_commit_removes_the_newly_promoted_object() {
    let h = Harness::new(default_routes());
    h.store.fail_next_commit();
    let error = h.run().expect_err("commit fails");
    assert!(matches!(error, AcquireError::Store(_)));
    h.assert_clean();
}

#[test]
fn failed_commit_keeps_an_object_that_already_existed() {
    let h = Harness::new(default_routes());
    // First acquisition succeeds and owns the object.
    let first = h.run().expect("first");
    // Second acquisition of identical bytes fails at commit; the shared object must survive.
    h.store.fail_next_commit();
    assert!(matches!(h.run(), Err(AcquireError::Store(_))));
    assert!(h.object_exists(&first.receipt.content.digest));
    assert_eq!(h.store.receipt_count().unwrap(), 1);
    assert!(h.quarantine_files().is_empty());
}

#[test]
fn startup_sweep_removes_stale_quarantine_only() {
    let h = Harness::new(default_routes());
    let dir = quarantine_directory_blocking(h.cache.path()).expect("dir");
    let stale = dir.join(format!("{QUARANTINE_PREFIX}stale.part"));
    let unrelated = dir.join("keep.txt");
    std::fs::write(&stale, b"partial").unwrap();
    std::fs::write(&unrelated, b"x").unwrap();

    let (files, blobs) = startup_sweep(
        h.cache.path(),
        &h.store,
        SystemTime::now(),
        QUARANTINE_MAX_AGE,
    )
    .expect("sweep");
    assert_eq!((files, blobs), (0, 0), "fresh files are kept");
    assert!(stale.exists());

    let later = SystemTime::now() + Duration::from_secs(2 * 60 * 60);
    let (files, _) =
        startup_sweep(h.cache.path(), &h.store, later, QUARANTINE_MAX_AGE).expect("sweep");
    assert_eq!(files, 1);
    assert!(!stale.exists());
    assert!(
        unrelated.exists(),
        "only quarantine-prefixed files are swept"
    );
}

#[test]
fn sniffing_table() {
    let cases: [(&[u8], Option<&str>); 8] = [
        (&[0x1A, 0x45, 0xDF, 0xA3, 0], Some("video/webm")),
        (b"\0\0\0\x18ftypmp42", Some("video/mp4")),
        (b"\0\0\0\x18ftypM4A ", Some("audio/mp4")),
        (b"OggS\0", Some("application/ogg")),
        (&[0xFF, 0xD8, 0xFF, 0xE0], Some("image/jpeg")),
        (b"ID3\x04", Some("audio/mpeg")),
        (b"fLaC", Some("audio/flac")),
        (b"<html>", None),
    ];
    for (head, expected) in cases {
        assert_eq!(sniff_media_type(head), expected);
    }
}
