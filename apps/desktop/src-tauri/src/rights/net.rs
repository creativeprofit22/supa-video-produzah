//! Bounded, allowlisted HTTP for rights acquisition.
//!
//! - HTTPS only (a loopback-HTTP policy exists for tests only).
//! - Exact-host allowlist per provider, re-checked on every redirect hop;
//!   redirects are followed manually (reqwest auto-redirect is disabled).
//! - Size cap enforced while streaming, total timeout, cooperative cancellation.
//! - API keys never leave the original host, are never stored, and are
//!   stripped from every URL that reaches receipts, errors or logs.

use std::{
    collections::BTreeSet,
    fmt,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use reqwest::{blocking::Client, header, redirect::Policy};
use url::Url;

use super::types::ProviderId;

const READ_CHUNK_BYTES: usize = 64 * 1024;
const SENSITIVE_QUERY_KEYS: [&str; 7] = [
    "key",
    "api_key",
    "apikey",
    "token",
    "access_token",
    "client_secret",
    "signature",
];

/// A secret value (API key). Debug/Display never reveal it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// Cooperative cancellation shared by every stage of one acquisition.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<(), NetError> {
        if self.is_cancelled() {
            Err(NetError::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    InvalidUrl,
    InsecureScheme,
    HostNotAllowed { host: String },
    TooManyRedirects,
    RedirectWithoutLocation,
    Status(u16),
    TooLarge { limit: u64 },
    Timeout,
    Cancelled,
    Transport(&'static str),
    Write,
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NetError::InvalidUrl => f.write_str("invalid URL"),
            NetError::InsecureScheme => f.write_str("only HTTPS is allowed"),
            NetError::HostNotAllowed { host } => {
                write!(f, "host {host} is not on the provider allowlist")
            }
            NetError::TooManyRedirects => f.write_str("too many redirects"),
            NetError::RedirectWithoutLocation => f.write_str("redirect without a location"),
            NetError::Status(code) => write!(f, "upstream answered HTTP {code}"),
            NetError::TooLarge { limit } => write!(f, "response exceeds the {limit}-byte limit"),
            NetError::Timeout => f.write_str("request timed out"),
            NetError::Cancelled => f.write_str("cancelled"),
            NetError::Transport(kind) => write!(f, "network error ({kind})"),
            NetError::Write => f.write_str("could not write the downloaded bytes"),
        }
    }
}

impl std::error::Error for NetError {}

/// Hosts each provider may contact. Matching is exact; no wildcards.
pub fn provider_hosts(provider_id: ProviderId) -> &'static [&'static str] {
    match provider_id {
        ProviderId::WikimediaCommons => &["commons.wikimedia.org", "upload.wikimedia.org"],
        ProviderId::Openverse => &[
            "api.openverse.org",
            "live.staticflickr.com",
            "www.flickr.com",
            "flickr.com",
            "upload.wikimedia.org",
            "commons.wikimedia.org",
        ],
        ProviderId::Smithsonian => &[
            "api.si.edu",
            "ids.si.edu",
            "collections.si.edu",
            "edan.si.edu",
        ],
        ProviderId::Pexels => &[
            "api.pexels.com",
            "www.pexels.com",
            "images.pexels.com",
            "videos.pexels.com",
        ],
        ProviderId::Pixabay => &["pixabay.com", "cdn.pixabay.com"],
        ProviderId::Freesound => &["freesound.org", "cdn.freesound.org"],
        ProviderId::InternetArchive => &["archive.org"],
    }
}

/// Host suffixes a provider may redirect to. Only for providers whose download
/// hosts are assigned dynamically inside a domain they wholly operate
/// (archive.org sends `/download/` to per-item storage nodes like
/// `dn711103.ca.archive.org`). Matching requires a label boundary.
pub fn provider_host_suffixes(provider_id: ProviderId) -> &'static [&'static str] {
    match provider_id {
        ProviderId::InternetArchive => &[".us.archive.org", ".ca.archive.org"],
        _ => &[],
    }
}

/// Hosts every provider may contact for license deeds.
const SHARED_HOSTS: [&str; 1] = ["creativecommons.org"];

#[derive(Debug, Clone)]
pub struct NetPolicy {
    hosts: BTreeSet<String>,
    host_suffixes: &'static [&'static str],
    allow_loopback_http: bool,
    /// Test only: send requests for allowlisted HTTPS hosts to this loopback origin instead.
    #[cfg(test)]
    route_to_loopback: Option<Url>,
}

impl NetPolicy {
    pub fn for_provider(provider_id: ProviderId) -> Self {
        let hosts = provider_hosts(provider_id)
            .iter()
            .chain(SHARED_HOSTS.iter())
            .map(|host| (*host).to_owned())
            .collect();
        Self {
            hosts,
            host_suffixes: provider_host_suffixes(provider_id),
            allow_loopback_http: false,
            #[cfg(test)]
            route_to_loopback: None,
        }
    }

    /// Local fixture servers only. Allows `http://127.0.0.1:<any>` and nothing else extra.
    #[cfg(test)]
    pub fn loopback_for_tests(provider_id: ProviderId) -> Self {
        let mut policy = Self::for_provider(provider_id);
        policy.allow_loopback_http = true;
        policy
    }

    /// Like `loopback_for_tests`, and additionally serves allowlisted HTTPS hosts
    /// (for example license deeds) from the fixture server, so no test touches the network.
    #[cfg(test)]
    pub fn routed_for_tests(provider_id: ProviderId, base: &str) -> Self {
        let mut policy = Self::loopback_for_tests(provider_id);
        policy.route_to_loopback = Some(Url::parse(base).expect("fixture base"));
        policy
    }

    /// The URL actually requested for a logical, already-checked URL.
    fn route(&self, url: Url) -> Url {
        #[cfg(test)]
        if let Some(base) = &self.route_to_loopback {
            if url.scheme() == "https" {
                let mut routed = base.clone();
                routed.set_path(url.path());
                routed.set_query(url.query());
                return routed;
            }
        }
        url
    }

    pub fn check(&self, url: &Url) -> Result<(), NetError> {
        if !url.username().is_empty() || url.password().is_some() {
            return Err(NetError::InvalidUrl);
        }
        let host = url
            .host_str()
            .ok_or(NetError::InvalidUrl)?
            .to_ascii_lowercase();
        if self.allow_loopback_http && host == "127.0.0.1" {
            return match url.scheme() {
                "http" | "https" => Ok(()),
                _ => Err(NetError::InsecureScheme),
            };
        }
        if url.scheme() != "https" {
            return Err(NetError::InsecureScheme);
        }
        if url.port().is_some_and(|port| port != 443) {
            return Err(NetError::HostNotAllowed { host });
        }
        let suffix_match = self.host_suffixes.iter().any(|suffix| {
            host.strip_suffix(suffix).is_some_and(|label| {
                !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
        });
        if self.hosts.contains(&host) || suffix_match {
            Ok(())
        } else {
            Err(NetError::HostNotAllowed { host })
        }
    }
}

/// Removes credentials, sensitive query parameters and fragments.
pub fn redact_url(url: &Url) -> String {
    let mut clean = url.clone();
    let _ = clean.set_username("");
    let _ = clean.set_password(None);
    clean.set_fragment(None);
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| !SENSITIVE_QUERY_KEYS.contains(&key.to_ascii_lowercase().as_str()))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    if kept.is_empty() {
        clean.set_query(None);
    } else {
        clean.query_pairs_mut().clear().extend_pairs(kept);
    }
    clean.to_string()
}

#[derive(Debug, Clone, Copy)]
pub struct FetchLimits {
    pub max_bytes: u64,
    pub timeout: Duration,
    pub max_redirects: u8,
}

impl FetchLimits {
    pub const METADATA: FetchLimits = FetchLimits {
        max_bytes: 4 * 1024 * 1024,
        timeout: Duration::from_secs(30),
        max_redirects: 5,
    };
    pub const MEDIA: FetchLimits = FetchLimits {
        max_bytes: 2 * 1024 * 1024 * 1024,
        timeout: Duration::from_secs(30 * 60),
        max_redirects: 5,
    };
}

#[derive(Debug, Clone)]
pub enum Credential {
    None,
    Query { name: &'static str, secret: Secret },
    Header { name: &'static str, secret: Secret },
}

#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub url: Url,
    pub credential: Credential,
    pub limits: FetchLimits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchMeta {
    /// Final URL after redirects, redacted.
    pub final_url: String,
    pub status: u16,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub byte_length: u64,
    pub elapsed_ms: u64,
}

pub fn build_client(limits: FetchLimits) -> Result<Client, NetError> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(limits.timeout)
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("supa-video-producer/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| NetError::Transport("client"))
}

fn map_reqwest(error: &reqwest::Error) -> NetError {
    // Never format the reqwest error itself: it embeds the URL (and any key).
    if error.is_timeout() {
        NetError::Timeout
    } else if error.is_connect() {
        NetError::Transport("connect")
    } else if error.is_body() || error.is_decode() {
        NetError::Transport("body")
    } else {
        NetError::Transport("request")
    }
}

/// Streams the response body into `sink` with every guard applied.
pub fn fetch_to_writer(
    client: &Client,
    policy: &NetPolicy,
    request: &FetchRequest,
    cancel: &CancelToken,
    sink: &mut dyn Write,
) -> Result<FetchMeta, NetError> {
    let started = Instant::now();
    let origin_host = request.url.host_str().map(str::to_ascii_lowercase);
    let mut current = request.url.clone();
    let mut hops = 0u8;
    loop {
        cancel.check()?;
        policy.check(&current)?;
        let same_origin = current.host_str().map(str::to_ascii_lowercase) == origin_host;
        let mut target = current.clone();
        let mut builder_headers = header::HeaderMap::new();
        if same_origin {
            match &request.credential {
                Credential::None => {}
                Credential::Query { name, secret } => {
                    target.query_pairs_mut().append_pair(name, secret.expose());
                }
                Credential::Header { name, secret } => {
                    let mut value = header::HeaderValue::from_str(secret.expose())
                        .map_err(|_| NetError::Transport("credential"))?;
                    value.set_sensitive(true);
                    let name = header::HeaderName::from_static(name);
                    builder_headers.insert(name, value);
                }
            }
        }
        let mut response = client
            .get(policy.route(target))
            .headers(builder_headers)
            .send()
            .map_err(|error| map_reqwest(&error))?;
        let status = response.status();
        if status.is_redirection() {
            hops += 1;
            if hops > request.limits.max_redirects {
                return Err(NetError::TooManyRedirects);
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(NetError::RedirectWithoutLocation)?;
            current = current.join(location).map_err(|_| NetError::InvalidUrl)?;
            continue;
        }
        if !status.is_success() {
            return Err(NetError::Status(status.as_u16()));
        }
        // Captured up front: reqwest derives it from the body size hint, which shrinks as read.
        let declared_length = response.content_length();
        if let Some(length) = declared_length {
            if length > request.limits.max_bytes {
                return Err(NetError::TooLarge {
                    limit: request.limits.max_bytes,
                });
            }
        }
        let content_type = header_text(&response, header::CONTENT_TYPE);
        let etag = header_text(&response, header::ETAG);
        let mut buffer = vec![0u8; READ_CHUNK_BYTES];
        let mut total = 0u64;
        loop {
            cancel.check()?;
            let read = response.read(&mut buffer).map_err(|error| {
                if error.kind() == std::io::ErrorKind::TimedOut {
                    NetError::Timeout
                } else {
                    NetError::Transport("body")
                }
            })?;
            if read == 0 {
                break;
            }
            total += read as u64;
            if total > request.limits.max_bytes {
                return Err(NetError::TooLarge {
                    limit: request.limits.max_bytes,
                });
            }
            sink.write_all(&buffer[..read])
                .map_err(|_| NetError::Write)?;
        }
        if let Some(length) = declared_length {
            if length != total {
                return Err(NetError::Transport("truncated"));
            }
        }
        return Ok(FetchMeta {
            final_url: redact_url(&current),
            status: status.as_u16(),
            content_type,
            etag,
            byte_length: total,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        });
    }
}

fn header_text(response: &reqwest::blocking::Response, name: header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(512).collect())
}

/// Convenience for bounded metadata fetches held in memory.
pub fn fetch_bytes(
    client: &Client,
    policy: &NetPolicy,
    request: &FetchRequest,
    cancel: &CancelToken,
) -> Result<(FetchMeta, Vec<u8>), NetError> {
    let mut body = Vec::new();
    let meta = fetch_to_writer(client, policy, request, cancel, &mut body)?;
    Ok((meta, body))
}

/// API keys live in the OS keyring; never in project files, receipts or logs.
pub trait ProviderKeyStore: Send + Sync {
    fn key(&self, provider_id: ProviderId) -> Option<Secret>;
}

pub struct KeyringProviderKeys {
    service: String,
}

impl KeyringProviderKeys {
    pub fn new() -> Self {
        Self {
            service: "supa-video-producer.rights".into(),
        }
    }
}

impl ProviderKeyStore for KeyringProviderKeys {
    fn key(&self, provider_id: ProviderId) -> Option<Secret> {
        keyring::Entry::new(&self.service, provider_id.as_str())
            .ok()?
            .get_password()
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(Secret::new)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::rights::test_server::{FixtureServer, Route};

    fn request(url: &str) -> FetchRequest {
        FetchRequest {
            url: Url::parse(url).expect("url"),
            credential: Credential::None,
            limits: FetchLimits::METADATA,
        }
    }

    #[test]
    fn archive_storage_node_suffixes_match_only_single_labels_under_archive_org() {
        let archive = NetPolicy::for_provider(ProviderId::InternetArchive);
        let ok = |raw: &str| archive.check(&Url::parse(raw).unwrap()).is_ok();
        assert!(ok("https://archive.org/download/x/y.mp4"));
        assert!(ok("https://dn711103.ca.archive.org/0/items/x/y.mp4"));
        assert!(ok("https://ia800200.us.archive.org/1/items/x/y.mp4"));
        for bad in [
            "https://us.archive.org/x",
            "https://.us.archive.org/x",
            "https://a.b.us.archive.org/x",
            "https://evil-us.archive.org.example/x",
            "https://evilus.archive.org/x",
            "https://web.archive.org/x",
            "http://dn1.us.archive.org/x",
            "https://dn1.us.archive.org:8443/x",
        ] {
            assert!(!ok(bad), "{bad} must be refused");
        }
        // Suffixes are per provider: other providers never accept archive nodes.
        let commons = NetPolicy::for_provider(ProviderId::WikimediaCommons);
        assert!(commons
            .check(&Url::parse("https://dn1.us.archive.org/x").unwrap())
            .is_err());
    }

    #[test]
    fn production_policy_rejects_http_foreign_hosts_ports_and_userinfo() {
        let policy = NetPolicy::for_provider(ProviderId::WikimediaCommons);
        let ok = Url::parse("https://upload.wikimedia.org/a.webm").unwrap();
        assert_eq!(policy.check(&ok), Ok(()));
        for (raw, expected) in [
            (
                "http://upload.wikimedia.org/a.webm",
                NetError::InsecureScheme,
            ),
            (
                "https://evil.example/a.webm",
                NetError::HostNotAllowed {
                    host: "evil.example".into(),
                },
            ),
            (
                "https://upload.wikimedia.org.evil.example/a",
                NetError::HostNotAllowed {
                    host: "upload.wikimedia.org.evil.example".into(),
                },
            ),
            (
                "https://upload.wikimedia.org:8443/a",
                NetError::HostNotAllowed {
                    host: "upload.wikimedia.org".into(),
                },
            ),
            (
                "https://user:pw@upload.wikimedia.org/a",
                NetError::InvalidUrl,
            ),
            ("http://127.0.0.1:9/a", NetError::InsecureScheme),
            ("file:///etc/passwd", NetError::InvalidUrl),
        ] {
            assert_eq!(
                policy.check(&Url::parse(raw).unwrap()),
                Err(expected),
                "{raw}"
            );
        }
    }

    #[test]
    fn redaction_strips_keys_userinfo_and_fragments() {
        let url =
            Url::parse("https://u:p@pixabay.com/api/?key=SECRET&q=tree&TOKEN=x#frag").unwrap();
        let redacted = redact_url(&url);
        assert_eq!(redacted, "https://pixabay.com/api/?q=tree");
        assert!(!redacted.contains("SECRET"));
    }

    #[test]
    fn secret_debug_is_redacted() {
        let secret = Secret::new("sk-live-123");
        assert!(!format!("{secret:?}").contains("sk-live"));
        let credential = Credential::Header {
            name: "authorization",
            secret,
        };
        assert!(!format!("{credential:?}").contains("sk-live"));
    }

    #[test]
    fn redirect_leaving_the_allowlist_is_refused_on_the_hop() {
        let server = FixtureServer::start(vec![Route::redirect(
            "/start",
            "https://evil.example/steal",
        )]);
        let client = build_client(FetchLimits::METADATA).unwrap();
        let policy = NetPolicy::loopback_for_tests(ProviderId::Pexels);
        let error = fetch_bytes(
            &client,
            &policy,
            &request(&server.url("/start")),
            &CancelToken::new(),
        )
        .expect_err("redirect must be refused");
        assert_eq!(
            error,
            NetError::HostNotAllowed {
                host: "evil.example".into()
            }
        );
    }

    #[test]
    fn redirect_to_plain_http_is_refused() {
        let server = FixtureServer::start(vec![Route::redirect(
            "/start",
            "http://images.pexels.com/a.jpg",
        )]);
        let client = build_client(FetchLimits::METADATA).unwrap();
        let policy = NetPolicy::loopback_for_tests(ProviderId::Pexels);
        let error = fetch_bytes(
            &client,
            &policy,
            &request(&server.url("/start")),
            &CancelToken::new(),
        )
        .expect_err("downgrade refused");
        assert_eq!(error, NetError::InsecureScheme);
    }

    #[test]
    fn same_host_redirects_are_followed_and_capped() {
        let server = FixtureServer::start(vec![
            Route::redirect("/a", "/b"),
            Route::ok("/b", "application/json", b"{}".to_vec()),
            Route::redirect("/loop", "/loop"),
        ]);
        let client = build_client(FetchLimits::METADATA).unwrap();
        let policy = NetPolicy::loopback_for_tests(ProviderId::Pexels);
        let (meta, body) = fetch_bytes(
            &client,
            &policy,
            &request(&server.url("/a")),
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(body, b"{}");
        assert!(meta.final_url.ends_with("/b"));
        let error = fetch_bytes(
            &client,
            &policy,
            &request(&server.url("/loop")),
            &CancelToken::new(),
        )
        .expect_err("loop");
        assert_eq!(error, NetError::TooManyRedirects);
    }

    #[test]
    fn size_cap_is_enforced_while_streaming() {
        let server = FixtureServer::start(vec![
            Route::ok("/big", "application/octet-stream", vec![7u8; 5000]),
            Route::ok("/big-chunked", "application/octet-stream", vec![7u8; 5000]).chunked(),
        ]);
        let client = build_client(FetchLimits::METADATA).unwrap();
        let policy = NetPolicy::loopback_for_tests(ProviderId::Pexels);
        for path in ["/big", "/big-chunked"] {
            let mut req = request(&server.url(path));
            req.limits.max_bytes = 1000;
            let error = fetch_bytes(&client, &policy, &req, &CancelToken::new()).expect_err("cap");
            assert_eq!(error, NetError::TooLarge { limit: 1000 }, "{path}");
        }
    }

    #[test]
    fn cancellation_is_observed_before_any_request() {
        let server = FixtureServer::start(vec![Route::ok("/a", "text/plain", b"x".to_vec())]);
        let client = build_client(FetchLimits::METADATA).unwrap();
        let policy = NetPolicy::loopback_for_tests(ProviderId::Pexels);
        let cancel = CancelToken::new();
        cancel.cancel();
        let error = fetch_bytes(&client, &policy, &request(&server.url("/a")), &cancel)
            .expect_err("cancelled");
        assert_eq!(error, NetError::Cancelled);
        assert_eq!(server.hits(), 0);
    }

    #[test]
    fn keys_are_sent_only_to_the_origin_and_never_appear_in_meta_or_errors() {
        let server = FixtureServer::start(vec![
            Route::ok("/ok", "application/json", b"{}".to_vec()),
            Route::status("/gone", 410),
            Route::redirect("/away", "https://evil.example/x"),
        ]);
        let client = build_client(FetchLimits::METADATA).unwrap();
        let policy = NetPolicy::loopback_for_tests(ProviderId::Pixabay);
        let mut req = request(&server.url("/ok"));
        req.credential = Credential::Query {
            name: "key",
            secret: Secret::new("TOPSECRET"),
        };
        let (meta, _) = fetch_bytes(&client, &policy, &req, &CancelToken::new()).unwrap();
        assert!(!meta.final_url.contains("TOPSECRET"));
        assert!(
            server
                .requests()
                .iter()
                .any(|r| r.contains("key=TOPSECRET")),
            "sent to origin"
        );

        for path in ["/gone", "/away"] {
            req.url = Url::parse(&server.url(path)).unwrap();
            let error =
                fetch_bytes(&client, &policy, &req, &CancelToken::new()).expect_err("fails");
            assert!(!error.to_string().contains("TOPSECRET"));
            assert!(!format!("{error:?}").contains("TOPSECRET"));
        }
        assert_eq!(
            fetch_bytes(
                &client,
                &policy,
                &FetchRequest {
                    url: Url::parse(&server.url("/gone")).unwrap(),
                    ..req.clone()
                },
                &CancelToken::new()
            )
            .expect_err("gone"),
            NetError::Status(410)
        );

        let mut header_req = request(&server.url("/ok"));
        header_req.credential = Credential::Header {
            name: "authorization",
            secret: Secret::new("HEADERSECRET"),
        };
        let (meta, _) = fetch_bytes(&client, &policy, &header_req, &CancelToken::new()).unwrap();
        assert!(!format!("{meta:?}").contains("HEADERSECRET"));
    }
}
