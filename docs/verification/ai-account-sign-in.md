# Verification: Claude plan account sign-in

Feature doc: [`docs/features/ai-account-sign-in.md`](../features/ai-account-sign-in.md).

Labels: **RUNTIME** (observed by running it), **NOT VERIFIED** (not yet run).

## Automated checks (RUNTIME, 2026-09-29, Windows)

Native tests in `apps/desktop/src-tauri/src/ai_account/` (`cargo test --all-features --lib ai_account`, 49 passed) cover:

- Authorize URL matches the reference parameter order and encoding exactly; state is 32 lowercase hex characters.
- PKCE S256 matches the RFC 7636 Appendix B vector; `code#state`, callback URL and query-string pastes parse; stateless, empty, whitespace and oversize pastes are rejected; a wrong state keeps the pending sign-in; expired and cancelled sign-ins are refused.
- Token endpoint (local fake server): JSON body, `claude-cli` User-Agent and `anthropic-beta` header; fallback URL used only after a 5xx or network error; 4xx is final; oversize responses rejected; error text keeps only the sanitized OAuth code.
- Refresh: fresh token is not refreshed; expiring token is refreshed and saved; 4xx clears tokens and sets `needs_reauth`; 5xx keeps tokens; concurrent callers make one token request; a forced refresh after a 401 is skipped when another caller already replaced the token; a refresh still in flight when the user signs out does not bring the credential back, and one in flight during a new sign-in does not overwrite the new account.
- Messages: identity block first in `system`, exact headers and bearer token; 401 triggers exactly one refresh and one retry; a second 401 asks the user to sign in again; a signed-out account sends nothing.
- Keyring chunking round trip over 2560 bytes, stale chunks removed on shrink, a corrupt chunk marker is reported as an error; `Debug` output never contains tokens.
- IPC smoke test (`lib.rs`): status carries no token material; sign-in without acknowledgement is refused; paste without a pending sign-in is refused; sign out clears the account.

Renderer tests in `apps/desktop/src/ai-account/AiAccountSettings.test.tsx`: acknowledgement gates the sign-in button; paste flow connects and shows the email; the code field follows the backend's `signInPending` (kept after a wrong state, hidden when a failed exchange used up the sign-in, kept or hidden when settings are reopened depending on whether the backend is still waiting, and restored in a freshly mounted panel); cancel; reconnect-needed state and sign out; no status call while the dialog is closed.

## Manual checklist (NOT VERIFIED until run on a real build)

Run on a desktop build with a Claude plan account you accept the terms risk for.

| #   | Step                                                                                               | Expected                                                                                           |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Open Settings (keyboard shortcuts dialog) → Claude account                                         | "Not signed in"; **Open sign-in page** disabled                                                    |
| 2   | Tick the acknowledgement, press **Open sign-in page**                                              | Browser opens claude.ai authorize page; the address field shows the same URL                       |
| 3   | Approve, paste the shown `code#state`, press **Connect**                                           | "Signed in as <email>"                                                                             |
| 4   | Paste a value with a changed state instead                                                         | "Sign-in state did not match…", field kept, a correct paste still works                            |
| 5   | Restart the app, reopen Settings                                                                   | Still signed in                                                                                    |
| 6   | Check Windows Credential Manager → Generic credentials                                             | Entry `anthropic` under `com.supavideo.producer:ai-anthropic` (plus `anthropic#n` chunks if large) |
| 7   | Edit the stored `expiresAt` to the past (or wait ~8 h), trigger a Messages call from a debug build | Token refreshed silently; call succeeds                                                            |
| 8   | Revoke the app session at claude.ai, trigger a refresh                                             | "Sign-in expired…"; sign in again restores it                                                      |
| 9   | Press **Sign out**                                                                                 | "Not signed in"; keyring entries removed                                                           |

If Anthropic rejects live calls because the credential is only authorized for Claude Code, record that here as a scoped exclusion; do not mark the feature verified.
