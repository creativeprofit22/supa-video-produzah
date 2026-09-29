//! Token-endpoint plumbing shared by sign-in and refresh: a hardened HTTP
//! client, bounded body reads, and sanitized token errors.

use std::io::Read;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use serde::Deserialize;
use serde_json::Value;

/// Refresh this long before the access token actually expires.
pub const REFRESH_SKEW_SECONDS: i64 = 300;
/// Token responses are tiny; anything larger is not a token response.
pub const TOKEN_MAX_RESPONSE_BYTES: u64 = 64 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOKEN_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);

/// Failure of a token-endpoint call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenError {
    /// The provider answered 4xx (for example `invalid_grant`): authoritative,
    /// the refresh token is no longer usable.
    Rejected(String),
    /// Network error, 5xx or unreadable response: tokens may still be valid.
    Transient(String),
}

impl TokenError {
    pub fn message(&self) -> &str {
        match self {
            Self::Rejected(message) | Self::Transient(message) => message,
        }
    }
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

#[derive(Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub account: Option<AnthropicAccount>,
}

/// Never prints token material.
impl std::fmt::Debug for TokenResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TokenResponse")
            .field("expires_in", &self.expires_in)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AnthropicAccount {
    #[serde(default)]
    pub email_address: Option<String>,
}

/// A client that never follows redirects (a token endpoint must answer
/// directly) and enforces connect/total timeouts.
pub fn http_client(total_timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(total_timeout)
        .build()
        .map_err(|_| "The sign-in HTTP client could not be created".to_owned())
}

pub fn token_client() -> Result<Client, String> {
    http_client(TOKEN_TOTAL_TIMEOUT)
}

/// Reads at most `max_bytes` of the body; larger bodies are an error.
pub fn read_bounded_bytes(response: Response, max_bytes: u64) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(format!("Response exceeded the {max_bytes}-byte limit"));
    }
    let mut body = Vec::new();
    response
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut body)
        .map_err(|_| "Response body could not be read".to_owned())?;
    if body.len() as u64 > max_bytes {
        return Err(format!("Response exceeded the {max_bytes}-byte limit"));
    }
    Ok(body)
}

/// Keeps only a short OAuth error code (for example `invalid_grant`) from an
/// error body; everything else in the body is discarded.
pub fn oauth_error_code(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let raw = value.get("error").and_then(|error| match error {
        Value::String(code) => Some(code.as_str()),
        Value::Object(object) => object.get("type").and_then(Value::as_str),
        _ => None,
    })?;
    let code: String = raw
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .take(64)
        .collect();
    (!code.is_empty()).then_some(code)
}

/// POSTs a JSON body to a token endpoint and reads the response under the
/// size cap. 4xx is `Rejected`; network, 5xx and unreadable bodies are
/// `Transient`. Error text is fixed wording plus a sanitized OAuth code.
pub fn post_token_request(
    client: &Client,
    url: &str,
    body: &Value,
    headers: &[(&str, &str)],
    label: &str,
) -> Result<TokenResponse, TokenError> {
    let mut request = client
        .post(url)
        .header("Accept", "application/json")
        .json(body);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().map_err(|error| {
        let kind = if error.is_timeout() {
            "timed out"
        } else {
            "could not reach the provider"
        };
        TokenError::Transient(format!("{label} {kind}"))
    })?;
    let status = response.status();
    if status.is_success() {
        let bytes = read_bounded_bytes(response, TOKEN_MAX_RESPONSE_BYTES).map_err(|_| {
            TokenError::Transient(format!("{label} returned an unreadable response"))
        })?;
        let parsed: TokenResponse = serde_json::from_slice(&bytes).map_err(|_| {
            TokenError::Transient(format!("{label} returned an unreadable response"))
        })?;
        if parsed.access_token.trim().is_empty() {
            return Err(TokenError::Transient(format!(
                "{label} returned no access credential"
            )));
        }
        return Ok(parsed);
    }
    let body = read_bounded_bytes(response, TOKEN_MAX_RESPONSE_BYTES).unwrap_or_default();
    let code = oauth_error_code(&body)
        .map(|code| format!(": {code}"))
        .unwrap_or_default();
    let message = format!("{label} failed (HTTP {}{code})", status.as_u16());
    if status.is_client_error() {
        Err(TokenError::Rejected(message))
    } else {
        Err(TokenError::Transient(message))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::ai_account::test_support::spawn_fake_server;

    #[test]
    fn oauth_error_code_keeps_only_sanitized_code() {
        assert_eq!(
            oauth_error_code(br#"{"error":"invalid_grant","error_description":"secret stuff"}"#),
            Some("invalid_grant".to_owned())
        );
        assert_eq!(
            oauth_error_code(br#"{"error":{"type":"bad<script>req","message":"x"}}"#),
            Some("badscriptreq".to_owned())
        );
        assert_eq!(oauth_error_code(b"not json"), None);
        assert_eq!(oauth_error_code(br#"{"error":"!!!"}"#), None);
    }

    #[test]
    fn debug_output_never_contains_tokens() {
        let response: TokenResponse = serde_json::from_value(json!({
            "access_token": "sk-ant-oat-secret",
            "refresh_token": "sk-ant-ort-secret",
            "expires_in": 3600
        }))
        .expect("token response");
        let printed = format!("{response:?}");
        assert!(!printed.contains("secret"));
        assert!(printed.contains("3600"));
    }

    #[test]
    fn client_error_is_rejected_with_sanitized_text() {
        let server = spawn_fake_server(
            vec![(
                400,
                r#"{"error":"invalid_grant","error_description":"leaky detail"}"#.to_owned(),
            )],
            Duration::ZERO,
        );
        let client = token_client().expect("client");
        let error = post_token_request(&client, &server.url, &json!({}), &[], "Token refresh")
            .expect_err("4xx must fail");
        assert_eq!(
            error,
            TokenError::Rejected("Token refresh failed (HTTP 400: invalid_grant)".to_owned())
        );
        assert!(!error.message().contains("leaky"));
    }

    #[test]
    fn server_error_and_unreadable_success_are_transient() {
        let server = spawn_fake_server(
            vec![(503, "{}".to_owned()), (200, "not json".to_owned())],
            Duration::ZERO,
        );
        let client = token_client().expect("client");
        let first = post_token_request(&client, &server.url, &json!({}), &[], "Sign-in");
        assert!(matches!(first, Err(TokenError::Transient(_))));
        let second = post_token_request(&client, &server.url, &json!({}), &[], "Sign-in");
        assert_eq!(
            second.expect_err("unreadable"),
            TokenError::Transient("Sign-in returned an unreadable response".to_owned())
        );
    }

    #[test]
    fn redirects_are_not_followed() {
        let server = spawn_fake_server(vec![(302, "{}".to_owned())], Duration::ZERO);
        let client = token_client().expect("client");
        let error = post_token_request(&client, &server.url, &json!({}), &[], "Sign-in")
            .expect_err("redirect is not success");
        assert!(matches!(error, TokenError::Transient(_)));
        assert_eq!(server.hit_count(), 1);
    }

    #[test]
    fn oversized_success_body_is_transient() {
        let big = format!(
            r#"{{"access_token":"{}"}}"#,
            "a".repeat(TOKEN_MAX_RESPONSE_BYTES as usize)
        );
        let server = spawn_fake_server(vec![(200, big)], Duration::ZERO);
        let client = token_client().expect("client");
        let error = post_token_request(&client, &server.url, &json!({}), &[], "Sign-in")
            .expect_err("oversized");
        assert!(matches!(error, TokenError::Transient(_)));
    }
}
