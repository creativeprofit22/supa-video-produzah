# Phase 1 Step 12 — Tauri Runtime Security Completion

## Outcome

Complete the earliest unfinished Phase 1 dependency by enabling Tauri's asset protocol only for product-owned Phase 1 cache media, replacing the null CSP with a production policy tailored to the current React bundle and IPC/event usage, and reducing the main-window capability from `core:default` to the two event permissions the frontend actually calls.

The existing production render state, command registration, destroyed-window cleanup, and app-exit cancellation remain unchanged except for focused regression coverage. Frontend media playback, project open/save wiring, timeline editing, and other Step 13+ work stay out of scope.

## Audited baseline

- `ROADMAP.md` now records Step 11 as implemented in the current worktree and the remaining Step 12 security configuration as next.
- `apps/desktop/src-tauri/src/lib.rs` already registers the dialog plugin, `VideoPathGrants`, `VideoRenderJobs`, ten native handlers, owner-window cleanup, and app-exit render cancellation.
- `apps/desktop/src-tauri/tauri.conf.json` still has `app.security.csp: null`, no `assetProtocol`, and no explicit capability selection.
- `apps/desktop/src-tauri/capabilities/default.json` grants `core:default`, which includes path, event, window, webview, app, image, resource, menu, and tray defaults.
- The frontend imports only `invoke` from `@tauri-apps/api/core` and `listen` from `@tauri-apps/api/event`. Application commands registered with `invoke_handler` are allowed by default; the frontend therefore needs only `core:event:allow-listen` and `core:event:allow-unlisten` from the Tauri core ACL.
- `apps/desktop/src-tauri/Cargo.toml` disables Tauri default features and does not enable `tauri/protocol-asset`. Configuration alone would not register the asset protocol because Tauri gates its scope state and URI handler behind that Cargo feature.
- Derived proxies, thumbnails, and render previews are all written beneath `$APPCACHE/video-phase1/`; source media and user-selected final exports must never be exposed by the asset protocol.
- Tauri 2.11 documentation and the installed Tauri 2.11.5 source confirm that `assetProtocol` requires `enable: true`, an `FsScope`, the `protocol-asset` feature, and CSP sources for both `asset:` and Windows' `http://asset.localhost` form.
- The root formatting gate currently fails only because generated Playwright output at `test-results/.last-run.json` is not ignored.

## Scope boundaries

### Included

- Enable `tauri/protocol-asset` in the existing `desktop-runtime` feature set and update the Rust lockfile.
- Add an exact `$APPCACHE/video-phase1/**/*` asset-protocol allow scope.
- Add explicit production and development CSP maps.
- Explicitly select the `default` capability and narrow that capability to local main-window event listen/unlisten access.
- Add configuration regression tests that consume the generated Tauri context and the capability JSON.
- Ignore generated Playwright `test-results/` output so the existing formatting gate is meaningful again.
- After verification, update `README.md` and `ROADMAP.md` so Step 12 is complete and Step 13 is next.

### Excluded

- `convertFileSrc`, `<video>` or `<img>` playback, monitor UI, thumbnail display, and preview controls.
- New/open/save project adapters or controller state.
- Timeline, playhead, trim, undo/redo, keyboard editing, or accessibility UI work.
- Dynamic asset scope mutation, persisted-scope, filesystem plugin access, source-file exposure, or final-export exposure.
- Changes to render-plan validation, render worker behavior, job events, cancellation, or media preparation.
- Broad wildcard scopes, remote capabilities, network origins, `blob:`, `data:`, `unsafe-eval`, or production `unsafe-inline` allowances.

## Security contract

### Asset protocol

`apps/desktop/src-tauri/tauri.conf.json` will configure:

```json
"assetProtocol": {
  "enable": true,
  "scope": ["$APPCACHE/video-phase1/**/*"]
}
```

Use the array form because only one fixed allow pattern is required. Do not add source, output, home, temp, or catch-all patterns. Add `tauri/protocol-asset` to `desktop-runtime`; this keeps production/default builds functional without widening the standalone `tauri-ipc-test` feature definition.

### Production CSP

Use a directive map so tests can assert every source exactly:

- `default-src 'self'`
- `connect-src ipc: http://ipc.localhost`
- `font-src 'self'`
- `img-src 'self' asset: http://asset.localhost`
- `media-src 'self' asset: http://asset.localhost`
- `object-src 'none'`
- `script-src 'self'`
- `style-src 'self'`
- `base-uri 'none'`
- `form-action 'none'`

Tauri's default CSP asset modification remains enabled so build-time script hashes and style/script nonces are injected. The local Geist font files are covered by `'self'`; no external font or image host is needed.

### Development CSP

Define `devCsp` separately instead of letting the production policy break Vite HMR. Keep the production directives, add `ws:` to `connect-src`, and allow `'unsafe-inline'` only in development `style-src` for Vite's runtime style injection. Do not carry either development exception into production.

### Capability

Keep one capability for window `main`, set it explicitly local, and replace `core:default` with:

```json
[
  "core:event:allow-listen",
  "core:event:allow-unlisten"
]
```

Set `app.security.capabilities` to `["default"]` so future capability files are not silently auto-enabled. No dialog permission is required because file dialogs are opened inside Rust-owned commands, and no core path/window/webview/app/menu/tray permission is used by the frontend.

## File changes

- `apps/desktop/src-tauri/Cargo.toml`
  - Add `tauri/protocol-asset` to `desktop-runtime`.
- `apps/desktop/src-tauri/Cargo.lock`
  - Record the locked transitive `http-range` dependency activated by the asset protocol.
- `apps/desktop/src-tauri/tauri.conf.json`
  - Add exact production/dev CSP maps, explicit capability selection, and the narrow asset-protocol scope.
- `apps/desktop/src-tauri/capabilities/default.json`
  - Make the capability explicitly local and retain only event listen/unlisten for `main`.
- `apps/desktop/src-tauri/tests/security_config.rs` (new)
  - Build the generated Tauri context and assert exact CSP maps, explicit capability selection, enabled asset protocol, and the sole allowed cache pattern.
  - Parse the capability JSON and assert its identifier, local/main targeting, exact two-permission set, and absence of remote access.
- `.gitignore` and `.prettierignore`
  - Ignore generated `test-results/` directories without ignoring the documented `apps/desktop/evidence/` path.
- `README.md`
  - Update the current checkpoint/security boundary to describe implemented preparation/rendering and the now-active narrow cache protocol while retaining the incomplete playback/editing limitations.
- `ROADMAP.md`
  - After all gates pass, mark Step 12 complete, record exact evidence, and identify the unfinished Step 13 new/open/save controller flow as next.

## Test matrix

### Generated configuration

- Production CSP exists and exactly matches the allowlisted directives; it contains no wildcard network source or unsafe production directive.
- Development CSP differs only by HMR `ws:` and development-only inline styles.
- Tauri CSP modification is not disabled.
- Asset protocol is enabled.
- Asset scope contains exactly `$APPCACHE/video-phase1/**/*` and no broader path.
- Security configuration explicitly enables only capability identifier `default`.

### Capability

- Identifier is `default`, target window is only `main`, and access is local.
- Permissions are exactly event listen and unlisten.
- No remote URL block, dialog, filesystem, shell, path, window, webview, app, menu, tray, emit, or broad core default permission is present.
- Existing render event subscription tests continue to pass, proving the narrowed permission names match the APIs in use at the frontend contract level.

### Regression

- Existing production handler reachability remains covered by the `tauri-ipc-test` suite.
- Existing destroyed-window and app-exit cancellation tests remain green.
- Existing portable process/render tests and all eight real-FFmpeg integrations remain green.
- Production Tauri assembly succeeds with the asset protocol feature and strict CSP.
- Root formatting succeeds after generated Playwright results are ignored.

## Verification gates

Run and fix every failure:

- `pnpm install --frozen-lockfile`
- `pnpm build`
- `pnpm check`
- `pnpm test`
- `pnpm lint`
- `pnpm format:check`
- `cargo fmt --all --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`
- `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cargo test --locked --features tauri-ipc-test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored --nocapture`
- Inspect `cargo tree --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -e features -i tauri` and confirm `protocol-asset` is active in default production builds.
- `pnpm --dir apps/desktop tauri build --no-bundle --ci`
- `git diff --check`

Success means the production executable assembles with an active, cache-contained asset protocol; the generated context and capability tests prove the exact policy; all existing render/lifecycle behavior remains green; the root formatting gate is restored; and no Step 13+ feature is added.

## Risks

- **Configuration without implementation:** enabling `assetProtocol` without `tauri/protocol-asset` compiles but does not register the protocol; require both and inspect the Cargo feature tree.
- **Scope escape:** a broad glob could expose arbitrary local files; assert the sole `$APPCACHE/video-phase1/**/*` pattern in a regression test.
- **Windows protocol mismatch:** CSP must include `http://asset.localhost` as well as `asset:` for cross-platform media loading.
- **Broken IPC events:** replacing `core:default` too aggressively can block subscriptions; retain only the documented listen/unlisten pair and rerun IPC/controller tests.
- **Broken development HMR:** production `connect-src` does not allow Vite's WebSocket; use a separate `devCsp` with `ws:` and development-only inline styles.
- **CSP regression through convenience sources:** avoid `*`, broad `http:`, `https:`, `data:`, `blob:`, `unsafe-eval`, and production `unsafe-inline`; add only a source proven necessary by current code.
- **Generated-output noise:** ignore Playwright `test-results/` rather than formatting or committing it; keep product evidence under the already documented evidence directory.
- **False Phase completion:** Step 12 only establishes the secure runtime boundary; proxy playback, persistence, trimming, reopen, and the Phase 1 hard gate remain incomplete.

## Steps

1. Add `tauri/protocol-asset` to the `desktop-runtime` feature in `apps/desktop/src-tauri/Cargo.toml` and refresh `apps/desktop/src-tauri/Cargo.lock` without changing unrelated dependencies.
2. Replace the null security configuration in `apps/desktop/src-tauri/tauri.conf.json` with the exact production CSP, HMR-compatible development CSP, explicit `default` capability selection, and `$APPCACHE/video-phase1/**/*` asset-protocol scope.
3. Narrow `apps/desktop/src-tauri/capabilities/default.json` to explicit local access for window `main` with only `core:event:allow-listen` and `core:event:allow-unlisten`.
4. Add `apps/desktop/src-tauri/tests/security_config.rs` to assert the generated Tauri security configuration and capability JSON exactly, including rejection of broader permissions and paths.
5. Add generated `test-results/` output to `.gitignore` and `.prettierignore` while preserving the existing committed-evidence exception policy.
6. Run the focused security/configuration tests, portable Rust suites, lifecycle/IPC tests, and all eight local-FFmpeg integrations; fix regressions without changing render or frontend feature scope.
7. Run the frozen install, build, type-check, lint, formatting, Cargo feature-tree, Clippy, production Tauri no-bundle, and diff gates; confirm the executable builds with `protocol-asset` active.
8. Update `README.md` and `ROADMAP.md` with the verified Step 12 security state, exact passing evidence, remaining Phase 1 limitations, and Step 13 new/open/save controller flow as the next item.