//! The `claude-cli/<version> (external, cli)` User-Agent Anthropic's OAuth and
//! inference edges expect. The edge rejects versions that lag too far behind
//! the current Claude Code release, so the version comes from npm instead of
//! being hardcoded: memory cache → fresh (24h) disk cache → npm → stale disk
//! cache → fallback. A failed lookup is cached in memory for only 5 minutes.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};

use super::token::{http_client, read_bounded_bytes};

pub const NPM_LATEST_URL: &str = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
const CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const FAILED_LOOKUP_TTL_MS: i64 = 5 * 60 * 1000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(3);
/// Last known good version, used only when npm is unreachable and no disk
/// cache exists.
pub const FALLBACK_VERSION: &str = "2.1.280";
pub const CACHE_FILE_NAME: &str = "claude-code-version.json";
/// The npm "latest" manifest is a few KB; anything larger is not trusted.
const NPM_MAX_RESPONSE_BYTES: u64 = 256 * 1024;

/// On-disk shape: `{ "version": "...", "fetchedAt": <ms> }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedVersion {
    version: String,
    fetched_at: i64,
}

#[derive(Debug, Clone)]
struct MemoryEntry {
    version: String,
    expires_at: i64,
}

/// Managed state: the process-lifetime memory cache. The lock is held across
/// resolution, which also collapses concurrent lookups into one.
#[derive(Debug, Default)]
pub struct ClaudeCliVersionCache {
    memory: Mutex<Option<MemoryEntry>>,
}

/// The value becomes an HTTP header, so only a plain semver-ish token passes.
fn is_plausible_version(value: &str) -> bool {
    value.len() <= 64
        && value.starts_with(|c: char| c.is_ascii_digit())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

fn read_disk_cache(path: &Path) -> Option<CachedVersion> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<CachedVersion>(&raw)
        .ok()
        .filter(|cached| is_plausible_version(&cached.version))
}

/// Best effort: a failed write only costs a refetch later.
fn write_disk_cache(path: &Path, cached: &CachedVersion) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(cached) {
        let _ = fs::write(path, json);
    }
}

impl ClaudeCliVersionCache {
    /// Resolves the Claude Code version. `cache_path` is `None` when the app
    /// data directory is unavailable; `fetch_latest` is only called on a
    /// memory and fresh-disk miss.
    pub fn resolve(
        &self,
        cache_path: Option<&Path>,
        now_ms: i64,
        fetch_latest: impl FnOnce() -> Option<String>,
    ) -> String {
        let mut memory = self
            .memory
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = memory.as_ref().filter(|entry| now_ms < entry.expires_at) {
            return entry.version.clone();
        }

        let disk = cache_path.and_then(read_disk_cache);
        if let Some(cached) = disk
            .as_ref()
            .filter(|cached| now_ms - cached.fetched_at < CACHE_TTL_MS)
        {
            *memory = Some(MemoryEntry {
                version: cached.version.clone(),
                expires_at: now_ms + CACHE_TTL_MS,
            });
            return cached.version.clone();
        }

        if let Some(fetched) = fetch_latest().filter(|version| is_plausible_version(version)) {
            if let Some(path) = cache_path {
                write_disk_cache(
                    path,
                    &CachedVersion {
                        version: fetched.clone(),
                        fetched_at: now_ms,
                    },
                );
            }
            *memory = Some(MemoryEntry {
                version: fetched.clone(),
                expires_at: now_ms + CACHE_TTL_MS,
            });
            return fetched;
        }

        // npm unreachable: prefer the stale disk cache over the fallback, and
        // retry npm after a short TTL.
        let resolved = disk
            .map(|cached| cached.version)
            .unwrap_or_else(|| FALLBACK_VERSION.to_owned());
        *memory = Some(MemoryEntry {
            version: resolved.clone(),
            expires_at: now_ms + FAILED_LOOKUP_TTL_MS,
        });
        resolved
    }

    /// The User-Agent header value, resolved against the public npm registry.
    pub fn user_agent(&self, app_data_dir: Option<&Path>) -> String {
        let cache_path: Option<PathBuf> = app_data_dir.map(|dir| dir.join(CACHE_FILE_NAME));
        let version = self.resolve(cache_path.as_deref(), now_ms(), || {
            let client = http_client(FETCH_TIMEOUT).ok()?;
            fetch_latest_from_npm(&client, NPM_LATEST_URL)
        });
        user_agent_for(&version)
    }
}

/// `GET` the npm "latest" manifest; any failure is `None`.
pub fn fetch_latest_from_npm(client: &Client, url: &str) -> Option<String> {
    let response = client.get(url).timeout(FETCH_TIMEOUT).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    #[derive(Deserialize)]
    struct Manifest {
        version: Option<String>,
    }
    let body = read_bounded_bytes(response, NPM_MAX_RESPONSE_BYTES).ok()?;
    serde_json::from_slice::<Manifest>(&body)
        .ok()?
        .version
        .filter(|version| is_plausible_version(version))
}

pub fn user_agent_for(version: &str) -> String {
    format!("claude-cli/{version} (external, cli)")
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::ai_account::test_support::spawn_fake_server;

    const NOW: i64 = 1_800_000_000_000;

    fn temp_cache_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("nested").join(CACHE_FILE_NAME)
    }

    fn seed(path: &Path, version: &str, fetched_at: i64) {
        write_disk_cache(
            path,
            &CachedVersion {
                version: version.to_owned(),
                fetched_at,
            },
        );
    }

    fn npm_client() -> Client {
        http_client(FETCH_TIMEOUT).expect("client")
    }

    #[test]
    fn falls_back_to_hardcoded_version_when_npm_and_disk_are_unavailable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = temp_cache_path(&dir);
        let cache = ClaudeCliVersionCache::default();
        let fetches = Cell::new(0);

        let version = cache.resolve(Some(&path), NOW, || {
            fetches.set(fetches.get() + 1);
            None
        });
        assert_eq!(version, FALLBACK_VERSION);
        assert_eq!(
            user_agent_for(&version),
            "claude-cli/2.1.280 (external, cli)"
        );
        // The fallback is not persisted, so a later run still asks npm.
        assert!(!path.exists());

        // Short TTL: served from memory for 5 minutes, then npm is retried.
        cache.resolve(Some(&path), NOW + FAILED_LOOKUP_TTL_MS - 1, || {
            fetches.set(fetches.get() + 1);
            None
        });
        assert_eq!(fetches.get(), 1);
        let retried = cache.resolve(Some(&path), NOW + FAILED_LOOKUP_TTL_MS, || {
            fetches.set(fetches.get() + 1);
            Some("2.1.283".to_owned())
        });
        assert_eq!((retried.as_str(), fetches.get()), ("2.1.283", 2));
    }

    #[test]
    fn prefers_stale_disk_cache_over_fallback_when_npm_fails() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = temp_cache_path(&dir);
        seed(&path, "2.1.270", NOW - CACHE_TTL_MS - 1);
        let version = ClaudeCliVersionCache::default().resolve(Some(&path), NOW, || None);
        assert_eq!(version, "2.1.270");
    }

    #[test]
    fn fresh_disk_cache_skips_npm_and_npm_result_is_persisted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fresh = dir.path().join("fresh").join(CACHE_FILE_NAME);
        seed(&fresh, "2.1.281", NOW - CACHE_TTL_MS + 1);
        let version = ClaudeCliVersionCache::default().resolve(Some(&fresh), NOW, || {
            panic!("npm must not be queried while the disk cache is fresh")
        });
        assert_eq!(version, "2.1.281");

        let empty = temp_cache_path(&dir);
        let cache = ClaudeCliVersionCache::default();
        let version = cache.resolve(Some(&empty), NOW, || Some("2.1.283".to_owned()));
        assert_eq!(version, "2.1.283");
        let saved = read_disk_cache(&empty).expect("persisted");
        assert_eq!((saved.version.as_str(), saved.fetched_at), ("2.1.283", NOW));
        let cached = cache.resolve(Some(&empty), NOW + CACHE_TTL_MS - 1, || {
            panic!("npm must not be queried while the memory cache is fresh")
        });
        assert_eq!(cached, "2.1.283");
    }

    #[test]
    fn rejects_values_that_are_not_version_tokens() {
        for bad in ["", "latest", "v2.1.0", "2.1.0\r\nX-Evil: 1", "2.1.0 (x)"] {
            assert!(!is_plausible_version(bad), "{bad:?}");
        }
        let version = ClaudeCliVersionCache::default()
            .resolve(None, NOW, || Some("2.1.0\r\nX-Evil: 1".to_owned()));
        assert_eq!(version, FALLBACK_VERSION);
    }

    #[test]
    fn fetches_version_from_npm_manifest_and_tolerates_failures() {
        let ok = spawn_fake_server(
            vec![(
                200,
                r#"{"name":"@anthropic-ai/claude-code","version":"2.1.283"}"#.to_owned(),
            )],
            Duration::ZERO,
        );
        assert_eq!(
            fetch_latest_from_npm(&npm_client(), &ok.url).as_deref(),
            Some("2.1.283")
        );
        assert!(ok.request(0).starts_with("GET "));

        let failing = spawn_fake_server(vec![(503, "unavailable".to_owned())], Duration::ZERO);
        assert_eq!(fetch_latest_from_npm(&npm_client(), &failing.url), None);
        let garbage = spawn_fake_server(vec![(200, "not json".to_owned())], Duration::ZERO);
        assert_eq!(fetch_latest_from_npm(&npm_client(), &garbage.url), None);
    }
}
