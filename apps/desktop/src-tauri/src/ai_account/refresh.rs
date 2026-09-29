//! Keeps the stored Anthropic credential usable: refreshes it inside the
//! expiry skew window (or after a 401), one refresh at a time.

use std::sync::{Mutex, MutexGuard};

use reqwest::blocking::Client;

use super::anthropic_oauth;
use super::credential_store::{CredentialStore, StoredAnthropicCredential};
use super::error::AiAccountError;
use super::token::{TokenError, TokenResponse, REFRESH_SKEW_SECONDS};

/// Managed state: serializes every write of the stored credential. Refreshes
/// hold it across the token call, so concurrent callers make exactly one
/// token-endpoint call (Anthropic rotates refresh tokens), and sign-in /
/// sign-out take it before writing, so a refresh already in flight can never
/// save over them afterwards.
#[derive(Debug, Default)]
pub struct RefreshLock(Mutex<()>);

impl RefreshLock {
    /// A panic while holding the lock cannot leave `()` half-written.
    pub fn hold(&self) -> MutexGuard<'_, ()> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Where and how to refresh. Tests point `token_urls` at a fake server.
pub struct RefreshEndpoints<'a> {
    pub client: &'a Client,
    pub token_urls: &'a [&'a str],
    pub claude_cli_user_agent: &'a str,
}

/// When to refresh.
#[derive(Debug, Clone, Copy)]
pub enum RefreshMode<'a> {
    /// Refresh only inside the expiry skew window.
    IfExpiring,
    /// The provider answered 401 for this access token: refresh unless another
    /// caller already replaced it.
    AfterRejected(&'a str),
}

/// Builds the stored credential from a token response, keeping the previous
/// refresh token and email when the response omits them.
pub fn credential_from_token_response(
    response: TokenResponse,
    previous: Option<&StoredAnthropicCredential>,
    now: i64,
) -> StoredAnthropicCredential {
    let refresh_token = response
        .refresh_token
        .filter(|token| !token.trim().is_empty())
        .or_else(|| previous.and_then(|previous| previous.refresh_token.clone()));
    let account_email = response
        .account
        .and_then(|account| account.email_address)
        .filter(|email| !email.trim().is_empty())
        .or_else(|| previous.and_then(|previous| previous.account_email.clone()));
    StoredAnthropicCredential {
        access_token: response.access_token,
        refresh_token,
        expires_at: response.expires_in.map(|seconds| now + seconds.max(0)),
        account_email,
        needs_reauth: false,
    }
}

/// True when the access token should be refreshed now.
pub fn needs_refresh(credential: &StoredAnthropicCredential, now: i64) -> bool {
    credential.access_token.is_empty()
        || credential
            .expires_at
            .is_some_and(|expires_at| expires_at <= now + REFRESH_SKEW_SECONDS)
}

/// Returns a usable credential, refreshing it first when needed.
///
/// - 4xx from the token endpoint: tokens are cleared, `needs_reauth` is saved
///   (keeping the email), and `NeedsReauth` is returned.
/// - Network error / 5xx: the stored tokens are kept and `Unavailable` returned.
pub fn ensure_fresh(
    store: &CredentialStore,
    lock: &RefreshLock,
    endpoints: &RefreshEndpoints<'_>,
    now: i64,
    mode: RefreshMode<'_>,
) -> Result<StoredAnthropicCredential, AiAccountError> {
    // Held until the new credential is saved: see `RefreshLock`.
    let _guard = lock.hold();

    let current = store
        .load()
        .map_err(AiAccountError::Unavailable)?
        .ok_or_else(AiAccountError::not_signed_in)?;
    if current.needs_reauth {
        return Err(AiAccountError::needs_reauth());
    }
    let must_refresh = match mode {
        RefreshMode::IfExpiring => needs_refresh(&current, now),
        RefreshMode::AfterRejected(rejected) => current.access_token == rejected,
    };
    if !must_refresh {
        return Ok(current);
    }
    let Some(refresh_token) = current
        .refresh_token
        .clone()
        .filter(|token| !token.is_empty())
    else {
        mark_needs_reauth(store, current)?;
        return Err(AiAccountError::needs_reauth());
    };

    match anthropic_oauth::refresh(
        endpoints.client,
        endpoints.token_urls,
        &refresh_token,
        endpoints.claude_cli_user_agent,
    ) {
        Ok(response) => {
            let next = credential_from_token_response(response, Some(&current), now);
            store.save(&next).map_err(AiAccountError::Unavailable)?;
            Ok(next)
        }
        Err(TokenError::Rejected(_)) => {
            mark_needs_reauth(store, current)?;
            Err(AiAccountError::needs_reauth())
        }
        Err(TokenError::Transient(message)) => Err(AiAccountError::Unavailable(message)),
    }
}

fn mark_needs_reauth(
    store: &CredentialStore,
    mut credential: StoredAnthropicCredential,
) -> Result<(), AiAccountError> {
    credential.access_token.clear();
    credential.refresh_token = None;
    credential.needs_reauth = true;
    store.save(&credential).map_err(AiAccountError::Unavailable)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::ai_account::credential_store::memory_backend::MemoryBackend;
    use crate::ai_account::test_support::{request_json, spawn_fake_server};
    use crate::ai_account::token::token_client;

    const NOW: i64 = 1_800_000_000;
    const UA: &str = "claude-cli/2.1.283 (external, cli)";
    const OK_BODY: &str =
        r#"{"access_token":"new-at","refresh_token":"new-rt","expires_in":28800}"#;

    fn seeded(expires_at: i64) -> CredentialStore {
        let store = CredentialStore::new(Box::new(MemoryBackend::default()));
        store
            .save(&StoredAnthropicCredential {
                access_token: "old-at".to_owned(),
                refresh_token: Some("old-rt".to_owned()),
                expires_at: Some(expires_at),
                account_email: Some("me@example.com".to_owned()),
                needs_reauth: false,
            })
            .expect("seed");
        store
    }

    fn run(
        store: &CredentialStore,
        url: &str,
        mode: RefreshMode<'_>,
    ) -> Result<StoredAnthropicCredential, AiAccountError> {
        let client = token_client().expect("client");
        let urls = [url];
        ensure_fresh(
            store,
            &RefreshLock::default(),
            &RefreshEndpoints {
                client: &client,
                token_urls: &urls,
                claude_cli_user_agent: UA,
            },
            NOW,
            mode,
        )
    }

    #[test]
    fn fresh_token_is_returned_without_calling_provider() {
        let server = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::ZERO);
        let store = seeded(NOW + REFRESH_SKEW_SECONDS + 60);
        let credential = run(&store, &server.url, RefreshMode::IfExpiring).expect("fresh");
        assert_eq!(credential.access_token, "old-at");
        assert_eq!(server.hit_count(), 0);
    }

    #[test]
    fn expiring_token_is_refreshed_and_saved() {
        let server = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::ZERO);
        let store = seeded(NOW + REFRESH_SKEW_SECONDS - 1);
        let credential = run(&store, &server.url, RefreshMode::IfExpiring).expect("refreshed");
        assert_eq!(credential.access_token, "new-at");
        assert_eq!(credential.refresh_token.as_deref(), Some("new-rt"));
        assert_eq!(credential.expires_at, Some(NOW + 28800));
        assert_eq!(credential.account_email.as_deref(), Some("me@example.com"));
        assert_eq!(store.load().expect("load"), Some(credential));
        assert_eq!(request_json(&server.request(0))["refresh_token"], "old-rt");
    }

    #[test]
    fn rejected_refresh_clears_tokens_and_marks_reauth() {
        let server = spawn_fake_server(
            vec![(400, r#"{"error":"invalid_grant"}"#.to_owned())],
            Duration::ZERO,
        );
        let store = seeded(NOW - 1);
        let error = run(&store, &server.url, RefreshMode::IfExpiring).expect_err("rejected");
        assert_eq!(error, AiAccountError::needs_reauth());
        let stored = store.load().expect("load").expect("kept");
        assert!(stored.needs_reauth);
        assert!(stored.access_token.is_empty());
        assert_eq!(stored.refresh_token, None);
        assert_eq!(stored.account_email.as_deref(), Some("me@example.com"));

        // Later calls fail fast without contacting the provider.
        let again = run(&store, &server.url, RefreshMode::IfExpiring).expect_err("still");
        assert_eq!(again, AiAccountError::needs_reauth());
        assert_eq!(server.hit_count(), 1);
    }

    #[test]
    fn server_error_keeps_tokens() {
        let server = spawn_fake_server(vec![(503, "{}".to_owned())], Duration::ZERO);
        let store = seeded(NOW - 1);
        let error = run(&store, &server.url, RefreshMode::IfExpiring).expect_err("transient");
        assert!(matches!(error, AiAccountError::Unavailable(_)));
        let stored = store.load().expect("load").expect("kept");
        assert_eq!(stored.access_token, "old-at");
        assert!(!stored.needs_reauth);
    }

    #[test]
    fn after_rejected_refreshes_only_if_token_unchanged() {
        let server = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::ZERO);
        let store = seeded(NOW + 10_000);
        let unchanged = run(
            &store,
            &server.url,
            RefreshMode::AfterRejected("someone-else"),
        )
        .expect("already replaced");
        assert_eq!(unchanged.access_token, "old-at");
        assert_eq!(server.hit_count(), 0);

        let refreshed =
            run(&store, &server.url, RefreshMode::AfterRejected("old-at")).expect("refreshed");
        assert_eq!(refreshed.access_token, "new-at");
        assert_eq!(server.hit_count(), 1);
    }

    #[test]
    fn missing_credential_is_not_signed_in() {
        let store = CredentialStore::new(Box::new(MemoryBackend::default()));
        let error =
            run(&store, "http://127.0.0.1:9/token", RefreshMode::IfExpiring).expect_err("none");
        assert_eq!(error, AiAccountError::not_signed_in());
    }

    #[test]
    fn concurrent_callers_make_exactly_one_refresh_call() {
        let server = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::from_millis(150));
        let store = Arc::new(seeded(NOW - 1));
        let lock = Arc::new(RefreshLock::default());
        let url = Arc::new(server.url.clone());
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (store, lock, url) = (store.clone(), lock.clone(), url.clone());
                std::thread::spawn(move || {
                    let client = token_client().expect("client");
                    let urls = [url.as_str()];
                    ensure_fresh(
                        &store,
                        &lock,
                        &RefreshEndpoints {
                            client: &client,
                            token_urls: &urls,
                            claude_cli_user_agent: UA,
                        },
                        NOW,
                        RefreshMode::IfExpiring,
                    )
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(
                handle.join().expect("thread").expect("ok").access_token,
                "new-at"
            );
        }
        assert_eq!(server.hit_count(), 1);
    }

    #[test]
    fn errors_never_contain_token_values() {
        let server = spawn_fake_server(
            vec![(
                500,
                r#"{"error":"server_error","error_description":"old-at old-rt"}"#.to_owned(),
            )],
            Duration::ZERO,
        );
        let store = seeded(NOW - 1);
        let error = run(&store, &server.url, RefreshMode::IfExpiring).expect_err("fails");
        assert!(error.message().contains("server_error"));
        assert!(!error.message().contains("old-"));
    }
}
