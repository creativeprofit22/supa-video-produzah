//! Tauri surface for AI account sign-in. Tokens never cross IPC: the renderer
//! only ever sees connection status, the account email and the sign-in URL.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use super::anthropic_oauth;
use super::claude_cli_version::ClaudeCliVersionCache;
use super::credential_store::CredentialStore;
use super::error::AiAccountError;
use super::messages::{self, MessagesContext};
use super::pkce::{self, PendingSignIn, PendingSignInSlot};
use super::refresh::{credential_from_token_response, RefreshEndpoints, RefreshLock};
use super::token::{token_client, TokenError};

const TERMS_NOT_ACKNOWLEDGED_MESSAGE: &str =
    "Tick the acknowledgement before signing in with a Claude account";

/// Managed state. Cheap to clone into blocking workers.
#[derive(Clone)]
pub struct AiAccountService {
    store: Arc<CredentialStore>,
    refresh_lock: Arc<RefreshLock>,
    pending: Arc<PendingSignInSlot>,
    versions: Arc<ClaudeCliVersionCache>,
    app_data_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAccountStatus {
    pub connected: bool,
    pub email: Option<String>,
    pub needs_reauth: bool,
    pub sign_in_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSignInResult {
    pub auth_url: String,
    /// False when the browser could not be opened; the renderer shows the link.
    pub browser_opened: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSignInRequest {
    #[serde(default)]
    pub acknowledged: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitCodeRequest {
    pub code: String,
}

/// The renderer must relay an explicit acknowledgement; native code refuses
/// to start sign-in without it.
pub fn require_terms_acknowledgement(acknowledged: Option<bool>) -> Result<(), AiAccountError> {
    if acknowledged == Some(true) {
        Ok(())
    } else {
        Err(AiAccountError::TermsNotAcknowledged(
            TERMS_NOT_ACKNOWLEDGED_MESSAGE.to_owned(),
        ))
    }
}

impl AiAccountService {
    pub fn new(store: CredentialStore, app_data_dir: Option<PathBuf>) -> Self {
        Self {
            store: Arc::new(store),
            refresh_lock: Arc::new(RefreshLock::default()),
            pending: Arc::new(PendingSignInSlot::default()),
            versions: Arc::new(ClaudeCliVersionCache::default()),
            app_data_dir,
        }
    }

    pub fn status(&self, now: Instant) -> Result<AiAccountStatus, AiAccountError> {
        let credential = self.store.load().map_err(AiAccountError::Unavailable)?;
        let sign_in_pending = self.pending.is_pending(now);
        Ok(match credential {
            Some(credential) => AiAccountStatus {
                connected: !credential.needs_reauth,
                email: credential.account_email,
                needs_reauth: credential.needs_reauth,
                sign_in_pending,
            },
            None => AiAccountStatus {
                connected: false,
                email: None,
                needs_reauth: false,
                sign_in_pending,
            },
        })
    }

    /// Starts a new PKCE sign-in (replacing any earlier one) and returns the
    /// authorize URL.
    pub fn start_sign_in(
        &self,
        acknowledged: Option<bool>,
        now: Instant,
    ) -> Result<String, AiAccountError> {
        require_terms_acknowledgement(acknowledged)?;
        let state = anthropic_oauth::create_state();
        let verifier = pkce::create_verifier();
        let url = anthropic_oauth::build_authorize_url(&state, &pkce::challenge_for(&verifier));
        self.pending.start(PendingSignIn::new(state, verifier, now));
        Ok(url)
    }

    pub fn cancel_sign_in(&self) {
        self.pending.cancel();
    }

    /// Verifies the pasted `code#state` against the pending sign-in, exchanges
    /// it, and stores the credential. A wrong state leaves the pending
    /// sign-in usable.
    pub fn submit_code(
        &self,
        pasted: &str,
        token_urls: &[&str],
        now: Instant,
        unix_now: i64,
    ) -> Result<AiAccountStatus, AiAccountError> {
        let input =
            pkce::parse_authorization_input(pasted).map_err(AiAccountError::InvalidSignIn)?;
        let pending = self
            .pending
            .take_matching(&input, now)
            .map_err(AiAccountError::InvalidSignIn)?;
        let client = token_client().map_err(AiAccountError::Unavailable)?;
        let user_agent = self.user_agent();
        let response = anthropic_oauth::exchange_code(
            &client,
            token_urls,
            &input.code,
            &pending.state,
            &pending.verifier,
            &user_agent,
        )
        .map_err(|error| match error {
            TokenError::Rejected(message) => AiAccountError::InvalidSignIn(message),
            TokenError::Transient(message) => AiAccountError::Unavailable(message),
        })?;
        let credential = credential_from_token_response(response, None, unix_now);
        {
            // Only the save is locked, not the exchange above, so a slow
            // sign-in never blocks Messages calls. Waiting here lets a refresh
            // already in flight finish first instead of overwriting us later.
            let _guard = self.refresh_lock.hold();
            self.store
                .save(&credential)
                .map_err(AiAccountError::Unavailable)?;
        }
        self.status(now)
    }

    /// Waits for any in-flight refresh so it cannot save the old account back
    /// after the keyring is cleared.
    pub fn sign_out(&self) -> Result<(), AiAccountError> {
        self.pending.cancel();
        let _guard = self.refresh_lock.hold();
        self.store
            .clear()
            .map(|_| ())
            .map_err(AiAccountError::Unavailable)
    }

    fn user_agent(&self) -> String {
        self.versions.user_agent(self.app_data_dir.as_deref())
    }

    /// Calls the Anthropic Messages API with the signed-in account. Blocking:
    /// run it off the main thread.
    pub fn call_messages_blocking(&self, payload: &Value) -> Result<Value, AiAccountError> {
        let token_client = token_client().map_err(AiAccountError::Unavailable)?;
        let client = messages::messages_client()?;
        let user_agent = self.user_agent();
        let now = messages::unix_now;
        messages::call_messages_with(
            &MessagesContext {
                store: &self.store,
                refresh_lock: &self.refresh_lock,
                refresh: RefreshEndpoints {
                    client: &token_client,
                    token_urls: anthropic_oauth::TOKEN_URLS,
                    claude_cli_user_agent: &user_agent,
                },
                client: &client,
                messages_url: messages::MESSAGES_URL,
                now: &now,
            },
            payload,
        )
    }
}

/// Native entry point for future model producers: sends one Messages request
/// with the signed-in Claude account, off the main thread.
#[allow(dead_code, reason = "no model producer is wired to the account yet")]
pub async fn call_messages<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<Value, AiAccountError> {
    let service = app.state::<AiAccountService>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.call_messages_blocking(&payload))
        .await
        .map_err(|_| AiAccountError::Unavailable("Claude request worker stopped".to_owned()))?
}

async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AiAccountError> + Send + 'static,
) -> Result<T, AiAccountError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| AiAccountError::Unavailable("Sign-in worker stopped".to_owned()))?
}

#[tauri::command]
pub async fn ai_account_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AiAccountStatus, AiAccountError> {
    let service = app.state::<AiAccountService>().inner().clone();
    run_blocking(move || service.status(Instant::now())).await
}

#[tauri::command]
pub async fn ai_account_start_sign_in<R: Runtime>(
    app: AppHandle<R>,
    request: StartSignInRequest,
) -> Result<StartSignInResult, AiAccountError> {
    use tauri_plugin_opener::OpenerExt as _;

    let service = app.state::<AiAccountService>().inner().clone();
    let auth_url = service.start_sign_in(request.acknowledged, Instant::now())?;
    // Native code opens only the URL it built itself.
    let browser_opened = app.opener().open_url(&auth_url, None::<&str>).is_ok();
    Ok(StartSignInResult {
        auth_url,
        browser_opened,
    })
}

#[tauri::command]
pub async fn ai_account_submit_code<R: Runtime>(
    app: AppHandle<R>,
    request: SubmitCodeRequest,
) -> Result<AiAccountStatus, AiAccountError> {
    let service = app.state::<AiAccountService>().inner().clone();
    run_blocking(move || {
        service.submit_code(
            &request.code,
            anthropic_oauth::TOKEN_URLS,
            Instant::now(),
            messages::unix_now(),
        )
    })
    .await
}

#[tauri::command]
pub async fn ai_account_cancel_sign_in<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), AiAccountError> {
    app.state::<AiAccountService>().cancel_sign_in();
    Ok(())
}

#[tauri::command]
pub async fn ai_account_sign_out<R: Runtime>(app: AppHandle<R>) -> Result<(), AiAccountError> {
    let service = app.state::<AiAccountService>().inner().clone();
    run_blocking(move || service.sign_out()).await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::ai_account::credential_store::memory_backend::MemoryBackend;
    use crate::ai_account::credential_store::StoredAnthropicCredential;
    use crate::ai_account::refresh::{ensure_fresh, RefreshMode};
    use crate::ai_account::test_support::{request_json, spawn_fake_server};

    const OK_BODY: &str = r#"{"access_token":"at","refresh_token":"rt","expires_in":28800,"account":{"email_address":"me@example.com"}}"#;

    fn service() -> (AiAccountService, MemoryBackend) {
        let backend = MemoryBackend::default();
        let service = AiAccountService::new(CredentialStore::new(Box::new(backend.clone())), None);
        // Pin the UA so tests never reach npm.
        service.versions.resolve(
            None,
            crate::ai_account::claude_cli_version::now_ms(),
            || Some("2.1.283".to_owned()),
        );
        (service, backend)
    }

    fn state_of(url: &str) -> String {
        url::Url::parse(url)
            .expect("url")
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned())
            .expect("state")
    }

    #[test]
    fn sign_in_requires_explicit_terms_acknowledgement() {
        let (service, _) = service();
        let now = Instant::now();
        for acknowledged in [None, Some(false)] {
            assert!(matches!(
                service.start_sign_in(acknowledged, now),
                Err(AiAccountError::TermsNotAcknowledged(_))
            ));
        }
        assert!(!service.pending.is_pending(now));
        let url = service.start_sign_in(Some(true), now).expect("url");
        assert!(url.starts_with(anthropic_oauth::AUTHORIZE_URL));
        assert!(service.pending.is_pending(now));
    }

    #[test]
    fn paste_flow_stores_credential_and_status_hides_tokens() {
        let server = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::ZERO);
        let (service, backend) = service();
        let now = Instant::now();
        let url = service.start_sign_in(Some(true), now).expect("url");
        let state = state_of(&url);

        let status = service
            .submit_code(&format!("the-code#{state}"), &[&server.url], now, 1_000)
            .expect("connected");
        assert_eq!(
            status,
            AiAccountStatus {
                connected: true,
                email: Some("me@example.com".to_owned()),
                needs_reauth: false,
                sign_in_pending: false,
            }
        );
        let serialized = serde_json::to_string(&status).expect("json");
        assert!(!serialized.contains("\"at\"") && !serialized.contains("rt"));
        let body = request_json(&server.request(0));
        assert_eq!(body["code"], "the-code");
        assert_eq!(body["state"], state.as_str());
        assert_eq!(
            service
                .store
                .load()
                .expect("load")
                .expect("saved")
                .expires_at,
            Some(1_000 + 28800)
        );

        service.sign_out().expect("signed out");
        assert!(backend.entries.lock().expect("entries").is_empty());
        assert!(!service.status(now).expect("status").connected);
    }

    #[test]
    fn wrong_state_never_reaches_the_token_endpoint() {
        let server = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::ZERO);
        let (service, _) = service();
        let now = Instant::now();
        service.start_sign_in(Some(true), now).expect("url");
        let error = service
            .submit_code("the-code#forged", &[&server.url], now, 0)
            .expect_err("mismatch");
        assert!(matches!(error, AiAccountError::InvalidSignIn(_)));
        assert_eq!(server.hit_count(), 0);
        assert!(service.pending.is_pending(now));
    }

    #[test]
    fn rejected_exchange_is_an_invalid_sign_in() {
        let server = spawn_fake_server(
            vec![(400, r#"{"error":"invalid_grant"}"#.to_owned())],
            Duration::ZERO,
        );
        let (service, _) = service();
        let now = Instant::now();
        let url = service.start_sign_in(Some(true), now).expect("url");
        let error = service
            .submit_code(&format!("c#{}", state_of(&url)), &[&server.url], now, 0)
            .expect_err("rejected");
        assert!(matches!(error, AiAccountError::InvalidSignIn(_)));
        assert!(service.store.load().expect("load").is_none());
    }

    /// Starts a refresh against a slow token endpoint on another thread and
    /// returns once the endpoint has received the request.
    fn refresh_in_flight(
        service: &AiAccountService,
        server_url: String,
    ) -> std::thread::JoinHandle<Result<StoredAnthropicCredential, AiAccountError>> {
        let (store, lock) = (service.store.clone(), service.refresh_lock.clone());
        std::thread::spawn(move || {
            let client = token_client().expect("client");
            let urls = [server_url.as_str()];
            ensure_fresh(
                &store,
                &lock,
                &RefreshEndpoints {
                    client: &client,
                    token_urls: &urls,
                    claude_cli_user_agent: "claude-cli/2.1.283 (external, cli)",
                },
                messages::unix_now(),
                RefreshMode::IfExpiring,
            )
        })
    }

    fn wait_for_hit(server: &crate::ai_account::test_support::FakeServer) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while server.hit_count() == 0 {
            assert!(
                Instant::now() < deadline,
                "refresh never reached the endpoint"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn expiring_credential(email: &str) -> StoredAnthropicCredential {
        StoredAnthropicCredential {
            access_token: "old-at".to_owned(),
            refresh_token: Some("old-rt".to_owned()),
            expires_at: Some(0),
            account_email: Some(email.to_owned()),
            needs_reauth: false,
        }
    }

    #[test]
    fn refresh_finishing_after_sign_out_does_not_restore_the_credential() {
        let server = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::from_millis(400));
        let (service, _) = service();
        service
            .store
            .save(&expiring_credential("old@example.com"))
            .expect("seed");

        let refresh = refresh_in_flight(&service, server.url.clone());
        wait_for_hit(&server);
        service.sign_out().expect("sign out");
        let refreshed = refresh.join().expect("refresh thread");

        assert!(refreshed.is_ok(), "the in-flight refresh itself succeeds");
        assert_eq!(service.store.load().expect("load"), None);
        assert!(!service.status(Instant::now()).expect("status").connected);
    }

    #[test]
    fn refresh_finishing_after_a_new_sign_in_does_not_overwrite_it() {
        let slow_refresh =
            spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::from_millis(400));
        let exchange = spawn_fake_server(
            vec![(
                200,
                r#"{"access_token":"new-at","refresh_token":"new-rt","expires_in":28800,"account":{"email_address":"new@example.com"}}"#
                    .to_owned(),
            )],
            Duration::ZERO,
        );
        let (service, _) = service();
        service
            .store
            .save(&expiring_credential("old@example.com"))
            .expect("seed");
        let now = Instant::now();
        let url = service.start_sign_in(Some(true), now).expect("url");

        let refresh = refresh_in_flight(&service, slow_refresh.url.clone());
        wait_for_hit(&slow_refresh);
        service
            .submit_code(&format!("c#{}", state_of(&url)), &[&exchange.url], now, 0)
            .expect("sign in");
        refresh.join().expect("refresh thread").expect("refresh");

        let stored = service.store.load().expect("load").expect("signed in");
        assert_eq!(stored.access_token, "new-at");
        assert_eq!(stored.account_email.as_deref(), Some("new@example.com"));
    }
}
