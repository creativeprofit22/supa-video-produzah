# Phase 1 Step 11 — Render Jobs and Export

## Outcome

Implement the native render/export engine for the existing deterministic `RenderPlanV1`: strict Rust-side plan validation, owner-scoped asynchronous jobs, small owner-window events, monotonic FFmpeg progress, collision-safe promotion, verified MP4 output, controlled preview copies, idempotent cancellation, and complete partial/process cleanup.

Step 11 ends with tested but not yet production-registered render commands. Production Tauri state/command registration, window/app lifecycle cancellation, CSP, capabilities, and asset-protocol scope remain Step 12. Frontend adapters, listeners, controller state, and export UI remain Steps 13–15. Real system-FFmpeg export/cancel integration evidence remains Step 16.

## Current baseline

- `packages/video-render/src/compile-render-plan.ts` already emits the exact Phase 1 FFmpeg grammar with `-progress pipe:1`, immutable plan/revision IDs, expected duration/rate/dimensions/audio, and input/output paths.
- `packages/video-contracts/src/render-plan.ts` validates the browser-side plan shape, but Rust has no mirrored render plan or event/output records.
- `apps/desktop/src-tauri/src/video/process.rs` already launches without a shell, uses Unix process groups or Windows Job Objects, kills and reaps on cancellation/timeout, and bounds captured output. It currently captures all stdout and cannot stream long-running progress safely.
- `apps/desktop/src-tauri/src/video/probe.rs` already exposes trusted-path ffprobe inspection; `derived.rs` already contains exact one-frame duration helpers and proven temporary-file/cache-containment patterns.
- `video_pick_export_path` already creates an exact owner-window output grant.
- No `render.rs`, `VideoRenderJobs`, render commands, render events, or render error handling exists.

## Scope boundaries

### Included

- Mirror and strictly validate `RenderPlanV1` in Rust.
- Add `invalid_render_plan` and `output_exists` native/frontend error-code parity.
- Add `video_start_render` and `video_cancel_render` command implementations without registering them in `lib.rs` yet.
- Use `planId` as the Phase 1 `jobId`; reject active/settled duplicate IDs and reserve active destinations.
- Emit only to the owner label on one stable event name, `video:render-event`.
- Render to one unique sibling `.svp-part-<jobId>.mp4`, probe it, promote it, and create a validated cache preview.
- Keep existing process supervision guarantees and add bounded streaming stdout records for progress.
- Add portable unit/process tests that do not require system FFmpeg.

### Excluded

- `lib.rs` managed-state/handler registration and window/app exit cleanup.
- `tauri.conf.json`, capability, CSP, or asset-protocol changes.
- `video-ipc.ts`, Tauri event listeners, React controller/UI, or collision dialogs.
- New render-plan fields or changes to the already snapshot-tested compiler grammar.
- System-FFmpeg valid-export and cancellation integration tests; those remain Step 16.

## Contracts and behavior

### Error contract

Update both error-code lists with:

- `invalid_render_plan`: malformed DTO, grammar mismatch, duplicate ID, destination reservation conflict, unknown/wrong-owner job, or unsafe derived path.
- `output_exists`: the selected final destination exists while `overwrite=false`, including a race discovered by no-clobber promotion.

All UI-facing errors retain the existing redaction rule: operation/category, executable, exit code, limits, and safe booleans only; no raw stderr or full user paths in error details.

### Rust render DTOs

Add strict `serde(deny_unknown_fields)` records in `video/types.rs`:

- `RenderPlanV1` and `RenderExpectation`.
- `VideoRenderStarted { jobId, planId, revisionId }`.
- `VerifiedRenderOutput { outputPath, previewPath, probe }`.
- Tagged `VideoRenderEvent` variants: `started`, `progress`, `completed`, `failed`, and `cancelled`.

Every event carries `jobId`, `planId`, and `revisionId`. Progress carries integer `completedMicroseconds` and `durationMicroseconds`; completion carries the verified output record; failure carries a redacted `VideoCommandError`. Avoid floating-point progress in the native contract.

### Exact plan validation

`render.rs` must reject before job insertion unless all checks pass:

1. Schema version is `1`; executable is exactly `ffmpeg`; IDs are canonical contract UUIDs.
2. Expected duration frames, rate, width, and height are positive safe integers; rate is already reduced; dimensions are even.
3. Input is the exact owner-granted canonical source; output is the exact owner-granted normalized destination; both are distinct; output has a case-insensitive `.mp4` extension.
4. `argv` has 1–128 UTF-8/NUL-free bounded arguments and exactly matches the compiler grammar and ordering:
   - fixed prefix through `-progress pipe:1 -nostats`;
   - `-i <inputPath>`;
   - canonical fixed-six-decimal `-ss`;
   - `-t` equal to the expected frame duration converted with nearest-ties-away-from-zero integer arithmetic;
   - exact video map and exact conditional audio-map/`-an` branch;
   - exact scale/pad/fps filter built from expected dimensions/rate;
   - exact H.264/yuv420p and optional AAC/48 kHz codec branch;
   - `-movflags +faststart` and the output path as the final token.
5. Only the final destination token is replaced for execution; all other plan bytes remain authoritative and unchanged.

### Job registry and cancellation

Add cloneable Tauri state `VideoRenderJobs` backed by `Arc<Mutex<...>>`:

- Active entries store owner label, plan/revision IDs, normalized destination, cancellation token, and commit phase.
- Registration atomically rejects duplicate/tombstoned IDs and another active job targeting the same destination.
- A bounded settled tombstone queue preserves owner/id information long enough for repeated cancellation to remain idempotent without unbounded process-lifetime growth.
- `video_cancel_render(jobId)` returns success for repeated requests by the same owner, sets the active cancellation flag once, and rejects unknown or wrong-owner IDs without revealing another owner.
- Settlement removes the active destination reservation and records one terminal result; terminal event emission is guarded by that single successful settlement transition.

`video_start_render` performs all synchronous preflight, inserts the job, spawns the worker with `tauri::async_runtime::spawn`, and returns `VideoRenderStarted`. It emits `started` before process launch; process/probe/promotion failures are terminal events rather than late command rejections.

### Streaming supervision and progress

Extend `process.rs` without changing existing capture callers:

- Add a streaming stdout mode that frames bounded lines/records, invokes an allowlisted observer, discards consumed bytes, and continues to use bounded stderr tails.
- Preserve the existing no-shell, process-group/Job-Object, timeout, kill, wait/reap, and kill-on-drop behavior.
- Treat an overlong unterminated progress line as `ProcessOutputLimit`; never accumulate the full render progress stream.

Add a render progress accumulator that:

- accepts only decimal non-negative `out_time_us` and the legacy `out_time_ms` alias (FFmpeg historically reports both in microseconds);
- ignores malformed, negative, overflowed, and unrelated keys;
- prefers `out_time_us` when both occur in one record;
- clamps to the exact expected duration, never regresses, and emits only increases;
- emits exact duration on `progress=end` only if no terminal failure/cancellation supersedes it.

### Worker, proof, and promotion

The worker pipeline is:

1. Derive the sibling partial path `.svp-part-<jobId>.mp4`; reject an existing/symlinked collision rather than deleting an unowned path.
2. Wrap that path in `TempPath::try_from_path` before launch so every pre-promotion return removes only that exact owned partial.
3. Run FFmpeg with the validated argv and only the final token replaced; use the existing supervisor plus streaming progress and a finite render timeout.
4. Sync the completed partial file and inspect it through the trusted ffprobe path using the same cancellation token.
5. Require a nonempty regular file whose metadata size matches probe data, H.264/yuv420p video, exact expected width/height and CFR rate, AAC/48 kHz iff expected (no audio otherwise), and duration within one output frame.
6. If `overwrite=true`, atomically replace through `TempPath::persist`; otherwise use `persist_noclobber` so a race never overwrites an existing user file and maps to `output_exists`. The prior destination remains untouched until proof succeeds.
7. After final promotion, cancellation no longer removes or downgrades the valid user export. Create `$APPCACHE/video-phase1/render-preview/<jobId>/preview.mp4` through component-by-component non-symlink directory validation, copy into a sibling tempfile, sync, probe/validate the copy, then atomically persist it.
8. Emit `completed` only after preview validation. If preview creation fails, preserve the valid final export and emit a typed failure category indicating that the output exists but preview preparation failed.
9. On process failure, timeout, cancellation, probe rejection, collision, or promotion failure, settle exactly once and let the `TempPath` remove the partial. Never delete source media, unrelated files, or the final destination on a pre-promotion failure.

## File changes

- `packages/video-contracts/src/errors.ts`
  - Add `output_exists`; retain `invalid_render_plan` parity.
- `packages/video-contracts/src/contracts.test.ts`
  - Cover the new error code and retain strict render schema behavior.
- `apps/desktop/src-tauri/src/video/error.rs`
  - Add `InvalidRenderPlan` and `OutputExists` variants and redacted constructors.
- `apps/desktop/src-tauri/src/video/types.rs`
  - Add strict mirrored render plan, start response, verified output, and event DTOs.
- `apps/desktop/src-tauri/src/video/process.rs`
  - Add bounded streaming stdout supervision while preserving capture mode.
- `apps/desktop/src-tauri/src/video/render.rs` (new)
  - Implement validation, progress accumulation, job state, start/cancel commands, worker, proof, promotion, preview copy, event sink, and cleanup.
- `apps/desktop/src-tauri/src/video/mod.rs`
  - Declare/re-export render types and commands for later Step 12 registration.
- `apps/desktop/src-tauri/src/video/tests.rs`
  - Add focused portable plan/job/progress/process/output/cache/promotion/cleanup tests and extend the existing process helper where needed.

No dependency or lockfile change is expected: current Tauri, Tokio, tempfile, process-wrap, serde, and UUID dependencies cover the implementation.

## Test matrix

### Plan and path validation

- Accept exact AV and video-only compiler plans.
- Reject unknown fields, malformed IDs, unsafe integers/rates/dimensions, wrong executable, relative/ungranted paths, same input/output, non-MP4 output, every reordered/changed fixed token, wrong filter, wrong audio branch, mismatched `-t`, and any path mismatch in argv.
- Prove the worker substitutes only the final output token and derives an exact contained sibling partial.

### Progress and supervision

- Parse chunk-split records, CRLF/LF, `out_time_us`, legacy `out_time_ms`, malformed/negative/overflow input, duplicate/regressing values, overshoot, and `progress=end`.
- Prove output is monotonic and clamped.
- Prove streaming stdout does not accumulate unbounded output, rejects an overlong record, captures only bounded stderr tail, and retains existing timeout/cancellation descendant termination tests.

### Registry and events

- Prove owner isolation, duplicate ID rejection, active-destination reservation, same-owner repeated cancellation success, wrong-owner rejection, bounded tombstones, one settlement, and one terminal event.
- Prove `started` precedes progress and terminal output; no progress follows settlement.

### Filesystem and media proof

- Reject absent, empty, symlinked, wrong-size, wrong-codec/pixel-format/rate/dimensions/audio/duration artifacts.
- Preserve an existing destination on render/probe failure.
- Exercise overwrite replacement and no-clobber collision races.
- Prove cancellation/failure drops the exact partial and leaves unrelated similarly named files untouched.
- Prove preview paths stay under the controlled namespace, reject symlink escapes, and completion is withheld until the copied preview validates.

## Verification gates

Run after implementation and fix every failure:

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
- Existing five ignored local-FFmpeg tests, to prove probe/preparation regressions were not introduced.
- `pnpm --dir apps/desktop tauri build --no-bundle --ci`
- `git diff --check`

Success means all portable and existing explicit integration gates pass, the worktree contains only Step 11 files, and no Step 12 registration/security or Step 13+ frontend work has been introduced.

## Risks

- **Progress memory growth:** use bounded line framing and discard processed stdout instead of increasing the existing whole-output cap.
- **Destination race:** use no-clobber promotion when overwrite is false and atomic replacement only after explicit overwrite confirmation.
- **Cancellation after commit:** define promotion as the commit point; never delete a valid user export after it.
- **Terminal duplication:** centralize settlement in the registry and emit a terminal event only for the winner.
- **Window loss before Step 12:** event delivery failure must not bypass process settlement or partial cleanup; lifecycle-triggered cancellation is deliberately added next.
- **Cache escape:** create/validate every preview-directory component and reject symlinks before writing.
- **Cross-platform process leaks:** keep all render execution inside the existing process-wrap supervisor and retain descendant-survival tests on Unix and Windows.

## Steps

1. Add `output_exists` to the shared TypeScript error contract and add matching `InvalidRenderPlan`/`OutputExists` Rust error variants with redacted constructors and tests.
2. Add strict Rust `RenderPlanV1`, render expectation, start response, verified output, and tagged owner-event DTOs in `apps/desktop/src-tauri/src/video/types.rs`.
3. Extend `apps/desktop/src-tauri/src/video/process.rs` with bounded streaming stdout records while preserving existing capture-mode supervision, cancellation, timeout, and reaping behavior.
4. Create `apps/desktop/src-tauri/src/video/render.rs` with exact plan/argv/path validation, expected-duration arithmetic, sibling partial derivation, and FFmpeg argument substitution.
5. Implement monotonic FFmpeg progress accumulation and owner-targeted `video:render-event` emission for started/progress/terminal payloads.
6. Implement `VideoRenderJobs`, atomic ID/destination reservation, bounded settled tombstones, idempotent owner-checked cancellation, and exactly-once settlement.
7. Implement the asynchronous render worker with supervised execution, cancellation, post-render ffprobe validation, sync, collision-safe promotion, controlled validated preview copy, and exhaustive partial cleanup.
8. Add the unregistered `video_start_render` and `video_cancel_render` command functions and expose the Step 11 module/types through `video/mod.rs` without changing Step 12 production registration or security configuration.
9. Add portable tests for exact plans, paths, progress framing/clamping, registry ownership/settlement, event ordering, media proof, collision/overwrite behavior, preview containment, process survival, and partial cleanup.
10. Run every listed TypeScript, Rust, local-FFmpeg regression, Tauri no-bundle, formatting, lint, and diff verification gate and correct all failures without expanding beyond Step 11.
