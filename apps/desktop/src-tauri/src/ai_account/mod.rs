//! AI account sign-in: Claude plan OAuth (PKCE + paste-code), tokens kept in
//! the OS keyring, automatic refresh, and one native Messages API helper.
//! Tokens never cross IPC.

pub(crate) mod anthropic_oauth;
pub(crate) mod claude_cli_version;
pub(crate) mod commands;
pub(crate) mod credential_store;
pub(crate) mod error;
pub(crate) mod messages;
pub(crate) mod pkce;
pub(crate) mod refresh;
pub(crate) mod token;

#[cfg(test)]
pub(crate) mod test_support;
