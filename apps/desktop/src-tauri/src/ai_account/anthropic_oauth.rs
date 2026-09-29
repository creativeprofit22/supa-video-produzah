//! Anthropic (Claude plan) sign-in. Reuses the Claude Code public client;
//! Anthropic's terms prohibit this for third-party apps, so it is gated
//! behind an explicit user acknowledgement that native code enforces (see
//! docs/features/ai-account-sign-in.md). Every Anthropic-specific constant
//! lives here so a provider-side change is a one-file edit.

use reqwest::blocking::Client;
use serde_json::{json, Value};

use super::token::{post_token_request, TokenError, TokenResponse};

pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
/// Tried in order; the fallback is used only after a network error or 5xx.
pub const TOKEN_URLS: &[&str] = &[
    "https://platform.claude.com/v1/oauth/token",
    "https://console.anthropic.com/v1/oauth/token",
];
pub const REDIRECT_URI: &str = "https://platform.claude.com/oauth/code/callback";
pub const SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
pub const OAUTH_BETA: &str = "oauth-2025-04-20";

/// `crypto.randomBytes(16).toString("hex")`: claude.ai rejects a 22-char
/// base64url state with "Invalid request format".
pub fn create_state() -> String {
    let mut bytes = [0u8; 16];
    // The OS CSPRNG failing is unrecoverable; there is no safe fallback state.
    getrandom::getrandom(&mut bytes).expect("OS random number generator unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Same parameters, order and `application/x-www-form-urlencoded` encoding as
/// `new URLSearchParams({...})` in the reference client.
pub fn build_authorize_url(state: &str, pkce_challenge: &str) -> String {
    let params = [
        ("code", "true"),
        ("client_id", CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", REDIRECT_URI),
        ("scope", SCOPES),
        ("code_challenge", pkce_challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ];
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params)
        .finish();
    format!("{AUTHORIZE_URL}?{query}")
}

fn post_with_fallback(
    client: &Client,
    token_urls: &[&str],
    body: &Value,
    label: &str,
    claude_cli_user_agent: &str,
) -> Result<TokenResponse, TokenError> {
    let headers = [
        ("User-Agent", claude_cli_user_agent),
        ("anthropic-beta", OAUTH_BETA),
    ];
    let mut last_error = TokenError::Transient("No Anthropic token endpoint configured".to_owned());
    for url in token_urls {
        match post_token_request(client, url, body, &headers, label) {
            Ok(response) => return Ok(response),
            // 4xx is authoritative: another endpoint would say the same, and
            // the caller relies on it to mark the credential for reconnect.
            Err(error @ TokenError::Rejected(_)) => return Err(error),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

pub fn exchange_code(
    client: &Client,
    token_urls: &[&str],
    code: &str,
    state: &str,
    pkce_verifier: &str,
    claude_cli_user_agent: &str,
) -> Result<TokenResponse, TokenError> {
    post_with_fallback(
        client,
        token_urls,
        &json!({
            "grant_type": "authorization_code",
            "client_id": CLIENT_ID,
            "code": code,
            "state": state,
            "redirect_uri": REDIRECT_URI,
            "code_verifier": pkce_verifier,
        }),
        "Anthropic sign-in",
        claude_cli_user_agent,
    )
}

pub fn refresh(
    client: &Client,
    token_urls: &[&str],
    refresh_token: &str,
    claude_cli_user_agent: &str,
) -> Result<TokenResponse, TokenError> {
    post_with_fallback(
        client,
        token_urls,
        &json!({
            "grant_type": "refresh_token",
            "client_id": CLIENT_ID,
            "refresh_token": refresh_token,
        }),
        "Anthropic sign-in refresh",
        claude_cli_user_agent,
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::ai_account::test_support::{request_header, request_json, spawn_fake_server};
    use crate::ai_account::token::token_client;

    const UA: &str = "claude-cli/2.1.283 (external, cli)";
    const OK_BODY: &str = r#"{"access_token":"at","refresh_token":"rt","expires_in":28800,"account":{"uuid":"u1","email_address":"me@example.com"}}"#;

    #[test]
    fn authorize_url_matches_reference_url_search_params() {
        let state = "0123456789abcdef0123456789abcdef";
        let url = build_authorize_url(state, "challenge-1");
        assert_eq!(
            url,
            "https://claude.ai/oauth/authorize?code=true\
             &client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e\
             &response_type=code\
             &redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback\
             &scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload\
             &code_challenge=challenge-1\
             &code_challenge_method=S256\
             &state=0123456789abcdef0123456789abcdef"
        );
    }

    #[test]
    fn state_is_32_lowercase_hex_and_random() {
        let first = create_state();
        let second = create_state();
        for state in [&first, &second] {
            assert_eq!(state.len(), 32, "{state}");
            assert!(
                state.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
                "{state}"
            );
        }
        assert_ne!(first, second);
    }

    #[test]
    fn exchange_sends_json_with_claude_cli_identity() {
        let server = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::ZERO);
        let client = token_client().expect("client");
        let tokens = exchange_code(&client, &[&server.url], "c", "s", "v", UA).expect("ok");
        assert_eq!(
            tokens.account.and_then(|a| a.email_address).as_deref(),
            Some("me@example.com")
        );
        let request = server.request(0);
        assert_eq!(
            request_header(&request, "content-type").as_deref(),
            Some("application/json")
        );
        assert_eq!(request_header(&request, "user-agent").as_deref(), Some(UA));
        assert_eq!(
            request_header(&request, "anthropic-beta").as_deref(),
            Some(OAUTH_BETA)
        );
        let body = request_json(&request);
        assert_eq!(body["grant_type"], "authorization_code");
        assert_eq!(body["client_id"], CLIENT_ID);
        assert_eq!(body["code"], "c");
        assert_eq!(body["state"], "s");
        assert_eq!(body["code_verifier"], "v");
        assert_eq!(body["redirect_uri"], REDIRECT_URI);
    }

    #[test]
    fn fallback_is_used_only_after_5xx() {
        let client = token_client().expect("client");
        let failing = spawn_fake_server(vec![(502, "bad gateway".to_owned())], Duration::ZERO);
        let fallback = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::ZERO);
        let tokens = refresh(&client, &[&failing.url, &fallback.url], "rt", UA).expect("ok");
        assert_eq!(tokens.access_token, "at");
        assert_eq!((failing.hit_count(), fallback.hit_count()), (1, 1));
        assert_eq!(request_json(&fallback.request(0))["refresh_token"], "rt");

        let rejecting = spawn_fake_server(
            vec![(401, r#"{"error":"invalid_grant"}"#.to_owned())],
            Duration::ZERO,
        );
        let untouched = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::ZERO);
        let error = refresh(&client, &[&rejecting.url, &untouched.url], "rt", UA).unwrap_err();
        assert!(matches!(error, TokenError::Rejected(_)));
        assert_eq!(untouched.hit_count(), 0);
    }

    #[test]
    fn network_error_falls_through_to_next_endpoint() {
        let client = token_client().expect("client");
        let fallback = spawn_fake_server(vec![(200, OK_BODY.to_owned())], Duration::ZERO);
        // Port 9 on loopback is closed in the test environment.
        let tokens = refresh(
            &client,
            &["http://127.0.0.1:9/token", &fallback.url],
            "rt",
            UA,
        )
        .expect("ok");
        assert_eq!(tokens.access_token, "at");
    }
}
