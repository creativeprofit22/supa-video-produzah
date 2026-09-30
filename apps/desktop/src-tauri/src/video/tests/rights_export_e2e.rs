//! Scripted real-app run for Phase 7, against a local fixture provider:
//! search → acquire (real ffprobe verification) → receipt → timeline (TS
//! compiler, asset `origin`) → export with credits (real FFmpeg) → simulated
//! upstream withdrawal → refresh → export blocked. No live provider is used.
//! Writes a JSON evidence summary to `SUPA_VIDEO_RIGHTS_EVIDENCE` when set.

use super::*;
use crate::rights::{
    acquire::{acquire, AcquireContext, MediaVerifier},
    gate::{credits_sidecar_paths, RenderRights},
    ipc::FfprobeVerifier,
    net::{CancelToken, FetchLimits, NetPolicy, ProviderKeyStore, Secret},
    providers::{self, ProviderEndpoints},
    refresh::{refresh_receipt, RefreshContext},
    store::ReceiptStore,
    test_server::{FixtureServer, Route},
    types::{AcquireRequest, MediaKind, ProviderId, RefreshStatus, UsePolicyProfile},
};
use crate::video::render::{
    parse_and_validate_render_plan_with_rights, validate_persisted_render_plan,
};

struct NoKeys;
impl ProviderKeyStore for NoKeys {
    fn key(&self, _: ProviderId) -> Option<Secret> {
        None
    }
}

const ITEM: &str = "File:Rights clip.webm";

fn record() -> Vec<u8> {
    serde_json::json!({
        "query": { "pages": [ {
            "ns": 6,
            "title": ITEM,
            "index": 1,
            "imageinfo": [ {
                "url": "https://upload.wikimedia.org/media/rights-clip.webm",
                "descriptionurl": "https://commons.wikimedia.org/wiki/File:Rights_clip.webm",
                "mime": "video/webm",
                "mediatype": "VIDEO",
                "width": 320,
                "height": 180,
                "extmetadata": {
                    "ObjectName": { "value": "Rights clip" },
                    "Artist": { "value": "Fixture Author" },
                    "LicenseShortName": { "value": "CC BY 4.0" },
                    "LicenseUrl": { "value": "https://creativecommons.org/licenses/by/4.0/" }
                }
            } ]
        } ] }
    })
    .to_string()
    .into_bytes()
}

async fn toolchain() -> (MediaPrograms, PathBuf, PathBuf) {
    let resources = tempdir().unwrap().keep();
    let destination = resources.join("media-tools");
    fs::create_dir(&destination).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for name in ["ffmpeg.exe", "ffprobe.exe"] {
        fs::copy(
            root.join("media-toolchain/bin/x86_64-pc-windows-msvc")
                .join(name),
            destination.join(name),
        )
        .unwrap();
    }
    let programs =
        MediaPrograms::bundled(super::super::toolchain::MediaToolchainState::from_ready(
            super::super::toolchain::MediaToolchain::resolve_from_resource_root(&resources),
        ));
    let ffmpeg = PathBuf::from(programs.verified_ffmpeg("rights_e2e").await.unwrap());
    let ffprobe = PathBuf::from(programs.verified_ffprobe("rights_e2e").await.unwrap());
    (programs, ffmpeg, ffprobe)
}

fn compile(
    repo: &Path,
    source: &Path,
    output: &Path,
    receipt_id: &str,
    strip_origin: bool,
) -> Value {
    let compiled = std::process::Command::new("node")
        .arg(repo.join("apps/desktop/browser-tests/compile-rights-export.mjs"))
        .args([
            source.to_str().unwrap(),
            output.to_str().unwrap(),
            receipt_id,
            "commercial-online",
            if strip_origin { "1" } else { "0" },
        ])
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    serde_json::from_slice(&compiled.stdout).unwrap()
}

fn gate_category(error: VideoCommandError) -> String {
    let value = serde_json::to_value(&error).unwrap();
    assert_eq!(value["code"], "invalid_render_plan", "{value}");
    value["details"]["category"].as_str().unwrap().to_owned()
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn rights_export_end_to_end_with_withdrawal() {
    let started = std::time::Instant::now();
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let (programs, ffmpeg, ffprobe) = toolchain().await;
    let work = tempdir().unwrap().keep();
    println!("RIGHTS_E2E artifacts={}", work.display());

    // Real media served by the fixture provider.
    let clip = work.join("upstream.webm");
    let status = std::process::Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
        ])
        .arg("testsrc2=size=320x180:rate=25:duration=2")
        // Realtime VP9 keeps this fixture cheap inside the parallel suite, where
        // timing-sensitive scheduler and cache tests share the CPU.
        .args([
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "200k",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-n",
        ])
        .arg(&clip)
        .status()
        .unwrap();
    assert!(status.success());
    let clip_bytes = fs::read(&clip).unwrap();
    let server = FixtureServer::start(vec![
        Route::ok("/w/api.php", "application/json", record()).with_header("ETag", "\"v1\""),
        Route::ok(
            "/wiki/File:Rights_clip.webm",
            "text/html",
            b"<html>landing</html>".to_vec(),
        ),
        Route::ok(
            "/licenses/by/4.0/",
            "text/html",
            b"<html>CC BY 4.0</html>".to_vec(),
        ),
        Route::ok("/media/rights-clip.webm", "video/webm", clip_bytes.clone()),
    ]);
    let base = server.base().to_owned();
    let policy = move |id: ProviderId| NetPolicy::routed_for_tests(id, &base);
    let endpoints = ProviderEndpoints::production();
    let store = ReceiptStore::open(&work.join("rights")).unwrap();
    let cache = work.join("cache");
    fs::create_dir_all(&cache).unwrap();

    // 1. Search (advisory, read-only).
    let search = providers::search_request(
        &endpoints,
        ProviderId::WikimediaCommons,
        "rights clip",
        MediaKind::Video,
        None,
    )
    .unwrap();
    // The blocking client runs off the async runtime, as the production command does.
    let search_policy = policy(ProviderId::WikimediaCommons);
    let (_, body) = tokio::task::spawn_blocking(move || {
        let client = crate::rights::net::build_client(search.limits).unwrap();
        crate::rights::net::fetch_bytes(&client, &search_policy, &search, &CancelToken::new())
    })
    .await
    .unwrap()
    .unwrap();
    let candidates =
        providers::parse_search(ProviderId::WikimediaCommons, MediaKind::Video, &body).unwrap();
    assert_eq!(candidates.len(), 1);
    let candidate = providers::candidate_for(&candidates[0], UsePolicyProfile::CommercialOnline);
    assert_eq!(candidate.provider_item_id, ITEM);

    // 2. Acquire with ids only; real ffprobe verifies the quarantined bytes.
    let verifier = FfprobeVerifier {
        ffprobe: ffprobe.clone().into_os_string(),
    };
    let now = crate::rights::service::now_ms();
    let acquired = tokio::task::spawn_blocking({
        let store = store.clone();
        let cache = cache.clone();
        let base = server.base().to_owned();
        move || {
            let policy = move |id: ProviderId| NetPolicy::routed_for_tests(id, &base);
            let verifier: &dyn MediaVerifier = &verifier;
            acquire(
                &AcquireContext {
                    endpoints: &ProviderEndpoints::production(),
                    keys: &NoKeys,
                    store: &store,
                    app_cache_root: &cache,
                    net_policy: &policy,
                    verifier,
                    now_ms: &move || now,
                    media_limits: FetchLimits::MEDIA,
                    cancel: CancelToken::new(),
                    on_stage: &|_| {},
                },
                &AcquireRequest {
                    provider_id: ProviderId::WikimediaCommons,
                    provider_item_id: ITEM.into(),
                    intended_use: UsePolicyProfile::CommercialOnline,
                    project_id: uuid::Uuid::from_u128(42),
                },
            )
        }
    })
    .await
    .unwrap()
    .expect("acquire");
    let receipt = acquired.receipt;
    assert_eq!(receipt.content.byte_length, clip_bytes.len() as u64);
    assert_eq!(receipt.snapshots.len(), 3);

    // 3. Timeline + export: the TS compiler carries the origin and intended use.
    let grants = VideoPathGrants::default();
    let source = grants
        .grant_existing_file("rights", GrantCategory::Source, &acquired.object_path)
        .unwrap();
    let rights = RenderRights {
        lookup: &store,
        now_ms: crate::rights::service::now_ms(),
        freshness: Duration::from_secs(30 * 24 * 60 * 60),
    };
    let output = grants
        .grant_destination("rights", GrantCategory::Output, &work.join("export.mp4"))
        .unwrap();
    let plan = parse_and_validate_render_plan_with_rights(
        compile(
            &repo,
            &source,
            &output,
            &receipt.receipt_id.to_string(),
            false,
        ),
        "rights",
        &grants,
        &rights,
    )
    .expect("valid receipt exports");
    let (request, captured) =
        registered_render_worker(plan, false, work.join("render-cache"), programs.clone());
    run_render_worker(request).await;
    let events = captured_render_events(&captured);
    assert!(
        events
            .iter()
            .any(|event| matches!(event, VideoRenderEvent::Completed { .. })),
        "{events:?}"
    );
    assert!(output.exists());
    let (credits_json, credits_text) = credits_sidecar_paths(&output).unwrap();
    let credits: Value = serde_json::from_slice(&fs::read(&credits_json).unwrap()).unwrap();
    assert_eq!(
        credits["credits"][0]["receiptId"],
        receipt.receipt_id.to_string()
    );
    let text = fs::read_to_string(&credits_text).unwrap();
    assert!(text.contains("\"Rights clip\" by Fixture Author"), "{text}");

    // 4. Upstream withdraws the item; refresh records it.
    server.set_routes(vec![Route::status("/w/api.php", 410)]);
    let refreshed = tokio::task::spawn_blocking({
        let store = store.clone();
        let base = server.base().to_owned();
        let receipt_id = receipt.receipt_id;
        move || {
            let policy = move |id: ProviderId| NetPolicy::routed_for_tests(id, &base);
            refresh_receipt(
                &RefreshContext {
                    endpoints: &ProviderEndpoints::production(),
                    keys: &NoKeys,
                    store: &store,
                    net_policy: &policy,
                    now_ms: crate::rights::service::now_ms(),
                    cancel: CancelToken::new(),
                },
                &receipt_id,
            )
        }
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(refreshed.last_refresh_status, RefreshStatus::Withdrawn);

    // 5. Export is blocked on the fresh and persisted paths, even with origin stripped.
    let blocked_output = grants
        .grant_destination(
            "rights",
            GrantCategory::Output,
            &work.join("export-blocked.mp4"),
        )
        .unwrap();
    let mut blocked = Vec::new();
    for strip in [false, true] {
        let value = compile(
            &repo,
            &source,
            &blocked_output,
            &receipt.receipt_id.to_string(),
            strip,
        );
        let fresh =
            parse_and_validate_render_plan_with_rights(value.clone(), "rights", &grants, &rights)
                .map(|_| ())
                .map_err(gate_category);
        let persisted = validate_persisted_render_plan(
            serde_json::from_value(value).unwrap(),
            "rights",
            &grants,
            &rights,
        )
        .map(|_| ())
        .map_err(gate_category);
        assert_eq!(
            fresh,
            Err("rights_upstream_withdrawn".into()),
            "strip={strip}"
        );
        assert_eq!(
            persisted,
            Err("rights_upstream_withdrawn".into()),
            "strip={strip}"
        );
        blocked.push(serde_json::json!({ "originStripped": strip, "fresh": fresh.unwrap_err(), "persisted": persisted.unwrap_err() }));
    }
    assert!(!blocked_output.exists());

    let evidence = serde_json::json!({
        "test": "rights_export_end_to_end_with_withdrawal",
        "provider": "local fixture server (wikimedia-commons adapter)",
        "searchCandidates": candidates.len(),
        "receipt": {
            "receiptId": receipt.receipt_id,
            "license": receipt.license,
            "policy": receipt.policy,
            "contentDigest": receipt.content.digest,
            "byteLength": receipt.content.byte_length,
            "snapshotKinds": receipt.snapshots.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(),
        },
        "export": {
            "completed": true,
            "outputBytes": fs::metadata(&output).unwrap().len(),
            "creditsText": text,
        },
        "afterWithdrawal": { "refreshStatus": "withdrawn", "blocked": blocked },
        "elapsedMs": started.elapsed().as_millis() as u64,
    });
    if let Ok(path) = std::env::var("SUPA_VIDEO_RIGHTS_EVIDENCE") {
        fs::write(path, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    }
    println!("RIGHTS_E2E {}", serde_json::to_string(&evidence).unwrap());
}

/// Shared body of the opt-in live acquisition tests. Candidates come from a fixed
/// discovery step (no user input); each is acquired through the production
/// network policy, quarantine, streamed SHA-256, MIME sniffing, real ffprobe,
/// promotion and receipt commit. Items the app cannot use (formats ffprobe or
/// the policy rejects, oversize files) are recorded and the next one is tried.
async fn live_acquisition(
    test_name: &'static str,
    provider: ProviderId,
    evidence_env: &'static str,
    discover: fn() -> Vec<String>,
) {
    let (_, _, ffprobe) = toolchain().await;
    let work = tempdir().unwrap().keep();
    let store = ReceiptStore::open(&work.join("rights")).unwrap();
    let cache = work.join("cache");
    fs::create_dir_all(&cache).unwrap();
    let worker_store = store.clone();
    let (attempts, acquired) = tokio::task::spawn_blocking(move || {
        let store = worker_store;
        let ids = discover();
        assert!(
            !ids.is_empty(),
            "{test_name}: live discovery returned no candidates"
        );
        let verifier = FfprobeVerifier {
            ffprobe: ffprobe.into_os_string(),
        };
        let mut attempts = Vec::new();
        for id in ids {
            let outcome = acquire(
                &AcquireContext {
                    endpoints: &ProviderEndpoints::production(),
                    keys: &NoKeys,
                    store: &store,
                    app_cache_root: &cache,
                    net_policy: &NetPolicy::for_provider,
                    verifier: &verifier,
                    now_ms: &crate::rights::service::now_ms,
                    media_limits: FetchLimits {
                        max_bytes: 50 * 1024 * 1024,
                        ..FetchLimits::MEDIA
                    },
                    cancel: CancelToken::new(),
                    on_stage: &|_| {},
                },
                &AcquireRequest {
                    provider_id: provider,
                    provider_item_id: id.clone(),
                    intended_use: UsePolicyProfile::CommercialOnline,
                    project_id: uuid::Uuid::from_u128(42),
                },
            );
            match outcome {
                Ok(done) => return (attempts, Some(done)),
                Err(error) => {
                    attempts.push(serde_json::json!({ "itemId": id, "error": error.code() }))
                }
            }
        }
        (attempts, None)
    })
    .await
    .unwrap();
    let acquired = acquired
        .unwrap_or_else(|| panic!("{test_name}: no live item could be acquired: {attempts:?}"));
    let receipt = &acquired.receipt;
    assert_eq!(receipt.provider_id, provider);
    assert!(
        matches!(
            receipt.license.code,
            crate::rights::types::LicenseCode::Cc0
                | crate::rights::types::LicenseCode::Pdm
                | crate::rights::types::LicenseCode::By
        ),
        "{test_name}: acquired license must be allowed for commercial use: {:?}",
        receipt.license
    );
    assert_eq!(
        receipt.policy.outcome,
        crate::rights::types::PolicyOutcome::Allow
    );
    assert!(receipt
        .snapshots
        .iter()
        .any(|s| s.kind == crate::rights::types::SnapshotKind::ApiRecord));
    assert!(receipt
        .snapshots
        .iter()
        .all(|s| s.url.starts_with("https://")));
    // The promoted object is exactly the receipted bytes.
    let object = fs::read(&acquired.object_path).unwrap();
    assert_eq!(object.len() as u64, receipt.content.byte_length);
    assert_eq!(
        crate::rights::store::sha256_hex(&object),
        receipt.content.digest
    );
    assert!(store.receipt(&receipt.receipt_id).unwrap().as_ref() == Some(receipt));
    let evidence = serde_json::json!({
        "test": test_name,
        "provider": provider.as_str(),
        "skippedItems": attempts,
        "promotedObjectRehashMatches": true,
        "receipt": {
            "providerItemId": receipt.provider_item_id,
            "mediaKind": receipt.media_kind,
            "mediaType": receipt.media_type,
            "license": receipt.license,
            "policy": receipt.policy,
            "contentDigest": receipt.content.digest,
            "byteLength": receipt.content.byte_length,
            "attribution": receipt.attribution,
            "etag": receipt.etag,
            "snapshots": receipt.snapshots.iter().map(|s| serde_json::json!({
                "kind": s.kind, "url": s.url, "digest": s.digest, "bytes": s.byte_length
            })).collect::<Vec<_>>(),
        },
    });
    println!("RIGHTS_LIVE_ACQUIRE {evidence}");
    if let Ok(path) = std::env::var(evidence_env) {
        fs::write(path, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    }
}

/// Runs the production search adapter live and keeps candidates whose advisory
/// policy allows commercial-online use (acquisition re-checks independently).
fn discover_allowed(provider: ProviderId, query: &str, kind: MediaKind) -> Vec<String> {
    let request = providers::search_request(
        &ProviderEndpoints::production(),
        provider,
        query,
        kind,
        None,
    )
    .unwrap();
    let client = crate::rights::net::build_client(request.limits).unwrap();
    let (_, body) = crate::rights::net::fetch_bytes(
        &client,
        &NetPolicy::for_provider(provider),
        &request,
        &CancelToken::new(),
    )
    .unwrap();
    providers::parse_search(provider, kind, &body)
        .unwrap()
        .iter()
        .map(|item| providers::candidate_for(item, UsePolicyProfile::CommercialOnline))
        .filter(|candidate| {
            candidate.advisory_policy.outcome == crate::rights::types::PolicyOutcome::Allow
        })
        .map(|candidate| candidate.provider_item_id)
        .take(10)
        .collect()
}

/// Opt-in live acquisition from Internet Archive through the production network
/// policy (HTTPS allowlist + storage-node redirect), with real ffprobe checks.
/// `cargo test --lib live_internet_archive_acquisition -- --ignored --nocapture`
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "contacts the live Internet Archive"]
async fn live_internet_archive_acquisition() {
    live_acquisition(
        "live_internet_archive_acquisition",
        ProviderId::InternetArchive,
        "SUPA_VIDEO_RIGHTS_LIVE_ACQUIRE_EVIDENCE",
        || {
            // Small, CC BY video items only (fixed query, no user input).
            let client = crate::rights::net::build_client(FetchLimits::METADATA).unwrap();
            let mut url = url::Url::parse("https://archive.org/advancedsearch.php").unwrap();
            url.query_pairs_mut()
                .append_pair(
                    "q",
                    "mediatype:movies AND licenseurl:\"https://creativecommons.org/licenses/by/4.0/\" AND item_size:[100000 TO 20000000]",
                )
                .append_pair("fl[]", "identifier")
                .append_pair("rows", "10")
                .append_pair("output", "json");
            let request = crate::rights::net::FetchRequest {
                url,
                credential: crate::rights::net::Credential::None,
                limits: FetchLimits::METADATA,
            };
            let policy = NetPolicy::for_provider(ProviderId::InternetArchive);
            let (_, body) =
                crate::rights::net::fetch_bytes(&client, &policy, &request, &CancelToken::new()).unwrap();
            let docs: Value = serde_json::from_slice(&body).unwrap();
            docs["response"]["docs"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|doc| doc["identifier"].as_str().map(str::to_owned))
                .collect()
        },
    )
    .await;
}

/// Opt-in live acquisition from Wikimedia Commons (video, allowed license).
/// `cargo test --lib live_wikimedia_commons_acquisition -- --ignored --nocapture`
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "contacts the live Wikimedia Commons API"]
async fn live_wikimedia_commons_acquisition() {
    live_acquisition(
        "live_wikimedia_commons_acquisition",
        ProviderId::WikimediaCommons,
        "SUPA_VIDEO_RIGHTS_LIVE_ACQUIRE_COMMONS_EVIDENCE",
        || {
            discover_allowed(
                ProviderId::WikimediaCommons,
                "sunrise timelapse",
                MediaKind::Video,
            )
        },
    )
    .await;
}

/// Opt-in live acquisition from Openverse (image, allowed license; Openverse has
/// no video). The file host must also be on the Openverse allowlist.
/// `cargo test --lib live_openverse_acquisition -- --ignored --nocapture`
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "contacts the live Openverse API"]
async fn live_openverse_acquisition() {
    live_acquisition(
        "live_openverse_acquisition",
        ProviderId::Openverse,
        "SUPA_VIDEO_RIGHTS_LIVE_ACQUIRE_OPENVERSE_EVIDENCE",
        || discover_allowed(ProviderId::Openverse, "sunrise", MediaKind::Image),
    )
    .await;
}
