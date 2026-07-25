# Phase 1 Step 8 — Rust project contracts and secure project I/O

## Outcome

Implement only Phase 1 Step 8: a tested Rust mirror of the V1 `.svpvideo` contract plus owner-window path grants, Rust-side project/source/export pickers, bounded project open, safe source-locator resolution, and crash-safe atomic project save.

The work stops before FFmpeg discovery/process supervision (Step 9), derived media (Step 10), rendering (Step 11), full Tauri command/plugin registration and lifecycle wiring (Step 12), and React integration (Steps 13–15).

## Current baseline

- `packages/video-contracts/src/project.ts` is the canonical browser-safe V1 schema.
- `apps/desktop/src-tauri/fixtures/video-phase1/single-clip.svpvideo` is the checked-in canonical project fixture.
- `apps/desktop/src-tauri/src/lib.rs` contains only the Tauri builder; no native video module, managed state, commands, or dialog plugin exists.
- `apps/desktop/src-tauri/Cargo.toml` currently depends only on Tauri, Serde, and `serde_json`.
- The audited contract accepts unsafe Windows drive-relative `relativePath` values such as `C:foo`, and `absolutePath` is not currently required to be absolute. Fix these contract gaps before mirroring the rules in Rust.

## Scope decisions

### Canonical contract and parity

TypeScript remains the product-level contract source, while Rust independently mirrors every V1 structural and semantic invariant needed before touching paths:

- strict unknown-field rejection at every object level;
- RFC 9562/4122 UUID text accepted by Zod: canonical 8-4-4-4-12 form, versions 1–8 with RFC variant, plus nil/max UUIDs;
- RFC 3339 timestamps with an explicit offset;
- JavaScript-safe integer bounds (`9_007_199_254_740_991`), positivity/non-negativity, reduced rational rates, even sequence dimensions, and 48 kHz sequence audio;
- one asset, one sequence, one track, at most one clip, matching asset IDs, frame-zero timeline start, equal rates, and a non-empty source range;
- 1–10,000 contiguous linear revisions, unique IDs, valid parent links/current revision, and `updatedAt >= createdAt`;
- optional locator fields reject explicit JSON `null`; nullable asset/sequence/audio fields continue to accept `null`.

Add one shared file-based parity corpus consumed by both Vitest and Cargo tests. The manifest names each full JSON document and its expected `valid`, `invalid_project`, or `unsupported_schema` result. It includes the canonical checked-in fixture plus malformed documents covering future schema, unknown fields, bad UUID/date/integer/rate/history/state, `..`, empty segments, `C:foo`, and a relative `absolutePath`.

### Typed native errors

Use a serializable `VideoCommandError { code, message, details }` response. Mirror existing project codes (`invalid_project`, `unsupported_schema`, `phase1_limit`) and add only the native I/O codes Step 8 requires to `packages/video-contracts/src/errors.ts`: `invalid_path`, `path_not_granted`, and `project_io`.

Error details identify the failed operation/category and validation issues without exposing unrestricted full user paths. Dialog cancellation is `Ok(None)`, not an error.

### Grant model

`VideoPathGrants` stores exact normalized `PathBuf` values in separate project, source, and output sets keyed by the injected `WebviewWindow` label. The browser never supplies the owner label.

- Existing selected files are canonicalized.
- Not-yet-created destinations canonicalize the existing parent and append the selected file name.
- Grant checks recompute the normalized path and require exact owner/category membership.
- `revoke_window(label)` removes every grant for later Step 12 lifecycle wiring.
- Source/project/output equality is rejected where the categories would permit overwriting an input.
- Mutex guards are never held while a dialog or filesystem operation runs.

### Dialog commands

Implement thin async Tauri command wrappers using Rust `DialogExt` APIs and explicit filters:

- `video_pick_new_project_path(defaultName)` — save picker, validates/sanitizes the default name, enforces `.svpvideo`, and grants the normalized project destination.
- `video_pick_source()` — single-file picker for explicit common video containers, requires an existing regular file, and grants the canonical source.
- `video_open_project()` — single-file `.svpvideo` picker followed by bounded parse/validation and source resolution; grants the project only after validation succeeds.
- `video_pick_export_path(defaultName)` — save picker, enforces `.mp4`, rejects collisions with granted inputs/projects, and grants the normalized output destination.
- `video_save_project(path, document)` — validates the mirrored document and exact owner project grant before serialization and atomic save.

Use the plugin’s blocking picker methods only inside async commands, as documented for non-main-thread command contexts. Add the Rust plugin dependency now so these wrappers compile; defer `.plugin(...)`, `.manage(...)`, `invoke_handler`, capabilities, CSP, and window/app lifecycle registration to Step 12.

### Project open and locator resolution

Set `MAX_PROJECT_BYTES` to 2 MiB. Opening checks metadata first, then reads through `take(MAX + 1)` and rejects any race-grown file over the cap before UTF-8/JSON parsing.

Resolve the single asset in this order:

1. A project-relative locator is lexically validated in both TypeScript and Rust: no absolute/root/UNC path, no Windows drive prefix including `C:foo`, no NUL, no empty segment, and no `..` segment.
2. Join it to the canonical project directory. If the target exists, canonicalize it and require containment under the canonical project directory; this blocks symlinks escaping the project tree. Grant only an existing regular file.
3. If the relative target is absent, an absolute fallback may resolve only when it already matches an owner source grant. A project document never grants an arbitrary absolute path by itself.
4. Return one typed source record keyed by asset ID with `resolved`, `missing`, or `relink_required`; missing media does not make the project document invalid.

The TypeScript `absolutePath` contract accepts only platform-recognizable absolute forms (Windows drive-rooted, UNC, or POSIX-rooted) and rejects drive-relative or ordinary relative text. Rust applies the same lexical policy before platform normalization.

### Atomic save

Serialize pretty JSON with a trailing newline, reject output over 2 MiB, then create a unique `tempfile::NamedTempFile` in the destination directory. Write all bytes, flush, call `sync_all`, and use `persist` to atomically replace/promote the destination on the same filesystem.

Validation, grant, extension, size, write, sync, or promotion failures must leave the previous project untouched. `NamedTempFile` cleanup removes unpromoted temporary files. Test promotion failure through an injected private promotion function rather than unreliable filesystem-permission tricks.

## File changes

### Modify

- `packages/video-contracts/src/project.ts`
  - Reject all Windows drive prefixes in project-relative locators, including `C:foo`.
  - Require `absolutePath` to be genuinely absolute using the shared lexical policy.
- `packages/video-contracts/src/contracts.test.ts`
  - Add direct path regressions and consume the shared V1 parity manifest.
- `packages/video-contracts/src/errors.ts`
  - Add `invalid_path`, `path_not_granted`, and `project_io`.
- `packages/video-contracts/package.json`
  - Add a pinned Node 22 type package only if the file-based fixture loader requires it during `tsc`; prefer existing Vitest/TypeScript support if no direct dependency is needed.
- `apps/desktop/src-tauri/Cargo.toml`
  - Add verified direct dependencies: `tauri-plugin-dialog` 2.7.2, `tempfile` 3.27.0, `uuid` 1.24.0 with `serde`, `chrono` 0.4.45 with minimal `std` support, and `thiserror` 2.0.19.
- `apps/desktop/src-tauri/Cargo.lock`
  - Regenerate through Cargo after manifest changes.
- `apps/desktop/src-tauri/src/lib.rs`
  - Export the new `video` module so it compiles as part of the library; leave runtime registration to Step 12.
- `ROADMAP.md`
  - After all Step 8 checks pass, mark the Rust project boundary complete and Step 9 process/tool discovery as next; update verification counts without claiming runtime dialog coverage.

### Add

- `packages/video-contracts/fixtures/project-v1/manifest.json`
  - Shared case names, file paths, and expected result codes.
- `packages/video-contracts/fixtures/project-v1/*.svpvideo`
  - Small, full valid/invalid V1 documents used unchanged by TypeScript and Rust.
- `apps/desktop/src-tauri/src/video/mod.rs`
  - Module exports, constants, command exports, and test module declaration.
- `apps/desktop/src-tauri/src/video/error.rs`
  - Serializable public command error/code plus internal error conversion and path-redacted details.
- `apps/desktop/src-tauri/src/video/types.rs`
  - `serde(rename_all = "camelCase", deny_unknown_fields)` V1 DTOs, open/source IPC records, optional-non-null deserialization, and complete semantic validation.
- `apps/desktop/src-tauri/src/video/grants.rs`
  - Owner/category grant storage, path normalization, exact authorization, collision checks, and revocation.
- `apps/desktop/src-tauri/src/video/project_io.rs`
  - Dialog wrappers, extension/default-name validation, bounded open, locator resolution, atomic save, and testable core filesystem helpers.
- `apps/desktop/src-tauri/src/video/tests.rs`
  - Contract parity, grants, bounded reads, path/locator security, missing/relink records, and atomic save tests.

## Tests and acceptance criteria

- TypeScript and Rust produce the expected result for every shared corpus document.
- The canonical `single-clip.svpvideo` parses in both languages and Rust round-trips to structurally identical JSON.
- `C:foo`, `../x`, doubled/empty path segments, UNC/rooted relative locators, relative `absolutePath`, explicit null optional locator fields, unknown fields, invalid identifiers, and broken revision/state invariants fail.
- Grants are isolated by window and category; normalized aliases cannot bypass exact checks; revocation removes all owner access.
- A contained relative source resolves and gains a source grant; absent media returns `missing`; an ungranted absolute fallback returns `relink_required`; canonical containment rejects an escape target.
- Files at or below 2 MiB are handled; files or serialized documents above the cap return `phase1_limit` without unbounded allocation.
- Successful saves create/replace valid pretty JSON; validation and injected promotion failures preserve old bytes and leave no sibling temp.
- Picker cancellation returns `None`; thin dialog wrappers have no direct filesystem authority beyond paths they grant.
- The checked-in MP4 fixture hash remains `b82a6f35bde38dc8783e923140976393e73daf9f11c23689c05eae734eb23e93`.

## Verification

Run focused checks first, then root gates:

- `pnpm --filter @supa-video/contracts build`
- `pnpm --filter @supa-video/contracts check`
- `pnpm --filter @supa-video/contracts test`
- `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `pnpm build`
- `pnpm check`
- `pnpm test`
- `pnpm lint`
- `pnpm format:check`

Do not claim native dialog runtime verification in Step 8. Step 12 will initialize the plugin/state/handlers and perform the real Tauri picker smoke test.

## Risks and rollback

- **Contract drift:** shared file corpus and structural round-trip tests prevent Rust from silently accepting documents rejected by Zod.
- **Untrusted project paths:** project selection grants only the project and contained relative media; absolute fallbacks require an independent source grant.
- **Symlink/TOCTOU behavior:** canonical containment and revalidation at operation time narrow exposure; no general filesystem plugin or browser-supplied owner exists.
- **Windows replacement semantics:** same-directory `NamedTempFile::persist` follows the documented atomic replacement path; failure tests prove prior bytes survive before promotion.
- **Scope overlap with Step 12:** compile command wrappers and plugin types now, but defer builder registration, permissions, CSP, and lifecycle hooks.
- **Rollback:** remove the new `video` module/corpus/dependencies and revert only the path-contract/error additions; never delete user projects or media.

## Steps

1. Tighten `packages/video-contracts/src/project.ts` locator validation for Windows drive-relative paths and genuinely absolute fallback paths, then add direct regression tests.
2. Add the shared V1 parity manifest and full valid/invalid `.svpvideo` cases under `packages/video-contracts/fixtures/project-v1`, and make Vitest assert every expected result.
3. Extend the shared TypeScript error-code union with `invalid_path`, `path_not_granted`, and `project_io`, adding Node fixture-loader types only if TypeScript requires them.
4. Add the verified Rust dependencies to `apps/desktop/src-tauri/Cargo.toml` and regenerate `Cargo.lock` without unrelated upgrades.
5. Implement serializable native errors and the strict mirrored V1 DTO/semantic validator in `apps/desktop/src-tauri/src/video/error.rs` and `types.rs`.
6. Implement owner-window, category-specific canonical path grants, normalization, collision checks, and revocation in `apps/desktop/src-tauri/src/video/grants.rs`.
7. Implement bounded project reads, strict parse dispatch, safe relative/absolute locator resolution, and typed source status records in `apps/desktop/src-tauri/src/video/project_io.rs`.
8. Implement the four Rust-side picker wrappers and granted `video_save_project` command, including 2 MiB serialization limits and same-directory atomic replace.
9. Wire module exports through `apps/desktop/src-tauri/src/video/mod.rs` and `apps/desktop/src-tauri/src/lib.rs` while leaving Tauri builder/plugin/state/handler registration for Step 12.
10. Add Rust tests for shared contract parity, owner/category grants, cap enforcement, containment/relink behavior, cancellation-level core behavior, successful atomic replacement, failure preservation, and temp cleanup.
11. Run focused TypeScript and Rust formatting/build/check/test/Clippy gates, fix every failure, then run all root build/check/test/lint/format gates and re-verify the fixture hash.
12. Update `ROADMAP.md` only after verification passes, marking Step 8 complete and Step 9 as the next implementation item without overstating runtime dialog coverage.
