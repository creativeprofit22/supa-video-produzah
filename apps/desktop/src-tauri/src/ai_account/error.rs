//! Errors surfaced by the AI account module. Messages are fixed wording plus
//! sanitized provider codes; they never contain token material.

use serde::Serialize;

pub const RECONNECT_MESSAGE: &str = "Claude sign-in expired — sign in again in Settings";
pub const NOT_SIGNED_IN_MESSAGE: &str = "No Claude account is signed in";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum AiAccountError {
    /// No credential is stored.
    NotSignedIn(String),
    /// The provider rejected the stored credential; the user must sign in again.
    NeedsReauth(String),
    /// The user has not acknowledged the terms warning.
    TermsNotAcknowledged(String),
    /// Bad pasted value, stale state, or no pending sign-in.
    InvalidSignIn(String),
    /// Network error, 5xx, unreadable response, or credential store trouble.
    Unavailable(String),
    /// The Messages API answered with a non-auth error status.
    Request(String),
}

impl AiAccountError {
    pub fn not_signed_in() -> Self {
        Self::NotSignedIn(NOT_SIGNED_IN_MESSAGE.to_owned())
    }

    pub fn needs_reauth() -> Self {
        Self::NeedsReauth(RECONNECT_MESSAGE.to_owned())
    }

    pub fn message(&self) -> &str {
        match self {
            Self::NotSignedIn(message)
            | Self::NeedsReauth(message)
            | Self::TermsNotAcknowledged(message)
            | Self::InvalidSignIn(message)
            | Self::Unavailable(message)
            | Self::Request(message) => message,
        }
    }
}

impl std::fmt::Display for AiAccountError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for AiAccountError {}
