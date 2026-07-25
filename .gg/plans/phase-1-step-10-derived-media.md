# Phase 1 Step 10 — controlled derived media

## Outcome

Implement only the native `video_prepare_asset` path for one controlled H.264/AAC preview proxy and one ten-frame JPEG thumbnail tile. Keep every output under the Tauri app cache, prove each artifact before returning it, and leave render jobs/export work for Step 11.

The work is divided into independently testable slices. **The first implementation turn stops after Slice 1 passes its focused and full Rust gates.** Later slices require a follow-up instruction.

## Existing seams to preserve

- `apps/desktop/src-tauri/src/video/process.rs` already provides direct no-shell execution, bounded stdout/stderr, timeouts, cancellation polling, Unix process groups, Windows Job Objects, kill-on-drop, and wait/reap settlement. Derived media must call `run_supervised`; it must not create another process layer.
- `apps/desktop/src-tauri/src/video/grants.rs` already canonicalizes exact per-window source grants. Preparation must authorize `GrantCategory::Source` before metadata reads, cache creation, or process spawning.
- `apps/desktop/src-tauri/src/video/probe.rs` already performs strict ffprobe parsing and safe process-error mapping. Its public source command must retain grant-first behavior; Step 10 may add a crate-private trusted-path seam for app-owned temporary/cache files.
- `apps/desktop/src-tauri/src/video/types.rs` already owns IPC serialization and strict rational/media records. New preparation output records belong there; derived paths must never enter `.svpvideo` documents.
- `apps/desktop/src-tauri/src/video/tests.rs` is the current native test home and already has temp-directory, grant, parser, supervisor, failure-redaction, and ignored local-FFmpeg patterns to reuse.
- Production command handlers are already registered in `apps/desktop/src-tauri/src/lib.rs`, ahead of the original Step 12 ordering. The final Step 10 slice should register only `video_prepare_asset` to keep the current runtime coherent.

## Scope boundary

Included:

- Validated project/asset UUID cache segments and reduced sequence rate.
- Source identity fingerprint from canonical path bytes, size, modification time, profile version, and sequence rate.
- App-cache containment under `video-phase1/<project>/<asset>/preview-v1/`.
- Deterministic FFmpeg token vectors for proxy and thumbnail generation.
- Unique same-directory temporary files, per-file atomic replacement, final validation, cache reuse, stale owned-artifact cleanup, and typed redacted failures.
- Native command registration and Rust/IPC/local-FFmpeg tests.

Excluded:

- `render.rs`, `VideoRenderJobs`, export destinations, collision policy, progress events, render cancellation commands, terminal-event rules, and final-output promotion from Step 11.
- React IPC/controller/UI work from Steps 13–15.
- CSP, `convertFileSrc`, asset-protocol allowlists, and app-exit job lifecycle work from Step 12.
- Any project-schema field for cache paths.

## Resolved contracts

### Command and response

Add this native shape without adding a TypeScript adapter yet:

- Input: owner window, `projectId`, `assetId`, granted `path`, and `sequenceRate: RationalRate`.
- Output: `PreparedVideoAsset { proxyPath, thumbnailPath, proxyProbe }`.
- Validate IDs with the same canonical UUID rules as project contracts and normalize only to lowercase hyphenated cache segments.
- Require a positive, JavaScript-safe, reduced sequence rate before filesystem or process work.

The Tauri command resolves `window.app_handle().path().app_cache_dir()` using the verified Tauri 2.11.5 path API, then delegates to a core helper that accepts an injected cache root and executable names for tests.

### Profile and fingerprint

Add direct `sha2 = "=0.10.9"` ownership in `Cargo.toml`; that exact version already exists transitively in `Cargo.lock`.

Use a versioned `preview-v1` profile. Hash length-delimited fields so concatenation cannot collide:

1. Lossless canonical source path bytes: Unix bytes or Windows UTF-16 code units encoded little-endian.
2. Source byte length.
3. Source modified time as Unix seconds plus nanoseconds.
4. Profile version and every fixed encoding/sampling constant.
5. Reduced sequence-rate numerator and denominator.

Use lowercase SHA-256 hex in app-owned filenames:

- `proxy-<fingerprint>.mp4`
- `thumbnail-<fingerprint>.jpg`

A changed source identity/profile/rate selects new names. Old matching proxy/thumbnail names are removed only after the new pair passes final validation; unrelated files are untouched.

### Cache containment

Create and canonicalize one directory component at a time: app cache, `video-phase1`, project UUID, asset UUID, then `preview-v1`. Reject non-direct canonical children and non-directories so pre-existing symlinks/junction-like escapes cannot redirect writes before containment is checked.

Create `tempfile::NamedTempFile` values with `.mp4`/`.jpg` suffixes in the validated profile directory and convert them to `TempPath` before child-process use. `TempPath` is specifically documented for child processes, deletes on drop, and `persist` atomically replaces an existing destination on the same filesystem.

The pair is transaction-like, not falsely described as one filesystem transaction: generate and validate both temporary artifacts first, promote each atomically, revalidate both final paths, then clean stale owned artifacts. A promotion failure returns an error; the next call treats any incomplete pair as a cache miss and repairs it.

### Proxy profile

Compute exact even output dimensions in Rust before building argv:

- Never upscale.
- Fit within 1280×720.
- Preserve aspect ratio as closely as integer scaling allows.
- Round each selected dimension down to an even value and reject sources that cannot produce at least 2×2 yuv420p output.

Build one direct FFmpeg token vector with no shell string:

- Quiet/no-input-overwrite controls: `-hide_banner -loglevel error -nostdin -y`.
- Exact first video stream and optional first audio stream.
- Scale to the precomputed dimensions, set square SAR, normalize to the requested CFR, and output yuv420p.
- Encode H.264 with a fixed software profile (`libx264`, fixed preset/CRF) and fast-start MP4.
- When source audio exists, encode AAC at fixed Phase 1 settings; otherwise use `-an`.
- Use an explicit MP4 muxer and the unique temporary destination token.

Keep proxy and thumbnail timeouts separate and bounded; keep stdout small and stderr as a bounded diagnostic tail through the existing supervisor.

### Ten-frame tile

Build a second direct FFmpeg token vector that samples over `[0, duration)` at rational `10_000_000 / durationMicroseconds`, scales/pads every cell to 160×90, and tiles exactly `10x1` into one 1600×90 JPEG. Emit one frame with fixed JPEG quality and an explicit image muxer to the unique temporary path.

The filter graph remains one argv token. Tests compare exact tokens and option order; they never normalize away order or turn the command into a shell string.

### Artifact proof

Refactor `probe.rs` without changing `video_probe_media` output:

- Preserve the public grant-first wrapper.
- Add a crate-private trusted-path probe for already-contained app-cache files.
- Preserve `MediaProbe` as the IPC/project shape while carrying internal pixel format for derived validation.

A proxy is valid only when:

- It is a nonzero regular file.
- Video is H.264, dimensions equal the computed even target and remain within 1280×720, pixel format is `yuv420p`, average/real rates equal the requested reduced rate, and VFR is false.
- Audio is AAC when the source had audio and absent when the source did not.
- Duration differs from the source by no more than one requested output frame.

A thumbnail is valid only when it is a nonzero regular JPEG produced at the expected path; the ignored system-FFmpeg integration additionally probes it as MJPEG at exactly 1600×90.

No untrusted source path, full stderr, or executable path may appear in serialized command errors.

## Testable slices

### Slice 1 — deterministic model and command plans

Files:

- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/Cargo.lock`
- `apps/desktop/src-tauri/src/video/derived.rs`
- `apps/desktop/src-tauri/src/video/mod.rs`
- `apps/desktop/src-tauri/src/video/types.rs`
- `apps/desktop/src-tauri/src/video/tests.rs`

Implement profile constants, request/response records, UUID/rate validation, source-identity fingerprinting, cache-relative names, even fit geometry, duration/frame tolerance, and exact proxy/thumbnail argv builders. Do not execute FFmpeg or register a command in this slice.

Tests prefixed `derived_` cover malicious IDs, reduced rates, landscape/portrait/no-upscale/odd/tiny geometry, fingerprint stability and every invalidation input, exact AV/video-only proxy argv, exact thumbnail argv, and output paths that remain descendants of the supplied root.

**Stop checkpoint:** Rust format, focused `derived_` tests, the complete portable Cargo suite, and Clippy with warnings denied must pass before any Slice 2 work.

### Slice 2 — trusted probe seam and validators

Refactor probe parsing to expose internal pixel format while preserving every existing source-probe result and test. Add the trusted app-owned path probe and pure proxy/thumbnail validators. Add synthetic ffprobe cases for wrong codec, dimensions, rate, VFR, pixel format, audio branch, duration tolerance, zero-size files, and failure redaction.

### Slice 3 — contained cache lifecycle

Implement component-by-component cache creation, symlink escape rejection, suffixed `TempPath` creation, cache-hit validation, atomic per-file promotion, final pair validation, and conservative stale/partial cleanup. Filesystem-only tests inject valid/invalid bytes and promotion failures; they prove no writes escape the cache, old valid destinations survive pre-promotion failures, temporary files disappear, corrupt exact-fingerprint artifacts are replaced, stale owned artifacts are removed after success, and unrelated files survive.

### Slice 4 — supervised preparation and native command

Compose grant authorization, source metadata/probe, fingerprint/cache hit, two supervised FFmpeg runs, temporary validation, promotion, final validation, and response serialization. Map all supervisor failures to existing typed redacted errors. Resolve app cache in `video_prepare_asset`, export it from `video/mod.rs`, register it in the production builder, and add it to the mock IPC handler.

Portable tests prove an ungranted source fails before a missing executable, malformed IDs/rates fail before cache writes, missing FFmpeg/ffprobe failures are typed/redacted, and the command is reachable over mock IPC without adding generic filesystem or shell permissions.

### Slice 5 — real fixture proof and checkpoint update

Add one ignored local-FFmpeg integration that prepares the canonical fixture into a temp cache, verifies the H.264/AAC 320×180 CFR proxy and 1600×90 MJPEG tile, calls preparation again to prove cache reuse, corrupts one artifact to prove repair, and confirms no partial/stale owned files remain. Run it explicitly with system FFmpeg, then run full Rust/root/Tauri gates and update `ROADMAP.md` to mark Step 10 complete and Step 11 next.

## Verification criteria

- Every portable test passes without requiring FFmpeg.
- The explicit ignored integration passes with the documented FFmpeg 8.1.2 fixture environment.
- `video_probe_media` behavior and existing 28 Rust tests remain unchanged.
- All child processes still go through `run_supervised`; argv remains tokenized and shell-free.
- Cache writes can target only validated app-owned directories and cleanup cannot touch source media, projects, export destinations, or unrelated cache files.
- A returned preparation always refers to a currently validated proxy/thumbnail pair.
- No `render.rs`, render job state/event, export flow, frontend adapter, or Step 11 behavior is introduced.

## Steps

1. Add the pinned SHA-256 dependency, preparation IPC records, and a new `video/derived.rs` containing the versioned profile, strict UUID/rate inputs, source-identity fingerprint, safe cache-relative artifact names, even fit geometry, duration tolerance, and deterministic proxy/thumbnail argv builders.
2. Add `derived_` unit tests in `video/tests.rs` for identity validation, path containment by construction, geometry edge cases, fingerprint invalidation, optional-audio branches, and exact no-shell argv order.
3. Run Rust formatting, focused `derived_` tests, the complete portable Cargo suite, and all-target/all-feature Clippy with warnings denied; fix failures and stop after this first passing slice for review.
4. Refactor `video/probe.rs` to preserve the grant-first public API while exposing internal pixel-format inspection and a trusted app-owned-path probe, then add pure artifact validation and exhaustive parser/validation tests.
5. Implement component-by-component canonical cache directory creation, symlink escape rejection, child-process-safe suffixed `TempPath` handling, atomic per-artifact promotion, final pair validation, and conservative owned-file cleanup with filesystem fault tests.
6. Compose the core preparation workflow around `run_supervised`: authorize first, probe/fingerprint, reuse a valid cache pair, generate and validate both temps, promote, revalidate, clean stale owned artifacts, and return typed redacted errors on every failure.
7. Add `video_prepare_asset`, resolve `app_cache_dir` through the window app handle, re-export/register only that command, and add portable grant-order, malformed-input, missing-tool, redaction, and mock-IPC reachability tests.
8. Add and explicitly run the ignored canonical-fixture integration proving proxy codec/audio/rate/dimensions, ten-frame tile dimensions, cache reuse, corruption repair, and complete partial/stale cleanup.
9. Run Cargo fmt, Clippy, portable and explicit FFmpeg tests, root pnpm build/check/test/lint/format gates, and the exact no-bundle Tauri production build; fix every failure without adding Step 11 code.
10. Update `ROADMAP.md` with measured Step 10 evidence and make Step 11 the next item only after all Step 10 verification criteria pass.
