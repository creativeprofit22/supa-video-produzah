//! The signed-in Anthropic credential, kept only in the OS keyring (Windows
//! Credential Manager, macOS Keychain, Secret Service). Never on disk, never
//! over IPC, never in logs.

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

/// Keyring account name for the one Anthropic credential.
const CREDENTIAL_KEY: &str = "anthropic";
/// Windows Credential Manager caps each blob at 2560 bytes and the keyring
/// crate may store UTF-16, so values are split into chunks of at most this many
/// characters (2 × 1000 bytes stays under the cap).
const KEYRING_CHUNK_CHARS: usize = 1000;
/// Upper bound on chunk entries read back, so a corrupt marker cannot trigger
/// unbounded keyring lookups.
const KEYRING_MAX_CHUNKS: usize = 64;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAnthropicCredential {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds; `None` when the provider did not say.
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub account_email: Option<String>,
    /// Set when the provider rejected the refresh token: the user must sign
    /// in again before any request is sent.
    #[serde(default)]
    pub needs_reauth: bool,
}

/// Never prints token material.
impl std::fmt::Debug for StoredAnthropicCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredAnthropicCredential")
            .field("expires_at", &self.expires_at)
            .field("needs_reauth", &self.needs_reauth)
            .finish_non_exhaustive()
    }
}

/// Keyring service for an app identifier, so dev and release builds never
/// share a credential.
pub fn keyring_service_name(identifier: &str) -> String {
    format!("{identifier}:ai-anthropic")
}

/// Minimal secret-store surface so chunking is testable without the OS store.
pub trait SecretBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<bool, String>;
}

// Only app startup builds the OS-backed store; tests use the memory backend so
// they never touch the real keyring.
#[cfg_attr(test, allow(dead_code))]
pub struct KeyringBackend {
    service: String,
}

#[cfg_attr(test, allow(dead_code))]
impl KeyringBackend {
    pub fn new(service: String) -> Self {
        Self { service }
    }

    fn entry(&self, key: &str) -> Result<Entry, String> {
        Entry::new(&self.service, key).map_err(|_| keyring_unavailable())
    }
}

#[cfg_attr(test, allow(dead_code))]
fn keyring_unavailable() -> String {
    "The system credential store is unavailable".to_owned()
}

impl SecretBackend for KeyringBackend {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match self.entry(key)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err(keyring_unavailable()),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.entry(key)?
            .set_password(value)
            .map_err(|_| keyring_unavailable())
    }

    fn delete(&self, key: &str) -> Result<bool, String> {
        match self.entry(key)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(_) => Err(keyring_unavailable()),
        }
    }
}

/// Primary-entry marker written when a value is split across `<key>#1..n`.
#[derive(Debug, Serialize, Deserialize)]
struct ChunkMarker {
    #[serde(rename = "supaVideoChunkedV1")]
    chunks: usize,
}

fn chunk_key(key: &str, index: usize) -> String {
    format!("{key}#{index}")
}

fn existing_chunk_count(backend: &dyn SecretBackend, key: &str) -> usize {
    backend
        .get(key)
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str::<ChunkMarker>(&value).ok())
        .map_or(0, |marker| marker.chunks.min(KEYRING_MAX_CHUNKS))
}

fn read_chunked(backend: &dyn SecretBackend, key: &str) -> Result<Option<String>, String> {
    let Some(primary) = backend.get(key)? else {
        return Ok(None);
    };
    let Ok(marker) = serde_json::from_str::<ChunkMarker>(&primary) else {
        return Ok(Some(primary));
    };
    if marker.chunks == 0 || marker.chunks > KEYRING_MAX_CHUNKS {
        return Err("Stored sign-in is corrupt; sign in again".to_owned());
    }
    let mut value = String::new();
    for index in 1..=marker.chunks {
        let chunk = backend
            .get(&chunk_key(key, index))?
            .ok_or_else(|| "Stored sign-in is incomplete; sign in again".to_owned())?;
        value.push_str(&chunk);
    }
    Ok(Some(value))
}

fn write_chunked(backend: &dyn SecretBackend, key: &str, value: &str) -> Result<(), String> {
    let previous_chunks = existing_chunk_count(backend, key);
    let chars: Vec<char> = value.chars().collect();
    let new_chunks = if chars.len() <= KEYRING_CHUNK_CHARS {
        backend.set(key, value)?;
        0
    } else {
        let pieces: Vec<String> = chars
            .chunks(KEYRING_CHUNK_CHARS)
            .map(|piece| piece.iter().collect())
            .collect();
        if pieces.len() > KEYRING_MAX_CHUNKS {
            return Err("Sign-in credential is too large to store".to_owned());
        }
        for (index, piece) in pieces.iter().enumerate() {
            backend.set(&chunk_key(key, index + 1), piece)?;
        }
        let marker = serde_json::to_string(&ChunkMarker {
            chunks: pieces.len(),
        })
        .map_err(|_| "Sign-in credential could not be stored".to_owned())?;
        backend.set(key, &marker)?;
        pieces.len()
    };
    for index in (new_chunks + 1)..=previous_chunks {
        backend.delete(&chunk_key(key, index))?;
    }
    Ok(())
}

fn delete_chunked(backend: &dyn SecretBackend, key: &str) -> Result<bool, String> {
    let chunks = existing_chunk_count(backend, key);
    for index in 1..=chunks {
        backend.delete(&chunk_key(key, index))?;
    }
    backend.delete(key)
}

/// Managed state: load/save/clear of the single Anthropic credential.
pub struct CredentialStore {
    backend: Box<dyn SecretBackend>,
}

impl CredentialStore {
    pub fn new(backend: Box<dyn SecretBackend>) -> Self {
        Self { backend }
    }

    #[cfg_attr(test, allow(dead_code))]
    pub fn for_identifier(identifier: &str) -> Self {
        Self::new(Box::new(KeyringBackend::new(keyring_service_name(
            identifier,
        ))))
    }

    pub fn load(&self) -> Result<Option<StoredAnthropicCredential>, String> {
        match read_chunked(self.backend.as_ref(), CREDENTIAL_KEY)? {
            Some(secret) => serde_json::from_str(&secret)
                .map(Some)
                .map_err(|_| "Stored sign-in is unreadable; sign in again".to_owned()),
            None => Ok(None),
        }
    }

    pub fn save(&self, credential: &StoredAnthropicCredential) -> Result<(), String> {
        let secret = serde_json::to_string(credential)
            .map_err(|_| "Sign-in credential could not be stored".to_owned())?;
        write_chunked(self.backend.as_ref(), CREDENTIAL_KEY, &secret)
    }

    pub fn clear(&self) -> Result<bool, String> {
        delete_chunked(self.backend.as_ref(), CREDENTIAL_KEY)
    }
}

#[cfg(test)]
pub(crate) mod memory_backend {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use super::SecretBackend;

    /// In-memory stand-in for the OS keyring. Clones share entries.
    #[derive(Clone, Default)]
    pub struct MemoryBackend {
        pub entries: Arc<Mutex<BTreeMap<String, String>>>,
    }

    impl SecretBackend for MemoryBackend {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.entries.lock().expect("entries").get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            self.entries
                .lock()
                .expect("entries")
                .insert(key.to_owned(), value.to_owned());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<bool, String> {
            Ok(self.entries.lock().expect("entries").remove(key).is_some())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::memory_backend::MemoryBackend;
    use super::*;

    fn credential(access_len: usize) -> StoredAnthropicCredential {
        StoredAnthropicCredential {
            access_token: "a".repeat(access_len),
            refresh_token: Some("sk-ant-ort-secret".to_owned()),
            expires_at: Some(1_800_000_000),
            account_email: Some("me@example.com".to_owned()),
            needs_reauth: false,
        }
    }

    #[test]
    fn small_and_large_credentials_round_trip() {
        let backend = MemoryBackend::default();
        let store = CredentialStore::new(Box::new(backend.clone()));
        assert_eq!(store.load(), Ok(None));

        let small = credential(10);
        store.save(&small).expect("save small");
        assert_eq!(store.load(), Ok(Some(small)));
        assert_eq!(backend.entries.lock().expect("entries").len(), 1);

        let large = credential(3500);
        store.save(&large).expect("save large");
        assert_eq!(store.load(), Ok(Some(large)));
        let entries = backend.entries.lock().expect("entries").clone();
        assert!(entries.len() > 1);
        assert!(entries
            .values()
            .all(|value| value.chars().count() <= KEYRING_CHUNK_CHARS));
    }

    #[test]
    fn shrinking_and_clearing_removes_stale_chunks() {
        let backend = MemoryBackend::default();
        let store = CredentialStore::new(Box::new(backend.clone()));
        store.save(&credential(3500)).expect("save large");
        store.save(&credential(10)).expect("save small");
        assert_eq!(backend.entries.lock().expect("entries").len(), 1);

        store.save(&credential(3500)).expect("save large");
        assert_eq!(store.clear(), Ok(true));
        assert!(backend.entries.lock().expect("entries").is_empty());
        assert_eq!(store.load(), Ok(None));
        assert_eq!(store.clear(), Ok(false));
    }

    #[test]
    fn corrupt_marker_is_an_error_not_a_crash() {
        let backend = MemoryBackend::default();
        backend
            .set(CREDENTIAL_KEY, r#"{"supaVideoChunkedV1":9999}"#)
            .expect("seed");
        let store = CredentialStore::new(Box::new(backend));
        assert!(store.load().is_err());
    }

    #[test]
    fn debug_output_never_contains_tokens() {
        let printed = format!("{:?}", credential(10));
        assert!(!printed.contains("aaaa"));
        assert!(!printed.contains("secret"));
    }

    #[test]
    fn service_name_is_scoped_to_the_app_identifier() {
        assert_eq!(
            keyring_service_name("com.supa.video"),
            "com.supa.video:ai-anthropic"
        );
    }
}
