//! Opt-in live search against the real providers through the production
//! network policy (HTTPS, exact-host allowlist, caps). Ignored by default:
//! `cargo test --lib live_three_provider_search -- --ignored --nocapture`.
//! Keyed providers run only when their key is in the system keyring; otherwise
//! they are reported as skipped, never faked.

use super::{
    net::{
        build_client, fetch_bytes, CancelToken, KeyringProviderKeys, NetPolicy, ProviderKeyStore,
    },
    providers::{self, ProviderEndpoints},
    types::{MediaKind, ProviderId, UsePolicyProfile},
};

#[test]
#[ignore = "contacts live provider APIs"]
fn live_three_provider_search() {
    let endpoints = ProviderEndpoints::production();
    let keys = KeyringProviderKeys::new();
    let cases = [
        (
            ProviderId::WikimediaCommons,
            "sunrise timelapse",
            MediaKind::Video,
        ),
        (ProviderId::Openverse, "sunrise", MediaKind::Image),
        (ProviderId::Smithsonian, "airplane", MediaKind::Image),
        (ProviderId::Pexels, "sunrise", MediaKind::Video),
        (ProviderId::Pixabay, "sunrise", MediaKind::Video),
        (ProviderId::Freesound, "rain", MediaKind::Audio),
        (
            ProviderId::InternetArchive,
            "sunrise timelapse",
            MediaKind::Video,
        ),
    ];
    let mut report = Vec::new();
    let mut succeeded = 0;
    for (provider, query, kind) in cases {
        let key = providers::requires_key(provider)
            .then(|| keys.key(provider))
            .flatten();
        if providers::requires_key(provider) && key.is_none() {
            report.push(
                serde_json::json!({ "provider": provider.as_str(), "status": "skipped-no-key" }),
            );
            continue;
        }
        let started = std::time::Instant::now();
        let request =
            providers::search_request(&endpoints, provider, query, kind, key).expect("request");
        let client = build_client(request.limits).expect("client");
        let result = fetch_bytes(
            &client,
            &NetPolicy::for_provider(provider),
            &request,
            &CancelToken::new(),
        );
        let entry = match result {
            Ok((meta, body)) => {
                let items = providers::parse_search(provider, kind, &body).expect("parse");
                let licenses: Vec<&str> = items
                    .iter()
                    .map(|item| providers::candidate_for(item, UsePolicyProfile::CommercialOnline))
                    .map(|candidate| candidate.license.code.as_str())
                    .collect();
                assert!(
                    !items.is_empty(),
                    "{} returned no parseable results",
                    provider.as_str()
                );
                assert!(
                    !meta.final_url.contains("key="),
                    "credentials must be redacted"
                );
                succeeded += 1;
                serde_json::json!({
                    "provider": provider.as_str(),
                    "status": "ok",
                    "query": query,
                    "candidates": items.len(),
                    "licenses": licenses,
                    "elapsedMs": started.elapsed().as_millis() as u64,
                })
            }
            Err(error) => serde_json::json!({
                "provider": provider.as_str(),
                "status": "error",
                "error": error.to_string(),
            }),
        };
        report.push(entry);
    }
    let summary = serde_json::json!({ "test": "live_three_provider_search", "providers": report });
    println!("RIGHTS_LIVE {summary}");
    if let Ok(path) = std::env::var("SUPA_VIDEO_RIGHTS_LIVE_EVIDENCE") {
        std::fs::write(path, serde_json::to_vec_pretty(&summary).expect("json")).expect("evidence");
    }
    assert!(
        succeeded >= 3,
        "the three keyless providers must answer: {summary}"
    );
}
