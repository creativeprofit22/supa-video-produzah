# Video Phase 01: Standalone single-clip vertical slice

**Status:** Proposed implementation plan; no production implementation has started  
**Product, workspace, and implementation root:** `E:\Projects\supa-video-produzah`

## Outcome

Bootstrap Supa Video Producer as a standalone Tauri v2 + React desktop product in this repository, then deliver one complete path: create or open a one-clip `.svpvideo` project, probe and proxy local media, trim through typed immutable commands, preview controlled media, export H.264/AAC MP4 through supervised FFmpeg, validate the result, cancel safely, and save/reopen the project.

This repository is the only source tree, package workspace, build root, runtime implementation root, and write target. No source, package, daemon, process supervisor, UI primitive, fixture, or generated artifact comes from another local product repository.

## Repository findings

- The repository contains only `ROADMAP.md` and `.gg/`; there is no application, package workspace, lockfile, Tauri shell, design system, or reusable production code.
- Phase 1 is therefore a bootstrap plus vertical slice, not an integration.
- `ROADMAP.md` defines the same standalone boundary and keeps agents, providers, multitrack editing, bundled FFmpeg, stock, captions, and native compositing out of Phase 1.
- All production paths below are relative to this repository. Absolute paths appear only in planning and local verification commands.

## Verified implementation baseline

Research was refreshed against official/current sources on 24 July 2026:

- Official Tauri `create-tauri-app` supports `react-ts`, pnpm, `--manager`, `--identifier`, and `--yes`; scaffold with `pnpm create tauri-app apps/desktop --manager pnpm --template react-ts --identifier com.supavideo.producer --yes`.
- Tauri v2 requires Windows C++ Build Tools, WebView2, and Rust. Set the app crate `rust-version` to `1.87` because the selected `process-wrap` release requires it.
- Tauri commands support serde payloads, managed Rust state, and window-targeted events. Use commands for request/response and one small, window-targeted event stream for render progress.
- Tauri asset loading requires `app.security.assetProtocol.enable = true` and an explicit scope. Scope Phase 1 to `$APPCACHE/video-phase1/**/*`, not the whole cache or user filesystem, and add only the matching CSP source.
- Rust-side native dialogs are supported through `tauri_plugin_dialog::DialogExt`; the webview does not receive generic filesystem permissions.
- pnpm requires a root `pnpm-workspace.yaml`; `workspace:*` guarantees internal dependencies resolve locally.
- FFmpeg option order is semantically significant. Plans therefore use one exact argv grammar and never shell strings.
- `process-wrap` 9.1.0 provides Unix process groups and Windows Job Objects, with group-aware kill behavior. Use it instead of assuming `std::process::Child::kill` terminates descendants.

Pin the implementation baseline in manifests and lockfiles:

- Node `>=22.12`, pnpm `10.34.5`, and `packageManager: pnpm@10.34.5`.
- React/React DOM `19.2.8`, Vite `8.1.5`, `@vitejs/plugin-react` `6.0.4`, Vitest `4.1.10`, Testing Library React `16.3.2`, and jsdom `29.1.1`.
- TypeScript `6.0.3`, not TypeScript 7, because `typescript-eslint` `8.65.0` currently declares TypeScript `<6.1.0`; ESLint `10.7.0` and Prettier `3.9.6`.
- Zod `4.4.3`, Lucide React `1.26.0`, Geist/Geist Mono variable packages `5.3.0`.
- `@tauri-apps/api` `2.11.1`, `@tauri-apps/cli` `2.11.4`, Rust `tauri` `2.11.5`, `tauri-build` `2.6.3`, `tauri-plugin-dialog` `2.7.2`, `serde` `1.0.229`, `serde_json` `1.0.151`, and `process-wrap` `9.1.0`.

If the scaffold resolves a newer mutually compatible patch during implementation, update this baseline and lockfiles together only after checking declared engine/peer ranges and official migration notes.

## Architecture

```text
E:\Projects\supa-video-produzah
  ├── package.json
  ├── pnpm-workspace.yaml
  ├── pnpm-lock.yaml
  ├── tsconfig.json
  ├── apps/
  │   └── desktop/
  │       ├── src/                    React product UI
  │       └── src-tauri/              Rust native boundary
  └── packages/
      ├── video-contracts/            schemas, errors, rational time
      ├── video-project/              commands, revisions, history
      └── video-render/               deterministic render-plan compiler
```

- `packages/video-contracts` is browser-safe and owns persisted/IPC schemas.
- `packages/video-project` is browser-safe and owns deterministic project creation, command execution, and immutable undo/redo.
- `packages/video-render` is browser-safe and compiles one immutable revision into an allowlisted FFmpeg plan; it performs no I/O.
- `apps/desktop/src/video` owns ephemeral UI state and the typed Tauri client.
- `apps/desktop/src-tauri/src/video` owns all paths, native dialogs, files, cache, ffmpeg/ffprobe processes, job ownership, output promotion, and post-render proof.
- The webview receives only validated metadata and cache preview URLs. It never receives source bytes, arbitrary filesystem access, or an executable command string.
- Final export captures a `ProjectRevision`; later draft changes cannot alter a running job.

## Bootstrap files

Create at root:

- `package.json`: private, ESM, engine/package-manager pins, and recursive `build`, `check`, `test`, `lint`, `format`, and `format:check` scripts.
- `pnpm-workspace.yaml`: `apps/*` and `packages/*` only.
- `pnpm-lock.yaml`: generated by normal pnpm installation in this repository.
- `tsconfig.json`: strict ESM/bundler defaults, declarations for packages, no unchecked indexed access, exact optional properties, and consistent casing.
- `eslint.config.js`, `.prettierrc`, `.prettierignore`.
- `.gitignore`: dependencies, `dist`, Vite output, Rust `target`, local caches/logs/env files, screenshots outside committed evidence, temp renders, and user media; retain the deterministic fixture.
- `README.md`: prerequisites, FFmpeg PATH requirement, setup/dev/test commands, `.svpvideo` format, security boundary, and Phase 1 limitations.

Create `apps/desktop/` from the official scaffold, then remove all demo content. Keep generated Tauri icons/configuration unless replaced by product-owned assets. Set one main window with a 1280×800 default and 480×360 minimum.

Create private packages named:

- `packages/video-contracts`: `@supa-video/contracts`
- `packages/video-project`: `@supa-video/project`, depending on `@supa-video/contracts` via `workspace:*`
- `packages/video-render`: `@supa-video/render`, depending on `@supa-video/contracts` via `workspace:*`
- `apps/desktop`: `@supa-video/desktop`, depending on all three via `workspace:*`

Each package gets `build`, `check`, and `test` scripts. Recursive builds must remain acyclic and topological.

## Domain contracts

### Rational time

Add `packages/video-contracts/src/time.ts`:

- `RationalRate = { numerator: safe positive integer; denominator: safe positive integer }`, always reduced.
- `RationalTime = { value: safe non-negative integer; rateNumerator; rateDenominator }`.
- BigInt-backed multiply/divide helpers.
- Explicit `floor`, `ceil`, and `nearestTiesAwayFromZero` modes.
- Half-open `[in, out)` frame ranges.
- ffprobe microseconds to source frames with `ceil` so a partial last frame remains addressable.
- Exact frame trim boundaries; nearest rounding only for seek/display conversion.
- Bounded decimal seconds only at the FFmpeg edge.
- Rejection of unsafe integers, invalid rates, implicit mixed-rate arithmetic, and sub-frame ranges.

Test 24/1, 25/1, 30/1, 30000/1001, and 60000/1001, including one-frame and long-duration limits.

### Project file

Add strict Zod schemas in `packages/video-contracts/src/project.ts` and a V1 dispatcher in `migrations.ts`:

- `VideoProjectFileV1`: `schemaVersion`, UUID identity, name/timestamps, `currentRevisionId`, and linear revisions.
- `ProjectRevision`: UUID ID/parent, sequence number, commit time, command summary, and complete immutable state.
- `VideoProjectState`: zero/one asset and zero/one sequence.
- `VideoAsset`: stable ID, display name, locator, and probe snapshot; no proxy/cache/object URL/decoder data.
- `AssetLocator`: project-relative path and/or absolute fallback, requiring one.
- `VideoSequence`: exact rate, normalized even dimensions, 48 kHz audio rate, exactly one video track.
- `VideoClip`: stable asset ID, timeline start zero, exact source in/out.
- `MediaProbe`: integer duration microseconds, exact average/r rates, VFR flag, dimensions, codec names, audio shape, and file size.

Use `.svpvideo`. Unknown/future schemas fail actionably. Mirror the V1 envelope in Rust with `serde(deny_unknown_fields)` because Rust must safely resolve locators and create grants. Add a shared fixture test proving TypeScript and Rust accept/reject the same V1 documents.

### Commands and history

Add strict discriminated command schemas in `commands.ts`:

- `ImportAsset`
- `CreateSequence`
- `InsertClip`
- `TrimClip`

Every command carries UUID `commandId`, `baseRevisionId`, and `issuedAt`; `commandId` becomes the next revision ID.

Implement in `packages/video-project/src/`:

- `create-project.ts`: empty V1 document and initial immutable revision.
- `execute-command.ts`: validate base and command; enforce one asset/sequence/track/clip; reject duplicates, missing references, mixed rates, stale bases, and empty/out-of-source trims; preserve asset identity.
- `history.ts`: immutable undo/redo cursor and branch truncation after undo plus new commit.

Deep-freeze returned objects in development/tests. Range/drag changes remain ephemeral; Apply Trim emits one command and one understandable history entry.

### Render plan

Add `RenderPlanV1` in contracts and `compileSingleClipRenderPlan` in `packages/video-render/src/compile-render-plan.ts`.

The plan contains schema/plan/revision IDs, expected duration/rate/dimensions/audio, executable enum `ffmpeg`, exact input/output paths, and one argv array. The exact Phase 1 grammar includes:

- `-hide_banner`, `-nostdin`, bounded log level, `-progress pipe:1`, and `-nostats`.
- Input path after `-i`, then output-side `-ss` and `-t` derived from exact rational boundaries.
- Explicit video map and conditional audio map.
- Deterministic scale/pad to sequence dimensions, sequence CFR, `libx264`, `yuv420p`, AAC/48 kHz when audio exists, and `+faststart` MP4.
- Output destination as the final argv item.

Rust revalidates every token, order, expected path, and optional-audio branch before substituting a sibling partial destination. Snapshot tests normalize only platform path separators; no test normalizes away option order.

## Native boundary

Add `apps/desktop/src-tauri/src/video/`:

- `mod.rs`: registration/re-exports.
- `types.rs`: mirrored V1 envelope, IPC records, error codes, probe/preparation/output records, and render events.
- `grants.rs`: canonical per-window project/source/output grants.
- `project_io.rs`: dialogs, bounded reads, locator resolution, and atomic saves.
- `process.rs`: `process-wrap` setup, bounded capture, timeout/cancellation polling, group kill, wait/reap.
- `probe.rs`: ffprobe execution and strict JSON conversion.
- `derived.rs`: controlled proxy, ten-frame thumbnail strip, cache fingerprinting/promotion.
- `render.rs`: argv validation, jobs, progress, collision policy, post-render validation, final promotion, preview copy, cleanup.

`lib.rs` manages `VideoPathGrants` and `VideoRenderJobs` through Tauri state, registers only the required commands, emits to the owning window label, and handles `WindowEvent::Destroyed`, `RunEvent::ExitRequested`, and `RunEvent::Exit` by flagging owned jobs, terminating process groups/Job Objects, waiting, and cleaning partial files.

### Dialog and path model

Rust-side `DialogExt` commands:

- `video_pick_new_project_path(defaultName)` with `.svpvideo` filter and project grant.
- `video_pick_source()` with explicit common video-container filters and source grant.
- `video_open_project()` with `.svpvideo` filter, 2 MiB read cap, strict native V1 parse, safe locator resolution, and explicit missing-source records.
- `video_pick_export_path(defaultName)` with MP4 filter and output grant.

All later commands receive `WebviewWindow`, canonicalize existing paths, normalize not-yet-created destination parents, and verify exact owner grants. IDs used as cache path segments must be UUIDs. Relative locators reject absolute paths and `..` escape; symlink canonicalization must remain under the expected project-relative target. Source and destination cannot resolve to the same file.

### Persistence

`video_save_project(path, document)` accepts the mirrored typed V1 structure, requires the owner project grant and `.svpvideo`, serializes under the size cap, writes a unique sibling temp, flushes/syncs, and atomically replaces the target. Failure leaves the previous file untouched. The React controller advances active state only after save succeeds.

Open returns the validated document plus resolved/missing source records keyed by asset ID. Derived paths never enter the project file.

### Probe and preparation

`video_ffmpeg_status` runs bounded five-second direct `ffmpeg -version` and `ffprobe -version` checks.

`video_probe_media` runs direct ffprobe with a 30-second timeout and bounded stdout/stderr, prefers `avg_frame_rate`, falls back to `r_frame_rate`, rejects invalid/non-video input, converts duration to integer microseconds, and flags materially different average/r rates as VFR.

`video_prepare_asset`:

- Requires a granted source and valid UUIDs.
- Writes only under `$APPCACHE/video-phase1/<project>/<asset>/<profile>/`.
- Creates an H.264/AAC yuv420p proxy capped inside 1280×720 with even dimensions and sequence CFR.
- Creates one JPEG tile from ten evenly sampled frames.
- Uses source canonical path, size, mtime, and profile version as the Phase 1 fingerprint.
- Writes unique temps and atomically promotes valid outputs; invalid/stale artifacts are replaced.
- Returns cache paths only after probing the proxy and checking the thumbnail exists/nonzero.

### Render supervision

`video_start_render(plan, overwrite)`:

- Validates the mirrored plan, immutable revision identity, exact grammar, grants, MP4 extension, and duplicate/running plan IDs.
- Returns typed `output_exists` unless a UI confirmation retries with `overwrite=true`.
- Replaces only the argv destination with `.svp-part-<jobId>.mp4` in the selected destination directory.
- Spawns under a Unix process group or Windows Job Object with no shell.
- Parses FFmpeg `key=value` progress records, handles `out_time_us`/`out_time_ms` defensively, clamps monotonic progress to expected duration, and emits small owner-window events: `started`, `progress`, `completed`, `failed`, or `cancelled`.
- Bounds stderr to a useful tail and never logs full user paths in UI-facing errors.
- Probes the temporary master; requires H.264 video, exact even dimensions, AAC when expected, nonzero size, and duration within one output frame.
- Atomically promotes/replaces only after validation, then copies a validated preview into app cache.
- Emits completion last and exactly once.

`video_cancel_render(jobId)` verifies owner and sets an idempotent atomic cancellation flag. The worker performs group-aware kill, waits/reaps, removes partials, and settles once. All failure, cancellation, validation, promotion, window-destroy, and app-exit paths clean partials.

## Tauri security configuration

- Keep the generated capability minimal: only core permissions needed by `invoke`, event listening, window behavior, and `convertFileSrc`; do not expose filesystem or shell plugins.
- Initialize only the Rust dialog plugin; do not grant its generic JavaScript permission because dialogs are wrapped by product commands.
- Configure `assetProtocol` for `$APPCACHE/video-phase1/**/*` only and deny unrelated cache paths.
- Set a production CSP that allows app code/styles/fonts plus the exact asset protocol media/image source; no remote scripts, network APIs, or `csp: null`.
- Disable global Tauri injection and import APIs from `@tauri-apps/api` modules.
- Validate all command senders through Tauri's registered command/capability boundary and repeat domain/path checks in Rust.

## React state and components

The standalone app launches directly into `VideoWorkspace`; there are no inherited modes or provider gates.

Add `apps/desktop/src/video/video-ipc.ts` as the only frontend native boundary and `useVideoProject.ts` as an injectable state controller.

Project states: `empty`, `tool-check`, `probing`, `preparing`, `ready`, `missing-source`, `invalid-project`, `save-error`.  
Render states: `idle`, `running`, `cancelling`, `cancelled`, `failed`, `succeeded`.

The controller validates native payloads with Zod, sequences new/open flows, executes candidate commands, saves before activation, prepares cache media, captures immutable export revisions, handles collision confirmation, ignores stale job events, and unsubscribes listeners on unmount.

Add:

- `VideoWorkspace.tsx`: app landmark, top bar, orchestration, shortcuts, close/back guards.
- `VideoProjectOpener.tsx`: New/Open and FFmpeg prerequisite state.
- `AssetPanel.tsx`: honest asset row with name, duration, resolution, codecs, proxy/missing status.
- `ProgramMonitor.tsx`: controlled `<video>`, playback/seek/frame evidence, retained-range stop, media error fallback.
- `SingleClipTimeline.tsx`: one semantic track, thumbnail-backed clip, kept range, playhead, pointer seek, and non-drag controls.
- `TrimInspector.tsx`: labeled range and numeric frame inputs, validation, Apply Trim, Undo, Redo.
- `ExportPanel.tsx`: destination, export, progressbar, cancel/retry, replacement `<dialog>`, and verified output report.
- `format-video.ts`: locale-aware duration/frame/byte/rate formatting.
- `video.css`: product tokens, shared geometry, states, adaptive layout, forced-colors/reduced-motion rules.

Playback rules:

- Load only cache proxy/final-preview URLs from `convertFileSrc`.
- Start at trim-in when parked outside the kept range and stop at trim-out.
- Space toggles play unless an editable/native control owns focus.
- Left/Right seek one frame; Shift+Left/Right seek ten.
- Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z operate history outside editable fields.
- Native range/number inputs provide complete single-pointer and keyboard alternatives to timeline drag.
- Keep tab order aligned with visual order; restore focus after dialogs/native pickers.

## Design direction

### Design read

- **Surface:** standalone desktop application UI, with media review as the lead task.
- **Audience:** creators/editors on Windows first, using pointer and keyboard, including users needing visible focus, scalable text, reduced motion, forced colors, and non-drag alternatives.
- **Single job:** shorten one local clip and export a verified MP4.
- **Risk:** trim is cheap/reversible; export can be long-running and overwrite a file, so cancellation and proof are decision-critical.
- **Content:** one asset, monitor, track, exact frames, progress, and verified output; long names and paths are normal.
- **Platform:** Tauri WebView, 480×360 minimum through wide desktop, offline by design.
- **Constraint:** no local design system exists; Phase 1 must establish a small documented one without adding a component library.

### Evidence and thesis

The application-UI archetype is supported by 7/74 corpus documents; focus appears in 7/7 and disabled state in 6/7, while keyboard language appears in only 1/7, so keyboard behavior must come from the production contract rather than visual frequency. Use `linear.app` and `superhuman` only as aligned evidence for stable dense framing and repeated-task hierarchy; use `intercom` as contrast against oversized editorial cards.

Build a compact **source-to-master workbench**. The monitor is the first visual anchor, the timeline is second, Export is the primary action, and exact frame/output evidence stays beside the controls it proves. Use flat charcoal surfaces because video imagery is decision-critical and prolonged review benefits from a subdued surround. Use one-pixel separators instead of floating/glass cards, a compact 4/8 px spacing scale, self-hosted Geist Sans/Mono, and one accent for playhead, kept range, keyboard focus, and primary action with distinct shapes/text so color is never the only cue.

The dark surface belongs because this is a media-review environment where the image must dominate, not because dark styling implies premium. Reject gradients, glass, bento layouts, card grids, icon medallions, ambient motion, ubiquitous pills, tint-on-tint status surfaces, generic hover lift, fake metrics, and decorative labels. Use Lucide only, with visible labels for unfamiliar actions.

Responsive composition:

- `>=1100px`: asset/monitor/inspector aligned columns; timeline spans below; one shared outer rail/gutter.
- `760–1099px`: asset metadata above monitor; inspector/export remain adjacent to timeline.
- `<760px`: one scrollable column in task order: monitor, timeline, Edit, Export.
- `480×360`: native minimum remains operable without horizontal page scrolling.
- `320 CSS px`: browser/dev-server reflow check for WCAG evidence even though the native minimum is wider.

Document semantic/primitive/component tokens, control anatomy, states, breakpoints, and measured contrast in `apps/desktop/DESIGN.md`.

## State and accessibility contract

Implement no-project, checking tools, probing, preparation, ready, missing source, invalid project, unsupported media, missing FFmpeg, save failure, dirty draft, saving, invalid trim, collision, running, cancelling, cancelled, failed, retry, success, and output-preview failure.

- Native semantic elements first; no ARIA where native semantics suffice.
- Persistent labels/units/errors; no placeholder-only controls.
- Immediate `:focus-visible`, no sticky pointer focus, no global outline suppression.
- `aria-live="polite"` for preparation/save/render updates, `role="alert"` for blocking errors, semantic progressbar with value text.
- Minimum 24×24 CSS targets; 44×44 for icon-only/touch-oriented controls where layout permits.
- Named transitions only; no `transition: all`; reduced motion removes nonessential travel.
- WCAG 2.2 AA measured contrast for text, controls, icons, focus, and meaningful timeline graphics.
- Native `<dialog>` for replacement/leave confirmation with initial focus, Escape, inert background, and focus return.
- No autoplay, surprise audio, or dependence on drag/hover/color alone.
- Offline is the normal state; the complete task remains available without network access.

## Fixtures and tests

Add `apps/desktop/src-tauri/fixtures/video-phase1/`:

- `single-clip.mp4`: deterministic FFmpeg `testsrc2` plus sine audio, small enough for source control.
- `single-clip.svpvideo`: V1 document with project-relative media locator.
- `README.md`: exact generation command, expected duration/rate/dimensions/codecs/hash, and self-generated provenance.

TypeScript tests:

- Strict schemas, migration dispatch, malformed/future versions.
- Rational conversion/rounding at all required rates.
- Command happy paths and every identity/range/base invariant.
- Undo/redo and branch truncation.
- Render argv exact order, optional audio branch, normalized paths, and no shell string.

Rust unit tests:

- TypeScript/Rust fixture parity.
- ffprobe AV/video-only/VFR/malformed/missing fields/non-video.
- Grant ownership, locator resolution, destination-parent handling, symlink/traversal rejection, extension/size caps.
- Exact argv rejection for insertion/removal/reorder/unknown/path mismatch.
- Progress parsing/clamping and one terminal event.
- Cancel/exit/error races and duplicate cancellation.
- Atomic save failure preserving prior content.
- Cache/temp names unable to escape app cache.

Explicit local-FFmpeg integration tests:

- Probe fixture and generate/validate proxy plus thumbnail.
- Export a trimmed revision and assert H.264/AAC, dimensions, nonzero size, and duration within one frame.
- Cancel a deliberately slowed render and prove the process group is gone with no partial destination.
- Force nonzero exit and prove typed failure plus cleanup.

React tests with an injected backend:

- Opener has no network/provider/workspace dependency.
- New flow: dialog, probe, four commands, save, preparation.
- Open validates schema and distinguishes missing media.
- Draft trim does not commit; Apply Trim saves once; save failure preserves prior revision.
- Playback/seek boundaries and shortcuts respect editable controls.
- Export captures one revision, reports progress, confirms collision, cancels/retries, ignores stale events, and shows verified metadata.
- Accessible names, announcements, tab order, dialog focus return, and no pointer-stuck focus.

## Verification and evidence

After implementation run:

- `pnpm install --frozen-lockfile` after intentional lockfile creation.
- Focused package `build`, `check`, and `test` commands.
- Desktop TypeScript check, lint, format check, and React tests.
- `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`.
- `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`.
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`.
- Explicit Windows local-FFmpeg integrations.
- Root `pnpm build`, `pnpm check`, `pnpm test`, `pnpm lint`, and `pnpm format:check`.

Run the real Windows Tauri app through create, prepare, play, frame seek, trim, Apply, undo, redo, save, export, cancel, cleanup proof, successful export, final-preview playback, close, reopen, and duration reproduction. Exercise all specified failure/collision states and complete the core flow by keyboard.

Capture 1280×800, 1920×1080, 480×360, and a 320 CSS-pixel reflow render. Verify 200% text, one long German-like label set, long path/name, missing thumbnail, reduced motion, forced colors/high contrast, no-hover, visible focus, picker/dialog focus return, and no sticky pointer focus. Run an accessibility scanner plus manual semantics/status review.

Record pass/fail/unverified production-contract checks and measured startup/interaction/render evidence in `apps/desktop/DESIGN.md`. Read the evidence-led quality rubric before critique, score the first captures, remove one unnecessary decorative idea, revise the weakest criterion and any contract failure, recapture, and require at least 20/24 with no zero in accessibility, consistency/flow, responsive behavior, state completeness, or authenticity.

Phase 1 passes only when a clean checkout with documented prerequisites and local FFmpeg installs/builds its own workspace, launches its own Tauri app, creates/opens the deterministic fixture, trims through the UI, exports a verified MP4, cancels without survivors/partials, reopens the project, and reproduces duration within one frame without another source repository, external NLE, upload, generated-video service, or manual command-line editing.

## Risks and rollback

- **Bootstrap/API drift:** use the verified scaffold command, inspect generated manifests/config, and lock compatible versions before feature work.
- **TypeScript 7 incompatibility:** pin TypeScript 6.0.3 until typescript-eslint declares TS7 support.
- **Process survivors:** use process groups/Job Objects, group-aware kill, wait/reap, lifecycle cancellation, and survivor integration tests.
- **WebView decode mismatch:** preview controlled proxy/final copies; ffprobe is authoritative proof.
- **VFR ambiguity:** persist exact rate, flag VFR, normalize proxy/export, defer native VFR mapping.
- **Path overreach:** Rust-only dialogs, per-window canonical grants, strict locators, narrow asset scope, no fs/shell plugin.
- **Partial/corrupt output:** unique sibling partial, post-render probe, atomic promotion, completion last.
- **UI authority drift:** drafts are ephemeral; commands create revisions; saves succeed before activation.
- **Main-thread stalls:** all file/process work runs outside the webview thread with bounded payloads/output.
- **Scope creep:** schemas/UI enforce one asset/sequence/track/clip and one trim; excluded systems remain absent.
- **Licensing:** fixture is self-generated; system FFmpeg is a development prerequisite; binary distribution waits for Phase 3 review.

Implementation is additive in a currently sparse repository. Keep bootstrap, packages, native boundary, UI, and evidence as separable commits/checkpoints. If a stage fails, revert only that stage and its lockfile changes; `.svpvideo` V1 has no production users or migration obligation in Phase 1. Never delete user media or export destinations during rollback; cleanup is limited to app-owned cache and uniquely named partial files.

## Steps

1. Verify the documented toolchain and package/crate versions on the implementation machine, scaffold `apps/desktop` with the official noninteractive Tauri React TypeScript command, remove demo content, and prove the untouched shell launches.
2. Create the root pnpm workspace, engine/package-manager pins, strict TypeScript/ESLint/Prettier/Vitest configuration, ignores, README, root scripts, and lockfile; prove a frozen reinstall.
3. Create `@supa-video/contracts`, `@supa-video/project`, and `@supa-video/render` with private ESM manifests, exports, strict tsconfigs, `workspace:*` edges, and passing empty build/check/test gates.
4. Implement and test rational-time arithmetic, typed errors, strict V1 project/command/render schemas, UUID/path-segment constraints, and migration dispatch in `packages/video-contracts`.
5. Implement and test empty project creation, deterministic four-command execution, Phase 1 invariants, immutable revisions, and undo/redo branch semantics in `packages/video-project`.
6. Implement and snapshot-test the exact single-clip FFmpeg argv compiler and rational second formatting in `packages/video-render`.
7. Generate and commit the deterministic MP4 plus `.svpvideo` fixtures and provenance/hash README under `apps/desktop/src-tauri/fixtures/video-phase1`.
8. Add Rust mirrored contracts/errors, TypeScript-Rust fixture parity tests, per-window grants, Rust-side dialogs, safe locator resolution, bounded project open, and atomic save in `apps/desktop/src-tauri/src/video`.
9. Add `process-wrap` supervision, tool discovery, bounded ffprobe parsing, process-group/Job-Object lifecycle handling, and focused parser/process tests.
10. Implement controlled proxy and thumbnail generation, cache fingerprinting, narrow app-cache paths, atomic promotion, artifact validation, and cleanup tests.
11. Implement exact render-plan validation, owner-scoped jobs/events, collision policy, monotonic progress, post-render probing, final promotion, preview copy, idempotent cancellation, terminal-event uniqueness, and survivor/partial cleanup tests.
12. Register Tauri state, commands, dialog plugin, window/app lifecycle cleanup, minimal capabilities, production CSP, and `$APPCACHE/video-phase1/**/*` asset scope; run Rust fmt, clippy, and unit tests.
13. Add `video-ipc.ts` and the injectable `useVideoProject` controller with validated payloads, new/open/save/prepare flow, immutable export capture, stale-event rejection, collision handling, and unsubscription tests.
14. Establish Geist/Lucide/product tokens and implement `VideoWorkspace`, opener, asset panel, program monitor, timeline, trim inspector, export panel, formatting, shortcuts, semantic states, dialogs, and adaptive CSS.
15. Add React integration/accessibility tests for all primary, error, retry, collision, cancellation, keyboard, focus-return, and non-drag paths.
16. Add explicit local-FFmpeg integration tests for proxy/thumbnail, valid export, forced failure, process-group cancellation, cleanup, and duration/codec/dimension proof.
17. Create `apps/desktop/DESIGN.md`, run all focused and root frozen-lock/build/check/test/lint/format/Rust gates, and fix every failure.
18. Launch the real Windows Tauri app, complete the fixture create/trim/undo/redo/cancel/export/reopen flow, capture all required viewport/accessibility/error evidence, perform one rubric critique/revision cycle, and record the final completion proof.
