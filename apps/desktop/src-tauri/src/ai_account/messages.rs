//! The one native way to call the Anthropic Messages API with the signed-in
//! Claude plan account. Callers pass a normal Messages request body; this adds
//! the Claude Code identity block, the OAuth headers and bearer token, and
//! retries exactly once after a forced refresh when the API answers 401.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use serde_json::{json, Value};

use super::credential_store::{CredentialStore, StoredAnthropicCredential};
use super::error::AiAccountError;
use super::refresh::{ensure_fresh, RefreshEndpoints, RefreshLock, RefreshMode};
use super::token::{http_client, read_bounded_bytes};

pub const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
/// Identity block Anthropic requires first in the system prompt for Claude
/// plan tokens.
pub const CLAUDE_CODE_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const OAUTH_BETAS: &str = "claude-code-20250219,oauth-2025-04-20";
const MESSAGES_MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const MESSAGES_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_PROVIDER_ERROR_CHARS: usize = 300;

pub fn messages_client() -> Result<Client, AiAccountError> {
    http_client(MESSAGES_TOTAL_TIMEOUT).map_err(AiAccountError::Unavailable)
}

/// Puts the identity block first, keeping any caller system prompt after it.
/// Streaming is refused: the helper reads one bounded JSON response.
pub fn with_identity(payload: &Value) -> Result<Value, AiAccountError> {
    let Value::Object(object) = payload else {
        return Err(AiAccountError::Request(
            "Messages request must be a JSON object".to_owned(),
        ));
    };
    if object.get("stream").and_then(Value::as_bool) == Some(true) {
        return Err(AiAccountError::Request(
            "Streaming Messages requests are not supported".to_owned(),
        ));
    }
    let mut object = object.clone();
    let mut system = vec![json!({ "type": "text", "text": CLAUDE_CODE_IDENTITY })];
    match object.remove("system") {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) if text.trim().is_empty() => {}
        Some(Value::String(text)) => system.push(json!({ "type": "text", "text": text })),
        Some(Value::Array(blocks)) => system.extend(blocks),
        Some(_) => {
            return Err(AiAccountError::Request(
                "Messages system prompt must be a string or an array".to_owned(),
            ))
        }
    }
    object.insert("system".to_owned(), Value::Array(system));
    Ok(Value::Object(object))
}

pub fn oauth_headers(user_agent: &str) -> [(&'static str, &str); 4] {
    [
        ("anthropic-version", ANTHROPIC_VERSION),
        ("anthropic-beta", OAUTH_BETAS),
        ("User-Agent", user_agent),
        ("x-app", "cli"),
    ]
}

/// Keeps a short, single-line provider message; nothing else from the body.
fn provider_error_message(body: &[u8]) -> String {
    let parsed = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let message = parsed
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| parsed.get("message").and_then(Value::as_str))
        .unwrap_or("Claude request failed");
    message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(MAX_PROVIDER_ERROR_CHARS)
        .collect()
}

/// A 401 is kept distinct so the caller can force one refresh and retry.
enum CallError {
    Unauthorized,
    Failed(AiAccountError),
}

fn send_once(
    client: &Client,
    messages_url: &str,
    credential: &StoredAnthropicCredential,
    user_agent: &str,
    body: &Value,
) -> Result<Value, CallError> {
    let mut request = client
        .post(messages_url)
        .bearer_auth(&credential.access_token)
        .json(body);
    for (name, value) in oauth_headers(user_agent) {
        request = request.header(name, value);
    }
    let response = request.send().map_err(|error| {
        let message = if error.is_timeout() {
            "Claude request timed out"
        } else {
            "Claude request could not reach Anthropic"
        };
        CallError::Failed(AiAccountError::Unavailable(message.to_owned()))
    })?;
    let status = response.status();
    if status.as_u16() == 401 {
        return Err(CallError::Unauthorized);
    }
    if status.is_redirection() {
        return Err(CallError::Failed(AiAccountError::Request(format!(
            "Claude request was redirected (HTTP {}); redirects are not followed",
            status.as_u16()
        ))));
    }
    let bytes = read_bounded_bytes(response, MESSAGES_MAX_RESPONSE_BYTES)
        .map_err(|message| CallError::Failed(AiAccountError::Unavailable(message)))?;
    if !status.is_success() {
        let message = format!(
            "{} (HTTP {})",
            provider_error_message(&bytes),
            status.as_u16()
        );
        return Err(CallError::Failed(if status.is_server_error() {
            AiAccountError::Unavailable(message)
        } else {
            AiAccountError::Request(message)
        }));
    }
    serde_json::from_slice::<Value>(&bytes).map_err(|_| {
        CallError::Failed(AiAccountError::Unavailable(
            "Claude response was not valid JSON".to_owned(),
        ))
    })
}

/// Everything `call_messages_with` needs, injectable for tests.
pub struct MessagesContext<'a> {
    pub store: &'a CredentialStore,
    pub refresh_lock: &'a RefreshLock,
    pub refresh: RefreshEndpoints<'a>,
    pub client: &'a Client,
    pub messages_url: &'a str,
    pub now: &'a dyn Fn() -> i64,
}

/// Sends `payload` with the signed-in account. On 401 the credential is
/// force-refreshed once (unless another caller already replaced it) and the
/// request retried once; a second 401 means the user must sign in again.
pub fn call_messages_with(
    context: &MessagesContext<'_>,
    payload: &Value,
) -> Result<Value, AiAccountError> {
    let body = with_identity(payload)?;
    let user_agent = context.refresh.claude_cli_user_agent;
    let credential = ensure_fresh(
        context.store,
        context.refresh_lock,
        &context.refresh,
        (context.now)(),
        RefreshMode::IfExpiring,
    )?;
    match send_once(
        context.client,
        context.messages_url,
        &credential,
        user_agent,
        &body,
    ) {
        Ok(response) => Ok(response),
        Err(CallError::Failed(error)) => Err(error),
        Err(CallError::Unauthorized) => {
            let refreshed = ensure_fresh(
                context.store,
                context.refresh_lock,
                &context.refresh,
                (context.now)(),
                RefreshMode::AfterRejected(&credential.access_token),
            )?;
            match send_once(context.client, context.messages_url, &refreshed, user_agent, &body) {
                Ok(response) => Ok(response),
                Err(CallError::Failed(error)) => Err(error),
                Err(CallError::Unauthorized) => Err(AiAccountError::NeedsReauth(
                    "Anthropic rejected the signed-in Claude account (HTTP 401); sign in again in Settings"
                        .to_owned(),
                )),
            }
        }
    }
}

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::ai_account::credential_store::memory_backend::MemoryBackend;
    use crate::ai_account::test_support::{
        request_header, request_json, spawn_fake_server, FakeServer,
    };
    use crate::ai_account::token::token_client;

    const NOW: i64 = 1_800_000_000;
    const UA: &str = "claude-cli/2.1.283 (external, cli)";
    const REPLY: &str = r#"{"id":"msg_1","content":[{"type":"text","text":"hi"}]}"#;
    const TOKEN_OK: &str =
        r#"{"access_token":"new-at","refresh_token":"new-rt","expires_in":28800}"#;

    fn store() -> CredentialStore {
        let store = CredentialStore::new(Box::new(MemoryBackend::default()));
        store
            .save(&StoredAnthropicCredential {
                access_token: "old-at".to_owned(),
                refresh_token: Some("old-rt".to_owned()),
                expires_at: Some(NOW + 3600),
                account_email: None,
                needs_reauth: false,
            })
            .expect("seed");
        store
    }

    fn call(
        store: &CredentialStore,
        api: &FakeServer,
        tokens: &FakeServer,
        payload: &Value,
    ) -> Result<Value, AiAccountError> {
        let token_client = token_client().expect("client");
        let client = messages_client().expect("client");
        let urls = [tokens.url.as_str()];
        let lock = RefreshLock::default();
        let now = || NOW;
        call_messages_with(
            &MessagesContext {
                store,
                refresh_lock: &lock,
                refresh: RefreshEndpoints {
                    client: &token_client,
                    token_urls: &urls,
                    claude_cli_user_agent: UA,
                },
                client: &client,
                messages_url: &api.url,
                now: &now,
            },
            payload,
        )
    }

    fn payload() -> Value {
        json!({
            "model": "claude-sonnet-4-5",
            "max_tokens": 64,
            "system": "Summarize the clip.",
            "messages": [{ "role": "user", "content": "hello" }]
        })
    }

    #[test]
    fn identity_block_comes_first_and_caller_system_follows() {
        let body = with_identity(&payload()).expect("body");
        assert_eq!(
            body["system"],
            json!([
                { "type": "text", "text": CLAUDE_CODE_IDENTITY },
                { "type": "text", "text": "Summarize the clip." }
            ])
        );
        let blocks =
            with_identity(&json!({ "system": [{ "type": "text", "text": "a" }] })).expect("body");
        assert_eq!(blocks["system"][0]["text"], CLAUDE_CODE_IDENTITY);
        assert_eq!(blocks["system"][1]["text"], "a");
        let none = with_identity(&json!({})).expect("body");
        assert_eq!(none["system"].as_array().map(Vec::len), Some(1));
        assert!(with_identity(&json!({ "stream": true })).is_err());
        assert!(with_identity(&json!("x")).is_err());
        assert!(with_identity(&json!({ "system": 3 })).is_err());
    }

    #[test]
    fn sends_exact_oauth_headers_and_bearer() {
        let api = spawn_fake_server(vec![(200, REPLY.to_owned())], Duration::ZERO);
        let tokens = spawn_fake_server(vec![(200, TOKEN_OK.to_owned())], Duration::ZERO);
        let response = call(&store(), &api, &tokens, &payload()).expect("ok");
        assert_eq!(response["id"], "msg_1");
        let request = api.request(0);
        for (name, value) in [
            ("authorization", "Bearer old-at"),
            ("anthropic-version", "2023-06-01"),
            ("anthropic-beta", "claude-code-20250219,oauth-2025-04-20"),
            ("user-agent", UA),
            ("x-app", "cli"),
        ] {
            assert_eq!(
                request_header(&request, name).as_deref(),
                Some(value),
                "{name}"
            );
        }
        assert_eq!(
            request_json(&request)["system"][0]["text"],
            CLAUDE_CODE_IDENTITY
        );
        assert_eq!(tokens.hit_count(), 0);
    }

    #[test]
    fn unauthorized_forces_one_refresh_and_one_retry() {
        let api = spawn_fake_server(
            vec![(401, "{}".to_owned()), (200, REPLY.to_owned())],
            Duration::ZERO,
        );
        let tokens = spawn_fake_server(vec![(200, TOKEN_OK.to_owned())], Duration::ZERO);
        let store = store();
        let response = call(&store, &api, &tokens, &payload()).expect("ok");
        assert_eq!(response["id"], "msg_1");
        assert_eq!((api.hit_count(), tokens.hit_count()), (2, 1));
        assert_eq!(
            request_header(&api.request(1), "authorization").as_deref(),
            Some("Bearer new-at")
        );
        assert_eq!(
            store.load().expect("load").expect("some").access_token,
            "new-at"
        );
    }

    #[test]
    fn second_unauthorized_asks_for_sign_in_without_looping() {
        let api = spawn_fake_server(vec![(401, "{}".to_owned())], Duration::ZERO);
        let tokens = spawn_fake_server(vec![(200, TOKEN_OK.to_owned())], Duration::ZERO);
        let error = call(&store(), &api, &tokens, &payload()).expect_err("fails");
        assert!(matches!(error, AiAccountError::NeedsReauth(_)));
        assert_eq!((api.hit_count(), tokens.hit_count()), (2, 1));
    }

    #[test]
    fn provider_errors_are_short_and_never_retried() {
        let api = spawn_fake_server(
            vec![(
                400,
                r#"{"error":{"type":"invalid_request_error","message":"max_tokens: too big\nline"}}"#
                    .to_owned(),
            )],
            Duration::ZERO,
        );
        let tokens = spawn_fake_server(vec![(200, TOKEN_OK.to_owned())], Duration::ZERO);
        let error = call(&store(), &api, &tokens, &payload()).expect_err("fails");
        assert_eq!(
            error,
            AiAccountError::Request("max_tokens: too big line (HTTP 400)".to_owned())
        );
        assert_eq!(api.hit_count(), 1);
    }

    #[test]
    fn signed_out_account_sends_nothing() {
        let api = spawn_fake_server(vec![(200, REPLY.to_owned())], Duration::ZERO);
        let tokens = spawn_fake_server(vec![(200, TOKEN_OK.to_owned())], Duration::ZERO);
        let empty = CredentialStore::new(Box::new(MemoryBackend::default()));
        let error = call(&empty, &api, &tokens, &payload()).expect_err("fails");
        assert_eq!(error, AiAccountError::not_signed_in());
        assert_eq!(api.hit_count(), 0);
    }
}
