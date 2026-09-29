# AI account sign-in (Claude plan)

Supa Video can connect a **Claude plan account** (Free/Pro/Max) with OAuth 2.0 authorization code + PKCE, then call the Anthropic Messages API with that account. The implementation is ported from Linkgo's Anthropic sign-in (the OpenAI/Codex half and the loopback listener were not ported).

## Terms risk (read first)

Anthropic's _Claude Code legal and compliance_ page (<https://code.claude.com/docs/en/legal-and-compliance>) says plan OAuth tokens are for Claude Code and Claude.ai only. Supa Video has no registered Anthropic app and reuses the Claude Code public client ID, so **using this feature goes against Anthropic's terms**. Anthropic can reject the requests or restrict the account at any time.

How that is enforced in the app:

- The **Open sign-in page** button stays disabled until the user ticks the risk acknowledgement in Settings → Claude account.
- The native command `ai_account_start_sign_in` refuses to start unless `acknowledged: true` is sent, so the renderer cannot skip the check.

## Provider constants

All Anthropic-specific values live in `apps/desktop/src-tauri/src/ai_account/anthropic_oauth.rs` and `messages.rs`:

| Item      | Value                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code)                                                                                            |
| Authorize | `https://claude.ai/oauth/authorize`                                                                                                             |
| Token     | `https://platform.claude.com/v1/oauth/token`, fallback `https://console.anthropic.com/v1/oauth/token` (network error or 5xx only; 4xx is final) |
| Redirect  | `https://platform.claude.com/oauth/code/callback` — the page shows a `code#state` value to paste                                                |
| Scopes    | `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`                                    |
| Messages  | `https://api.anthropic.com/v1/messages`                                                                                                         |

## Flow

1. The user ticks the acknowledgement and presses **Open sign-in page**.
2. Native code creates a PKCE S256 verifier and a 32-character hex state, keeps them in memory for 10 minutes, and opens the authorize URL in the default browser. The URL is also shown as a read-only field in case the browser does not open.
3. After approving, the user pastes the `code#state` value (a full callback URL or `code=…&state=…` also works). Native code checks the state against the pending sign-in **before** consuming it, so a wrong paste leaves the real sign-in usable.
4. The code is exchanged (JSON body, `User-Agent: claude-cli/<version> (external, cli)`, `anthropic-beta: oauth-2025-04-20`). The version comes from the npm registry (`@anthropic-ai/claude-code/latest`, 3 s timeout), cached 24 h in memory and in `claude-code-version.json` under app data; if npm is unreachable it uses the stale cache, then the built-in fallback, and retries after 5 minutes.
5. Tokens are saved in the OS keyring under service `<app identifier>:ai-anthropic` (for release builds `com.supavideo.producer:ai-anthropic`). Values over 1000 characters are split across several entries because Windows Credential Manager caps each entry at 2560 bytes.
6. Before each Messages call, a token expiring within 5 minutes is refreshed. Refreshes are serialized so concurrent calls make one token request. A 4xx refresh clears the tokens and sets **Sign-in expired** (the user must sign in again); a network error or 5xx keeps the tokens and reports the error.
7. The native helper `ai_account::commands::call_messages` sends a normal Messages request body with the Claude Code identity block placed first in `system`, headers `anthropic-version: 2023-06-01`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `User-Agent`, `x-app: cli` and bearer auth. A 401 forces one refresh and one retry. Redirects are never followed, responses are capped at 8 MiB, and streaming is not supported.
8. **Sign out** deletes the keyring entries and cancels any pending sign-in. Sign-in, sign-out and refresh share one lock, so a refresh already in progress finishes first and can never save the old account back afterwards.

Tokens never reach the renderer: IPC carries only connection status, the account email, whether a sign-in is pending, and the sign-in URL. Errors are fixed wording plus a sanitized OAuth error code.

## Not included

- No model feature uses the account yet: `call_messages` is the entry point for a future producer (see `ROADMAP.md`).
- No API-key flow and no OpenAI sign-in.
