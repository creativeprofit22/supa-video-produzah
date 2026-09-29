//! PKCE (S256) and the one pending sign-in the paste-code flow waits on.
//! The pending session lives only in memory: a restart simply means starting
//! sign-in again, and no verifier is ever written to disk.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};

/// How long a started sign-in stays valid for a pasted code.
pub const PENDING_SIGN_IN_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_AUTHORIZATION_INPUT_CHARS: usize = 4096;

/// RFC 7636 verifier: 32 random bytes as 43 base64url characters.
pub fn create_verifier() -> String {
    let mut bytes = [0u8; 32];
    // The OS CSPRNG failing is unrecoverable; there is no safe fallback.
    getrandom::getrandom(&mut bytes).expect("OS random number generator unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// RFC 7636 `S256` challenge for a verifier.
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// A started sign-in waiting for the user to paste the code.
pub struct PendingSignIn {
    pub state: String,
    pub verifier: String,
    started_at: Instant,
}

impl PendingSignIn {
    pub fn new(state: String, verifier: String, now: Instant) -> Self {
        Self {
            state,
            verifier,
            started_at: now,
        }
    }

    fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.started_at) > PENDING_SIGN_IN_TTL
    }
}

/// Managed state holding at most one pending sign-in.
#[derive(Default)]
pub struct PendingSignInSlot(Mutex<Option<PendingSignIn>>);

impl PendingSignInSlot {
    /// Replaces any earlier pending sign-in.
    pub fn start(&self, pending: PendingSignIn) {
        *self.lock() = Some(pending);
    }

    pub fn cancel(&self) {
        *self.lock() = None;
    }

    /// Checks the pasted state against the pending sign-in *before* consuming
    /// it, so a wrong or stale paste leaves the real sign-in usable.
    pub fn take_matching(
        &self,
        input: &AuthorizationInput,
        now: Instant,
    ) -> Result<PendingSignIn, String> {
        let mut slot = self.lock();
        let Some(pending) = slot.as_ref() else {
            return Err("No sign-in is in progress; start sign-in again".to_owned());
        };
        if pending.expired(now) {
            *slot = None;
            return Err("Sign-in expired; start sign-in again".to_owned());
        }
        ensure_state_matches(&pending.state, input)?;
        slot.take()
            .ok_or_else(|| "No sign-in is in progress; start sign-in again".to_owned())
    }

    pub fn is_pending(&self, now: Instant) -> bool {
        self.lock()
            .as_ref()
            .is_some_and(|pending| !pending.expired(now))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<PendingSignIn>> {
        // A panic while holding this lock cannot leave the Option half-written.
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Code and state pulled from what the user pasted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationInput {
    pub code: String,
    pub state: String,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn code_and_state<'a>(
    pairs: impl Iterator<Item = (std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>,
) -> (Option<String>, Option<String>) {
    let mut code = None;
    let mut state = None;
    for (key, item) in pairs {
        match key.as_ref() {
            "code" => code = Some(item.into_owned()),
            "state" => state = Some(item.into_owned()),
            _ => {}
        }
    }
    (code, state)
}

/// Accepts `code#state` (what the Anthropic callback page shows), a full
/// callback URL, or a `code=…&state=…` query string. State is required so it
/// can be checked before any exchange.
pub fn parse_authorization_input(input: &str) -> Result<AuthorizationInput, String> {
    let value = input.trim();
    if value.is_empty() {
        return Err("Paste the sign-in code".to_owned());
    }
    if value.chars().count() > MAX_AUTHORIZATION_INPUT_CHARS {
        return Err("Pasted sign-in value is too long".to_owned());
    }
    let (code, state) = if let Ok(url) = url::Url::parse(value) {
        code_and_state(url.query_pairs())
    } else if value.contains("code=") {
        let query = value.trim_start_matches('?');
        code_and_state(url::form_urlencoded::parse(query.as_bytes()))
    } else if let Some((code, state)) = value.split_once('#') {
        (Some(code.to_owned()), Some(state.to_owned()))
    } else {
        (Some(value.to_owned()), None)
    };
    let code = non_empty(code).ok_or_else(|| "No sign-in code was found".to_owned())?;
    let state = non_empty(state)
        .ok_or_else(|| "Paste the full code#state value shown after sign-in".to_owned())?;
    if code.chars().any(char::is_whitespace) || state.chars().any(char::is_whitespace) {
        return Err("Pasted sign-in value is malformed".to_owned());
    }
    Ok(AuthorizationInput { code, state })
}

/// Rejects a pasted value whose state is not the one this flow started with.
pub fn ensure_state_matches(
    expected_state: &str,
    input: &AuthorizationInput,
) -> Result<(), String> {
    if expected_state.is_empty() || input.state != expected_state {
        return Err("Sign-in state did not match; start sign-in again".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s256_matches_rfc7636_vector() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_is_43_base64url_chars_and_random() {
        let first = create_verifier();
        let second = create_verifier();
        assert_eq!(first.len(), 43);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(first, second);
    }

    #[test]
    fn parses_all_supported_authorization_input_forms() {
        let expected = AuthorizationInput {
            code: "abc123".to_owned(),
            state: "st4te".to_owned(),
        };
        for input in [
            "abc123#st4te",
            "  https://platform.claude.com/oauth/code/callback?state=st4te&code=abc123 ",
            "code=abc123&state=st4te",
            "?code=abc123&state=st4te",
        ] {
            assert_eq!(
                parse_authorization_input(input).as_ref(),
                Ok(&expected),
                "{input}"
            );
        }
    }

    #[test]
    fn rejects_garbage_and_stateless_authorization_input() {
        for input in [
            "",
            "   ",
            "abc123",
            "#st4te",
            "abc#",
            "code=&state=x",
            "a b#c",
        ] {
            assert!(parse_authorization_input(input).is_err(), "{input:?}");
        }
        assert!(parse_authorization_input(&"x".repeat(5000)).is_err());
    }

    #[test]
    fn wrong_state_keeps_the_pending_sign_in() {
        let slot = PendingSignInSlot::default();
        let now = Instant::now();
        slot.start(PendingSignIn::new("expected".into(), "v".into(), now));

        let wrong = parse_authorization_input("abc#other").expect("parsed");
        assert!(slot.take_matching(&wrong, now).is_err());
        assert!(slot.is_pending(now));

        let right = parse_authorization_input("abc#expected").expect("parsed");
        let pending = slot.take_matching(&right, now).expect("matches");
        assert_eq!(pending.verifier, "v");
        assert!(!slot.is_pending(now));
        assert!(slot.take_matching(&right, now).is_err(), "single use");
    }

    #[test]
    fn expired_and_cancelled_sign_ins_are_refused() {
        let slot = PendingSignInSlot::default();
        let start = Instant::now();
        slot.start(PendingSignIn::new("s".into(), "v".into(), start));
        let input = parse_authorization_input("abc#s").expect("parsed");
        let later = start + PENDING_SIGN_IN_TTL + Duration::from_secs(1);
        assert_eq!(
            slot.take_matching(&input, later).err().as_deref(),
            Some("Sign-in expired; start sign-in again")
        );

        slot.start(PendingSignIn::new("s".into(), "v".into(), start));
        slot.cancel();
        assert!(slot.take_matching(&input, start).is_err());
    }

    #[test]
    fn empty_expected_state_never_matches() {
        let input = parse_authorization_input("abc#x").expect("parsed");
        assert!(ensure_state_matches("", &input).is_err());
    }
}
