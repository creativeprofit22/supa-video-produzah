# Phase 1 Step 9 — Supervised FFmpeg tools and media probing

## Outcome

Implement only the confirmed next roadmap item: discover system `ffmpeg` and `ffprobe` through bounded version checks, add a reusable no-shell Tokio process supervisor backed by Unix process groups or Windows Job Objects, parse strict ffprobe JSON into the existing native `MediaProbe`, and expose compile-time Tauri commands for tool status and owner-granted source probing.

This work stops before proxy/thumbnail generation (Step 10), render jobs/progress/cancellation (Step 11), Tauri builder/plugin/state/handler and app/window lifecycle registration (Step 12), and React integration (Steps 13–15). The commands compile now but remain unreachable from the webview until Step 12.

## Audited baseline

- `ROADMAP.md` now records Phase 1 Step 9 as next and the latest passing verification evidence.
- `apps/desktop/src-tauri/src/video/` currently contains only project errors/types, grants, project I/O, and 14 Rust tests; there is no `process.rs`, `probe.rs`, process dependency, tool-status command, or probe command.
- `apps/desktop/src-tauri/src/lib.rs` intentionally exports `video` but does not initialize the dialog plugin, manage `VideoPathGrants`, or register invoke handlers.
- `apps/desktop/src-tauri/src/video/types.rs` already owns the camel-case `MediaProbe`, `MediaAudioShape`, and reduced `RationalRate` shapes used by persisted V1 projects.
- `apps/desktop/src-tauri/src/video/error.rs` currently covers project/path errors only. `packages/video-contracts/src/errors.ts` must remain aligned with new native command error codes.
- The canonical fixture is a tracked 2-second, 60-frame, 320×180 H.264/AAC MP4 with a matching project and verified SHA-256.
- The frozen workspace, root build/check/test/lint/format gates, Rust fmt/Clippy/tests, fixture parse, and fixture probe/hash all passed immediately before this plan.

## Verified dependency and API decisions

- Add `process-wrap` `9.1.0` with `default-features = false` and features `tokio1`, `kill-on-drop`, `process-group`, and `job-object`. The crate requires Rust 1.87, matching the application manifest.
- Add a direct Tokio `1.53.1` dependency using the version already resolved in `Cargo.lock`, with only `io-util`, `macros`, `process`, `rt`, and `time` features needed by the supervisor and async tests.
- Use `process_wrap::tokio::CommandWrap`. Apply `KillOnDrop` before the platform wrapper; apply `ProcessGroup::leader()` on Unix and `JobObject` on Windows. `ChildWrapper::kill()` performs group/job-aware termination followed by waiting.
- Do not use `wait_with_output`, because it reads both pipes without a memory limit. Take the child pipes, read them concurrently with fixed memory bounds, and wait concurrently so neither pipe can deadlock the child.
- Use FFmpeg’s documented machine-readable JSON writer and explicit `-show_entries`; run executables directly with argv arrays and `Stdio::null/piped`, never through a shell.

## Process supervisor design

Add `apps/desktop/src-tauri/src/video/process.rs` with private, reusable primitives for Steps 9–11:

- `ProcessSpec`: program, argv, operation label, timeout, stdout hard limit, and stderr-tail limit. Program and arguments are passed as `OsStr`/`OsString`; no shell string API exists.
- `ProcessCancellation`: a cloneable `Arc<AtomicBool>` handle with idempotent `cancel()` and an async polling wait. Tool checks/probes use a fresh uncancelled handle; later derived/render workers can retain and trigger it.
- `SupervisedOutput`: exit status, bounded stdout bytes, bounded stderr tail, and a truncation flag. It remains internal and never serializes raw process output or user paths to the webview.
- `ProcessFailure`: `Spawn`, `Timeout`, `Cancelled`, `StdoutLimit`, `Io`, and `NonZero`, retaining only safe internal diagnostics needed for tests/mapping.
- `run_supervised`: configure null stdin and piped stdout/stderr, add `KillOnDrop` and the platform wrapper, spawn, concurrently wait/read both pipes, and race the operation against timeout and cancellation.
- Stdout is a hard cap: reading byte `limit + 1` returns `StdoutLimit`, terminates the process tree, waits/reaps it, and discards partial structured output.
- Stderr is drained concurrently into a rolling tail capped in memory; overflow sets `truncated` without blocking the child. Caller-facing errors expose operation/tool/exit metadata only, not the raw tail.
- Every timeout, cancellation, output-limit, or read failure path invokes group/job-aware kill and waits before returning. Natural completion also waits through the wrapper, so descendants are reaped according to `process-wrap` semantics.
- Keep full app/window job ownership out of this module; Step 11 adds render-job state and Step 12 connects lifecycle shutdown.

Use conservative limits:

- Tool version check: 5 seconds, 64 KiB stdout, 64 KiB stderr tail.
- Media probe: 30 seconds, 1 MiB stdout, 64 KiB stderr tail.
- Cancellation poll interval: 25 ms, bounded by process kill/wait completion rather than fire-and-forget termination.

## Tool discovery contract

Add serializable records in `apps/desktop/src-tauri/src/video/types.rs`:

- `VideoToolProblem`: `not_found`, `timed_out`, `failed`, or `invalid_version`.
- `VideoToolInfo`: `available`, optional normalized first-line `version`, and optional `problem`.
- `VideoToolStatus`: `ffmpeg`, `ffprobe`, and derived `ready`.

Add `video_ffmpeg_status()` in `probe.rs`:

- Run direct `ffmpeg -version` and `ffprobe -version` checks concurrently through the supervisor.
- Treat OS not-found as `not_found`, timeout as `timed_out`, nonzero/I/O/output-limit as `failed`, and a successful response without the exact `ffmpeg version ` or `ffprobe version ` first-line prefix as `invalid_version`.
- Return both records even if either tool is unavailable; missing tools are a prerequisite state, not a thrown command error.
- Normalize the retained version to a trimmed first line with a small character bound; do not return executable paths, build configuration, or stderr.

## ffprobe command and parser

Add `apps/desktop/src-tauri/src/video/probe.rs` with a pure parser plus an injectable core probe function and a thin Tauri wrapper.

`video_probe_media(window, grants, path)` must:

1. Authorize the supplied path as an exact owner-window `GrantCategory::Source` grant before spawning anything.
2. Reuse the normalized canonical path returned by `authorize`; never trust or echo the browser string.
3. Execute `ffprobe` directly with `-v error`, JSON output, explicit stream/format entries, and `-i <canonical source>` so a leading-dash filename cannot become an option.
4. Apply the 30-second/1-MiB/64-KiB supervisor limits.
5. Map missing ffprobe, timeout, cancellation, output limit, nonzero status, and malformed/unsupported media to typed redacted command errors.
6. Parse only successful stdout and use filesystem metadata for the authoritative positive `fileSizeBytes` after authorization.

Request these ffprobe fields only:

- format: `duration`, `size`;
- stream: `codec_type`, `codec_name`, `duration`, `width`, `height`, `avg_frame_rate`, `r_frame_rate`, `sample_rate`, `channels`;
- stream disposition: `attached_pic`.

The deserialization envelope tolerates unrelated top-level sections emitted by current ffprobe (for example empty `programs` and `stream_groups`), while semantic conversion is strict:

- Select the first non-attached video stream with a nonblank codec, positive dimensions, and a usable positive rate; reject input with no usable video stream.
- Parse rational strings as positive integer `numerator/denominator`, enforce JavaScript-safe components, reduce by GCD, prefer valid `avg_frame_rate`, fall back to valid `r_frame_rate`, and use the selected average rate when `r_frame_rate` is unavailable.
- Set `variableFrameRate` when the exact relative difference between average and real rates is greater than 0.1%, using checked `u128` cross-products rather than floating point. This avoids flagging the common nominal 30 versus 30000/1001 difference at the tolerance boundary.
- Parse positive decimal duration strings without floating point. Prefer container duration, fall back to selected video-stream duration, convert to microseconds, and ceil sub-microsecond residue so a partial final source frame is not lost.
- Select the first audio stream when present. Require a nonblank codec, positive channels at most 64, and a positive sample rate at most 768,000; otherwise reject the malformed audio stream instead of silently claiming video-only media.
- Reject `N/A`, zero/negative/non-finite/scientific duration text, malformed or zero rates, unsafe integer overflow, zero dimensions/size, invalid JSON, and missing required fields.
- Return the existing `MediaProbe` shape and run its relevant semantic validation through dedicated probe helpers rather than constructing unchecked DTO data.

## Error contract

Extend both `packages/video-contracts/src/errors.ts` and native `VideoErrorCode` with aligned codes:

- `tool_unavailable` — ffprobe could not be found when an actual probe was requested;
- `process_failed` — spawn/I/O/nonzero failure;
- `process_timeout` — deadline elapsed and the process tree was terminated/reaped;
- `process_cancelled` — supervisor cancellation was observed and settled;
- `process_output_limit` — structured stdout exceeded its hard cap;
- `invalid_media` — successful ffprobe output was malformed, incomplete, non-video, or outside Phase 1 numeric constraints.

Add constructors/mappers in `error.rs` whose serialized details contain only safe values such as operation, executable enum, exit code, or limit. Do not serialize canonical paths, argv, stdout, stderr, or OS error strings.

## Test design

Extend `apps/desktop/src-tauri/src/video/tests.rs` and add compact ffprobe JSON files under `apps/desktop/src-tauri/fixtures/ffprobe/` for deterministic parser coverage:

- AV fixture: exact canonical metadata and audio shape.
- Video-only fixture: `audio: None`.
- Average-rate fallback and reduced-fraction fixture.
- VFR fixture above the 0.1% threshold plus a nominal-rate boundary case that remains CFR.
- Duration with more than six fractional digits proving microsecond ceiling.
- Malformed JSON, `N/A`/zero rate, missing duration, missing video, attached-picture-only, malformed audio, unsafe numeric value, and zero size/dimensions.

Test the process supervisor without a shell by spawning the current Rust test executable in a dedicated exact helper-test mode selected by environment variables. Cover:

- successful stdout capture;
- nonzero exit mapping;
- stdout hard-limit termination;
- bounded/truncated stderr tail without unbounded allocation;
- timeout termination and wait/reap;
- in-flight atomic cancellation and idempotent cancellation;
- repeated settlement/cleanup behavior with no detached top-level child.

Full descendant-survivor integration remains in Step 16, but Step 9 must exercise the actual platform `ProcessGroup`/`JobObject` wrapper on every spawned test helper and prove the supervised parent is reaped before return.

Add pure/injectable tool checks for valid banner, wrong banner, missing executable, nonzero exit, and timeout. Add a local-FFmpeg integration test, marked explicit rather than part of portable unit gates, that checks system status and probes `single-clip.mp4`; run it on this machine during implementation and assert the known duration/rates/dimensions/codecs/audio/file size.

## File changes

### Modify

- `ROADMAP.md` — after all Step 9 verification passes, mark discovery/process/probe complete and Step 10 derived-media preparation as next without claiming runtime IPC registration.
- `packages/video-contracts/src/errors.ts` — add the six aligned native error codes.
- `apps/desktop/src-tauri/Cargo.toml` — add pinned minimal-feature `process-wrap` and Tokio dependencies.
- `apps/desktop/src-tauri/Cargo.lock` — regenerate through Cargo without unrelated upgrades.
- `apps/desktop/src-tauri/src/video/error.rs` — add process/tool/media error variants and redacted constructors/mapping.
- `apps/desktop/src-tauri/src/video/types.rs` — add tool-status IPC records and reusable probe numeric validation helpers.
- `apps/desktop/src-tauri/src/video/mod.rs` — declare/export `process` and `probe`, `video_ffmpeg_status`, `video_probe_media`, `MediaProbe`, and tool-status records while preserving deferred runtime registration.
- `apps/desktop/src-tauri/src/video/tests.rs` — add parser, supervisor, tool-check, grant-before-probe, and explicit local-FFmpeg coverage.

### Add

- `apps/desktop/src-tauri/src/video/process.rs` — bounded no-shell process supervision, cancellation, platform group/job wrapping, capture, kill, and reap.
- `apps/desktop/src-tauri/src/video/probe.rs` — tool discovery, ffprobe argv construction, strict parser/conversion, granted probe core, and Tauri wrappers.
- `apps/desktop/src-tauri/fixtures/ffprobe/*.json` — deterministic parser inputs for AV, video-only, VFR/rate fallback, and rejection cases.

## Verification

Run focused checks before root gates:

- `pnpm --filter @supa-video/contracts build`
- `pnpm --filter @supa-video/contracts check`
- `pnpm --filter @supa-video/contracts test`
- `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`
- the explicit system-FFmpeg status/probe test against `apps/desktop/src-tauri/fixtures/video-phase1/single-clip.mp4`
- `pnpm install --frozen-lockfile`
- `pnpm build`
- `pnpm check`
- `pnpm test`
- `pnpm lint`
- `pnpm format:check`
- `git diff --check`

Acceptance requires every portable gate to pass, the local integration to match the canonical fixture, timeout/cancellation/output-limit tests to prove kill-and-wait settlement, no raw user path/process output in serialized errors, no runtime Tauri registration, and a clean diff outside the declared files.

## Risks and rollback

- **Pipe deadlock or unbounded memory:** wait and both pipe readers are polled concurrently; stdout has a hard cap and stderr uses a fixed rolling tail.
- **Orphan descendants:** every process uses a Unix process group or Windows Job Object plus kill-on-drop; abnormal paths call group/job kill and await reaping. Full descendant-survivor proof remains a later explicit integration gate.
- **Timeout future cancellation without cleanup:** never return directly from `tokio::time::timeout`; select the deadline, then explicitly kill and wait before mapping the error.
- **ffprobe schema variability:** request a narrow field set, tolerate unrelated envelope sections, and strictly validate only product-required semantics with checked integer arithmetic.
- **VFR false positives:** use an exact documented 0.1% relative threshold and test the 30 versus 30000/1001 boundary.
- **Path disclosure:** authorize canonical paths internally but serialize no path, argv, raw output, or OS error text.
- **Scope overlap:** leave proxy/cache files, render plans/jobs/events, command registration, managed state, capabilities, CSP, lifecycle hooks, and frontend code untouched.
- **Rollback:** remove `process.rs`, `probe.rs`, ffprobe JSON fixtures, the two direct dependencies, and the six error/tool record additions; regenerate the lockfile and restore the roadmap checkpoint. No user media, project, cache, or output file is created or deleted by rollback.

## Steps

1. Add the six aligned process/tool/media error codes to `packages/video-contracts/src/errors.ts` and `apps/desktop/src-tauri/src/video/error.rs`, with redacted native constructors and mappings.
2. Add pinned minimal-feature `process-wrap` 9.1.0 and Tokio 1.53.1 dependencies to `apps/desktop/src-tauri/Cargo.toml`, then regenerate `Cargo.lock` without unrelated upgrades.
3. Add tool-status IPC records and checked probe numeric/rate/duration helpers to `apps/desktop/src-tauri/src/video/types.rs`.
4. Implement `apps/desktop/src-tauri/src/video/process.rs` with no-shell argv execution, platform process-group/Job-Object wrapping, bounded concurrent capture, timeout/cancellation races, and mandatory kill/wait settlement.
5. Add deterministic AV, video-only, rate/VFR, duration, malformed, missing-field, non-video, and invalid-audio ffprobe JSON fixtures under `apps/desktop/src-tauri/fixtures/ffprobe/`.
6. Implement the pure strict ffprobe JSON parser and conversion logic in `apps/desktop/src-tauri/src/video/probe.rs`.
7. Implement injectable bounded tool checks plus the compile-time `video_ffmpeg_status` Tauri command in `probe.rs`.
8. Implement owner-grant-first media probing plus the compile-time `video_probe_media` Tauri command in `probe.rs`.
9. Export the new modules, commands, probe DTO, and tool-status records through `apps/desktop/src-tauri/src/video/mod.rs` without changing Tauri runtime registration.
10. Extend `apps/desktop/src-tauri/src/video/tests.rs` with shell-free supervisor/helper tests, parser fixture tests, tool-status tests, grant enforcement, and the explicit canonical local-FFmpeg integration test.
11. Run focused contract and Rust fmt/Clippy/test gates, run the explicit local-FFmpeg fixture test, and fix every failure within Step 9 scope.
12. Run the frozen install and every root build/check/test/lint/format gate plus `git diff --check`, then inspect the final dependency and source diff for scope or path-output leaks.
13. Update `ROADMAP.md` with verified Step 9 completion, new test evidence, remaining runtime-registration caveat, and Phase 1 Step 10 as the next implementation item.
