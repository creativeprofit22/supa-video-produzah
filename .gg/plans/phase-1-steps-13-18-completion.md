# Phase 1 Steps 13–18 Completion Plan

## Outcome

Complete the remaining Phase 1 desktop workflow in dependency order without rebuilding the native project/media/render/security work that already exists. Execution is divided into five independently verifiable product checkpoints: persistence, editing UI, integration/accessibility coverage, gates/docs, and real Windows proof. A separate reliability preflight addresses the observed flaky process-timeout test before feature work begins.

Phase 2 remains blocked until the Phase 1 hard completion gate is proven from a clean checkout and the final Windows evidence is recorded.

## Audited baseline

### Complete and retained

- **Steps 1–7:** the pnpm/Tauri workspace, strict browser-safe contracts, rational time, project commands/history, deterministic render compiler, and canonical AV fixture are implemented.
- **Step 8:** Rust mirrored V1 DTOs, strict project parsing, owner-window grants, new/open/export pickers, bounded open, safe locator resolution, and atomic save are implemented and tested in `apps/desktop/src-tauri/src/video/{types,grants,project_io}.rs`.
- **Steps 9–10:** no-shell process supervision, tool status/probe, owner-authorized source probing, controlled proxy/thumbnail generation, cache containment, validation, repair, and cleanup are implemented.
- **Steps 11–12:** exact render validation, owner-scoped jobs/events, cancellation, collision-safe promotion, verified output/preview, lifecycle cleanup, production command registration, strict CSP, minimal event capability, and the narrow cache asset protocol are implemented.
- **Step 16 is already complete ahead of sequence:** all eight ignored local-FFmpeg integrations pass, covering IPC probe, derived preparation/reuse/repair, display geometry, HDR normalization, AV/video-only export, collision preservation, and cancellation/process/partial cleanup. Do not rewrite these integrations; rerun them as regression gates.
- Existing frontend work must be preserved: `video-ipc.ts` validates tool/probe/preparation/render payloads; `use-video-project.ts` already handles controlled preparation, immutable render-plan capture, owner-event identity, monotonic progress, collision retry, cancellation, terminal states, and listener cleanup; `App.tsx` already exposes source preparation and export states with 44 passing desktop tests.
- The current visual system is established in `App.css`: self-hosted Geist/Geist Mono, Lucide, a flat dark media-review surface, acid-green action/focus accent, neutral bordered status surfaces, named transitions, 44px buttons, responsive gutters, reduced motion, and forced-colors handling. Extend this system rather than replacing it or adding a component library.

### Partial or missing

- **Step 13 is partial and is the first incomplete dependency.** Rust commands `video_pick_new_project_path`, `video_open_project`, and `video_save_project` are production-registered, but there are no shared TypeScript open-result/source-status schemas, frontend adapters, active project path, persisted history controller, new/open flow, or save-before-activation behavior. The current hook starts with an unsaved in-memory project and updates it before preparation/save.
- **Step 14 is partial.** Readiness, source, preparation, export, and basic adaptive styles exist, but there is no project opener, active-project workspace, prepared proxy playback, thumbnail timeline, playhead, trim draft/validation, committed `TrimClip`, persisted undo/redo, frame shortcuts, native overwrite dialog, or final-preview playback.
- **Step 15 is partial.** Current IPC/hook/App tests cover the implemented preparation/render slice, but not persistence, playback boundaries, trim/save invariants, undo/redo, complete keyboard operation, dialog focus, full state coverage, or automated accessibility scanning.
- **Step 17 is partial.** Local quality gates and a production no-bundle executable pass, but `apps/desktop/DESIGN.md` and committed visual/runtime evidence do not exist, test scripts still permit no-test success, the render package discovers compiled duplicate tests, and CI still emits an obsolete “desktop tests absent” warning.
- **Step 18 is not complete.** No real Tauri create/open/prepare/play/trim/undo/redo/export/cancel/reopen proof, responsive captures, manual keyboard/accessibility matrix, or rubric critique/revision evidence is committed.

### Verification baseline observed during audit

- Passed locally: frozen pnpm install, root build/check/test/lint/format, Rust fmt, all-target/all-feature Clippy with warnings denied, 62 default Rust tests, 67 `tauri-ipc-test` Rust tests on rerun, all eight real-FFmpeg integrations, Cargo asset-protocol feature inspection, `git diff --check`, and `pnpm --dir apps/desktop tauri build --no-bundle --ci`.
- Current unique TypeScript source tests: 89 (31 contracts, 5 project/history, 9 render, 44 desktop). The root command reports 98 executions because `packages/video-render` also discovers 9 compiled tests under `dist/`.
- Current HEAD `595fa8f` has a successful CI run `30173556427`.

## Roadmap drift (documentation correction, not feature scope)

Keep roadmap correction visible and separate from feature implementation:

- `ROADMAP.md` reports 85 unique TypeScript tests and 40 desktop tests; the audited baseline is 89 and 44.
- It cites run `30164505514` for `38f3c0e` as the latest remote clean-checkout evidence; HEAD `595fa8f` passed run `30173556427`.
- It describes Steps 11–12 as complete “in the current worktree,” but those changes are committed on `main`/`origin/main`.
- The master `.gg/plans/video-phase-01-single-clip.md` still says no production implementation has started; it is historical planning context, not current status.
- `.github/workflows/ci.yml` still emits a warning that desktop UI tests do not exist.
- Desktop and package test scripts retain `--passWithNoTests`; the render script also scans `dist`, inflating execution counts.
- Step 16 is complete even though Steps 13–15 are not; the final roadmap must distinguish dependency order from work completed early.

Correct these facts only in the gates/docs checkpoint after final test counts settle. Do not mix count/wording cleanup into persistence or UI commits.

## Flaky timeout regression (separate reliability preflight)

The first audited run of `cargo test --locked --features tauri-ipc-test` failed at `video::tests::supervisor_timeout_terminates_grandchild_and_releases_inherited_pipes`; the targeted test then passed three consecutive runs and the complete feature suite passed on rerun. This is a real reliability defect in the test gate even though no production process failure was reproduced.

The race is in `apps/desktop/src-tauri/src/video/tests.rs`: the 1.5-second production-style timeout can expire while a nested Rust test executable is still starting under full-suite contention, before the grandchild writes `timeout-grandchild-ready`. Stabilize the proof separately by having `process_tree_parent` write the ready marker immediately after the OS successfully spawns the grandchild. At that point the descendant exists and has inherited the pipes; the grandchild remains responsible for the delayed survivor marker, so the test still proves process-tree termination and pipe release. Do not change `process.rs`, process timeouts, or production semantics unless repetition demonstrates a production defect.

**Reliability tests**

- Run the timeout and cancellation descendant tests individually 20 consecutive times each with `--exact --nocapture`.
- Run the complete `tauri-ipc-test` suite 10 consecutive times on Windows.
- Run default and all-feature Rust tests once after the repetition loop.
- Require the final CI Linux and Windows Rust jobs to pass; both platforms exercise process-group/Job-Object branches.

**Stop condition:** any repeated failure stops Steps 13–18. If the ready marker exists but timeout/cancellation leaves the survivor marker or inherited pipes alive, classify it as a production supervisor bug and fix that bug in a separate reliability change before persistence work. Woops, the test race squeaked out first 💨.

## Architecture and state decisions

### Persistence boundary

- Add browser-safe strict schemas in `packages/video-contracts/src/project-io.ts` for `VideoSourceStatus`, `VideoSourceRecord`, and `OpenedVideoProject`; export them through `packages/video-contracts/src/index.ts`. Match the existing Rust camelCase DTOs exactly and reject unknown fields, malformed paths, duplicate source records, and asset IDs not present in the opened current revision.
- Extend `apps/desktop/src/video-ipc.ts` rather than creating a second native boundary. Add validated `pickNewVideoProjectPath`, `openVideoProject`, and `saveVideoProject` adapters with exact Tauri command names and arguments.
- Define an injectable `VideoBackend` and default `tauriVideoBackend` in `video-ipc.ts`. It owns every native operation already used by the hook plus `convertFileSrc` for cache-only media URLs. `useVideoProject(backend = tauriVideoBackend)` becomes testable without module-level Tauri mocks.
- Store active `projectPath`, `ProjectHistory`, source resolution, prepared media, persistence operation state, render state, and errors in the controller. Proxy/thumbnail/preview paths remain ephemeral and never enter `.svpvideo`.
- Use one transaction rule for every project mutation: build and validate a candidate document/history, call native atomic save, then activate the candidate only after save succeeds. On picker cancellation, preparation failure, malformed native data, or save failure, preserve the previous active project/revision/history.
- New project order: pick `.svpvideo` destination, create/validate the empty document, save it, then activate it. Source import order: pick source, probe, build the import candidate, prepare against candidate IDs, build sequence/clip candidates from validated proxy dimensions, save the final candidate once, then activate it and the prepared media. A failed save may leave only reusable app-owned cache artifacts; it must not expose an unsaved project revision.
- Open project order: validate the strict native result, create history at `currentRevisionId`, activate the document/path/source status, then prepare only a resolved current source. Missing and relink-required sources remain inspectable recovery states; no absolute fallback is silently granted in the webview.
- Use existing `ProjectHistory` for edit persistence. UI undo cannot travel before the first revision containing the Phase 1 clip; compute that edit baseline so Undo never removes the imported asset, sequence, or clip. Redo after reopen remains available when later revisions are present, and a new trim after undo keeps existing branch-truncation semantics.

### Editing and playback boundary

- Keep exact frame values authoritative. Draft trim values and playhead frames are ephemeral UI state; only Apply Trim creates one `TrimClip` command and one persisted revision.
- The draft range can expand anywhere from frame zero to the probed source-duration frame ceiling. Require safe integers and `0 <= in < out <= sourceDuration`; unchanged drafts do not create revisions.
- Preview only controlled cache paths. Convert `PreparedVideoAsset.proxyPath`, `thumbnailPath`, and verified render `previewPath` with `convertFileSrc`; never pass source or final export paths to `<video>`/`<img>`.
- `ProgramMonitor` uses the prepared CFR proxy, maps exact frames to presentation seconds, starts at draft trim-in when parked outside the kept range, and pauses/clamps at trim-out. Use native media events with a frame callback where available and a `timeupdate` fallback; playback remains usable when media loading fails.
- `SingleClipTimeline` is a semantic one-track projection with a controlled cache thumbnail, playhead, pointer seek, and native range controls for trim handles. `TrimInspector` provides labeled numeric frame inputs as the complete keyboard/single-pointer alternative.
- Space toggles play, Left/Right seek one frame, Shift+Left/Right seek ten frames, and Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z invoke persisted undo/redo. Shortcuts do nothing while an editable or native media control owns focus.
- Preserve existing immutable export capture, owner-event filtering, collision retry, cancellation, and output proof. Replace the inline overwrite confirmation with a native `<dialog>` that provides initial focus, Escape/cancel, background inertness, and focus return. After success, allow playback of the verified cache preview while keeping the user output path as display-only evidence.

### UI design read and thesis

- **Surface:** resizable Windows-first desktop application UI.
- **Audience:** creators editing one local clip with pointer or keyboard, including users requiring visible focus, scalable text, reduced motion, forced colors, and non-drag controls.
- **Single job:** shorten one local clip and export a verified MP4.
- **Risk:** trim/undo are reversible; save, long render, cancellation, and overwrite are higher consequence and require explicit status/proof.
- **Content:** one real asset, proxy monitor, one track, exact frames, job progress, and long local filenames/paths.
- **Constraints:** offline-first Tauri WebView, 480×360 native minimum, 320 CSS-pixel reflow evidence, narrow cache asset scope, no component library, and no source media exposure.
- **Thesis:** extend the existing compact dark source-to-master workbench. The monitor is the first visual anchor, the one-track timeline is second, exact trim controls sit adjacent, and Export remains the primary consequential action. Reuse Geist/Geist Mono, Lucide, the existing accent/focus role, flat bordered surfaces, one shared content rail, existing button/status anatomy, and calm named transitions. The dark surface belongs because video review is decision-critical; avoid gradients/glass/bento/card proliferation, emoji, mixed icons, hover lift, soft semantic tint-on-tint, `transition: all`, and generated em dashes.

## Checkpoint 1 — Persistence controller (Step 13)

### Files

- Add `packages/video-contracts/src/project-io.ts` and `project-io.test.ts`; update `packages/video-contracts/src/index.ts`.
- Extend `apps/desktop/src/video-ipc.ts` and `video-ipc.test.ts`.
- Refactor `apps/desktop/src/use-video-project.ts` and `use-video-project.test.tsx` around injected backend, active path/history, operation identity, strict new/open/save flow, and save-before-activation.
- Extend the existing mock-Tauri handler list/test in `apps/desktop/src-tauri/src/lib.rs` only enough to lock project-save handler reachability; do not alter project I/O behavior or security configuration.

### Focused tests

- Contract tests: every source status, empty project, resolved relative source, missing source, relink-required source, malformed path/UUID/document, unknown fields, duplicate/mismatched source records.
- IPC tests: exact command/argument contracts, picker cancellation, malformed response rejection, backend error normalization, and no raw native payload leakage.
- Controller tests: new cancellation; empty project save before activation; failed initial save leaves no active path; resolved/missing/relink open; malformed open preserves prior project; source import/probe/prepare/final save ordering; preparation/save failure preservation; stale new/open/prepare completion rejection; project switch cancels active render and disposes listeners; reopen reconstructs history at `currentRevisionId`; all existing render identity/collision/cancellation tests.
- Rust smoke: `video_save_project` reaches the production-shaped mock handler and rejects malformed/ungranted input with a typed error.

Run:

```text
pnpm --dir packages/video-contracts exec vitest run src/project-io.test.ts src/contracts.test.ts
pnpm --dir apps/desktop exec vitest run src/video-ipc.test.ts src/use-video-project.test.tsx
pnpm --filter @supa-video/contracts build
pnpm --filter @supa-video/desktop build
pnpm --filter @supa-video/desktop check
cargo test --locked --features tauri-ipc-test --manifest-path apps/desktop/src-tauri/Cargo.toml tests::video_project_commands_are_reachable_over_mock_ipc -- --exact
pnpm lint
pnpm format:check
```

### Stop condition

Stop before UI work unless every native project payload is strictly validated, cancellations are no-ops, stale completions cannot replace newer state, all project mutations activate only after successful save, a failed save preserves the exact prior revision/history, open distinguishes resolved/missing/relink-required media, and all existing preparation/render controller tests remain green.

## Checkpoint 2 — Editing UI (Step 14)

### Files and components

- Refactor `apps/desktop/src/App.tsx` into orchestration only while preserving existing readiness/source/export behavior and safe error copy.
- Add under `apps/desktop/src/video/`: `VideoWorkspace.tsx`, `VideoProjectOpener.tsx`, `AssetPanel.tsx`, `ProgramMonitor.tsx`, `SingleClipTimeline.tsx`, `TrimInspector.tsx`, `ExportPanel.tsx`, `format-video.ts`, and focused component/hook tests. Add `use-monitor-playback.ts` only if media-frame scheduling cannot remain local to `ProgramMonitor`.
- Extend `apps/desktop/src/App.css`; do not introduce another theme, icon package, CSS framework, or duplicated button/status system.
- Extend `use-video-project.ts` with draft trim, apply/save, bounded edit undo/redo, source selection, project switching guards, and final-preview selection while retaining the verified render flow.

### Required behavior

- No-project opener with New/Open and tool readiness; active top bar shows project name, source status, New/Open, and save/retry state without exposing arbitrary private paths.
- Honest asset metadata/status, prepared proxy playback, media failure fallback, thumbnail-backed one-track timeline, frame playhead, range handles, numeric frame fields, validation, Apply Trim, persisted Undo/Redo, and disabled/pending states.
- Responsive composition: `>=1100px` workbench columns with timeline below; `760–1099px` monitor-led two-column layout; `<760px` one task-ordered column; no horizontal page scroll at 480×360 or 320 CSS px.
- Existing export states extracted intact; overwrite uses native dialog; verified output report includes duration, dimensions, codecs, file size, destination, and controlled final-preview playback.

### Focused tests

- `ProgramMonitor`: cache URL conversion only, no source/final path conversion, play starts at trim-in, stop/clamp at trim-out, one/ten-frame seek, media error recovery, final-preview switch.
- Timeline/inspector: draft changes do not alter `currentRevisionId`; invalid/unchanged range cannot apply; Apply emits one `TrimClip`; save pending disables duplicates; save failure preserves committed revision and draft; success activates one revision; Undo/Redo persist before activation and cannot cross the clip baseline; undo plus new trim truncates redo.
- Workspace: new/open/source/preparation states, missing/relink source, source retry, project switch cleanup, shortcuts ignored in editable/native controls, long names/paths wrap without entering persisted cache state.
- Export: all existing progress/stale/cancel/failure/preview-warning/collision tests remain; dialog cancel/confirm/focus-return paths are added.

Run:

```text
pnpm --dir apps/desktop exec vitest run src/use-video-project.test.tsx src/video src/App.test.tsx
pnpm --filter @supa-video/desktop build
pnpm --filter @supa-video/desktop check
pnpm lint
pnpm format:check
```

### Stop condition

Stop before broad integration work unless the complete mocked create/open/import/prepare/play/draft/apply/undo/redo/export path works, only controlled cache media reaches the WebView, one Apply creates exactly one saved revision, failed saves never advance canonical state, undo cannot remove Phase 1 setup revisions, keyboard and non-drag controls can perform every edit, the existing render regression suite remains unchanged in meaning, and the layout remains semantically ordered at every breakpoint.

## Checkpoint 3 — Integration and accessibility coverage (Step 15)

### Coverage additions

- Add exact dev dependency `axe-core@4.12.1` to `apps/desktop/package.json` and the lockfile; call `axe.run` locally in jsdom for rendered WCAG A/AA/WCAG 2.2-tagged violations. Treat it as defect detection, not conformance proof.
- Add `apps/desktop/src/video/workflow.integration.test.tsx` for the full mocked product flow and `accessibility.test.tsx` for opener, ready editor, blocking error, running export, and open overwrite dialog states.
- Keep lower-level IPC/controller/component tests; integration tests prove composition rather than replacing unit coverage.

### Exact matrix

- Primary flow: readiness → New → save empty project → choose/probe/prepare source → save clip project → play/seek → draft trim → Apply/save → Undo/save → Redo/save → export/progress/success → final preview → reopen same document and reproduce trim.
- Recovery: picker cancellation, malformed project, missing source, relink required, missing FFmpeg, probe/preparation failure, save failure with preserved revision, invalid trim, media load failure, output collision cancel/confirm, cancellation failure/retry, render failure/retry, export cancellation, success, and preview failure after saved output.
- Accessibility: landmarks/headings/native controls; persistent labels/units/descriptions/errors; accessible names; live status versus blocking alert; semantic progress; DOM/tab order; visible keyboard focus; dialog initial focus/Escape/focus return; no drag-only action; editable shortcut suppression; 24px minimum targets and 44px primary controls; color-independent state text; no raw private diagnostics.
- Content stress: 200% text assumptions in component geometry, 320px DOM order, long German-like labels, long unbroken paths, missing thumbnail, RTL logical properties, no-hover/coarse-pointer CSS, reduced motion, and forced colors. Real rendered verification remains Checkpoint 5.

Run:

```text
pnpm --dir apps/desktop exec vitest run src/video-ipc.test.ts src/use-video-project.test.tsx src/video src/App.test.tsx
pnpm --filter @supa-video/desktop test
pnpm --filter @supa-video/desktop check
pnpm --filter @supa-video/desktop build
pnpm lint
pnpm format:check
```

### Stop condition

Stop before final gates unless every required state has an explicit assertion and recovery path, the keyboard-only mocked flow reaches verified export, dialog focus behavior passes, axe reports zero applicable violations in every rendered state, no test suppresses a violation without a documented false-positive reason, all baseline tests still pass, and manual-only contrast/reflow/pointer-focus claims remain labeled unverified rather than inferred from source.

## Checkpoint 4 — Gates, Step 16 regression, and documentation (Steps 16–17)

### Gate hygiene and docs

- Do not add or redesign native FFmpeg integrations. Rerun the existing eight ignored tests as Step 16 regression proof.
- Remove obsolete `--passWithNoTests` from packages that now contain tests; scope `packages/video-render` to `src` so compiled `dist` tests are not double-counted.
- Remove the stale desktop-test warning from `.github/workflows/ci.yml`; retain Linux/Windows Rust and Tauri build gates.
- Create `apps/desktop/DESIGN.md` with the design read, thesis, token/component reuse map, state model, keyboard/media behavior, responsive rules, support matrix, production-contract checklist, and an evidence table. Mark Checkpoint 5 runtime/visual items as explicitly pending.
- Update `README.md` and `ROADMAP.md` with final source-test counts, Steps 13–17 status, Step 16’s already-complete evidence, latest CI status, remaining Step 18 proof, and no claim that Phase 1 is complete yet.

### Exact local gate

```text
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm lint
pnpm format:check
cargo fmt --all --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --features tauri-ipc-test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored --nocapture
cargo tree --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -e features -i tauri
pnpm --dir apps/desktop tauri build --no-bundle --ci
git diff --check
```

Inspect the Cargo tree and require `tauri/protocol-asset` and `http-range` in the default production feature graph. Re-run the timeout/cancellation repetition from the separate reliability preflight after the full gate. When a final commit/push is authorized, require a successful CI run for that exact SHA; otherwise record remote clean-checkout proof as pending.

### Stop condition

Stop before real Windows proof if any local gate, any of the eight real-FFmpeg integrations, the repeated process-tree tests, asset-protocol feature inspection, production executable assembly, or exact-SHA CI run fails. Documentation must report final measured counts and clearly leave Step 18/Phase 1 incomplete; no “all complete” wording is allowed yet.

## Checkpoint 5 — Real Windows proof (Step 18)

### Environment and evidence location

- Use a clean final checkout on Windows with the documented Node/pnpm/Rust/MSVC/WebView2 prerequisites and system `ffmpeg`/`ffprobe`; record exact versions and final commit SHA.
- Use a neutral evidence path that contains no username or private media, and self-generated/canonical fixtures only.
- Commit sanitized proof under `apps/desktop/evidence/phase-1/`: viewport screenshots plus `verification.md` containing commands, probe results, hashes, state/accessibility matrix, process/partial checks, first/final rubric scores, and any honestly unverified item.

### Real workflow proof

1. Launch the real Tauri executable, verify no-project/tool states, create a project through the native picker, select the canonical fixture through the product, and wait for validated proxy/thumbnail preparation.
2. Play, pause, seek by one/ten frames, move both trim handles, enter exact numeric frames, Apply one trim, Undo, Redo, and verify keyboard-only completion outside editable controls.
3. Export a known trim such as fixture frames `[5, 50)` at 30 fps. Use ffprobe only as external proof: require H.264/yuv420p video, 320×180, 30/1 CFR, AAC/48 kHz audio, nonzero size, and duration 1.5 seconds within one output frame.
4. Pre-create the selected output to prove collision dialog cancel and explicit replacement. Verify focus enters the dialog, Escape/cancel returns focus, and overwrite preserves the same immutable plan/revision.
5. Use a temporary self-generated long 320×180 AV source with a unique output stem to make cancellation observable. Cancel through the UI; require no final output, no `.svp-part-*`, and no surviving `ffmpeg.exe` whose command line contains that unique stem.
6. Close and reopen the saved `.svpvideo` through the product. Require the persisted current revision/range, prepared playback, redo state, and reproduced export duration; play the verified final cache preview.

### Failure/state proof

Exercise and record no-project, loading, missing FFmpeg (launch with a process-local PATH excluding tools), malformed project, missing relative source using a disposable fixture copy, preparation failure, controlled save failure using a disposable project held exclusively then released, invalid trim, missing thumbnail/media error, collision, running, cancelling, cancelled, render failure/retry, success, and preview-failure-after-save using a controlled disposable cache-permission scenario. Restore every temporary permission/lock immediately; never alter the canonical fixture or user media.

### Visual and accessibility evidence

- Capture the real app at 1280×800, 1920×1080, 480×360, and a 320 CSS-pixel reflow/devtools view, plus representative missing-source, collision-dialog, running-export, and success states.
- Verify no horizontal page scroll, no clipped primary action, aligned shared rails, long path/name wrapping, 200% text, long German-like copy, RTL/logical layout, no-hover/coarse-pointer behavior, missing media, reduced motion, and Windows forced colors/high contrast.
- Complete the primary path by keyboard; verify visible/unobscured focus, native picker/dialog focus return, no sticky pointer focus after mouse activation/dismissal, accessible names/status announcements, and non-drag trim alternatives. Run the project axe tests and a Windows accessibility scanner/manual UIA semantics review.
- Perform one evidence-led critique: score all 12 rubric criteria from captures, run the production-contract checklist, remove one unnecessary decorative idea, fix the weakest criterion and every contract failure, recapture, and require at least 20/24 with no zero in accessibility, consistency/flow, responsive behavior, state completeness, or content authenticity.

### Final stop condition

Phase 1 remains incomplete unless the clean checkout launches, the real create/open/prepare/play/trim/undo/redo/export/cancel/reopen paths all pass, cancellation leaves no matching process/partial, ffprobe duration is within one frame, every required viewport/accessibility/state result is recorded, the final rubric gate passes, final exact-SHA CI is green, and `README.md`/`ROADMAP.md`/`DESIGN.md` are updated with the proof. Any failed or unavailable check is recorded as failed/unverified and blocks the Phase 1 completion claim.

## Risks

- **Persistence race:** operation tokens must reject stale picker/probe/prepare/save completions after project switches.
- **Unsaved authority:** never update active history before atomic save succeeds; cache artifacts are reusable derivations, not project authority.
- **Undo scope:** raw history can undo setup revisions; enforce the first-clip edit baseline in the controller/UI.
- **Media leakage:** only cache paths may be converted to asset URLs; source and final export paths remain outside protocol scope.
- **Playback precision:** presentation seconds are not authoritative. Derive them from exact frames and clamp native media events to the draft half-open range.
- **Render regression:** controller refactoring must preserve listener-before-start ordering, identity filtering, immutable plan reuse, and unmount/project-switch cancellation.
- **Responsive density:** the current 880px card rail is insufficient for a monitor/timeline workbench; expand through shared tokens/key lines without creating unrelated card systems.
- **False accessibility confidence:** jsdom/axe cannot prove contrast, layout, pointer focus, media controls, forced colors, or native picker behavior; Checkpoint 5 remains mandatory.
- **Evidence privacy:** screenshots and logs must use neutral paths and self-generated media, with no usernames, raw stderr, or private filesystem details.

## Steps

1. Stabilize the existing timeout/cancellation descendant regression in `apps/desktop/src-tauri/src/video/tests.rs` without changing production process semantics, then satisfy the targeted repetition, full-suite repetition, and cross-platform CI stop conditions.
2. Add strict shared TypeScript opened-project/source-status contracts in `packages/video-contracts/src/project-io.ts`, export them, and add malformed/parity coverage.
3. Extend `apps/desktop/src/video-ipc.ts` with exact new/open/save adapters plus the injectable `VideoBackend`/`tauriVideoBackend`, and lock command arguments, cancellation, response validation, and error normalization in adapter tests.
4. Refactor `apps/desktop/src/use-video-project.ts` around active path/history/source state and implement stale-safe new/open/source preparation/save transactions that activate only after atomic save succeeds while preserving all render behavior.
5. Add focused controller and mock-Tauri reachability tests, run the Checkpoint 1 commands, and stop until every persistence invariant and existing render regression passes.
6. Build the active `VideoWorkspace`, opener, asset panel, controlled program monitor, semantic single-clip timeline, trim inspector, persisted edit undo/redo, extracted export panel, native collision dialog, shortcuts, formatting, and adaptive layout by extending the existing Geist/Lucide/token system.
7. Add focused monitor/timeline/trim/workspace/export tests, run the Checkpoint 2 commands, and stop until the complete mocked editing path, cache-only playback boundary, save-before-activation rule, and responsive semantic order pass.
8. Add `axe-core@4.12.1`, full workflow integration tests, accessibility/state/focus/keyboard coverage, and content-stress cases; run the Checkpoint 3 commands and stop on any uncovered state, violation, or baseline regression.
9. Clean test/CI gate drift, rerun the existing eight Step 16 FFmpeg integrations unchanged, execute every Checkpoint 4 local gate plus process-tree repetition and feature inspection, and require final exact-SHA CI when authorized.
10. Create `apps/desktop/DESIGN.md` and update `README.md`/`ROADMAP.md` with measured final counts, corrected CI evidence, Steps 13–17 status, Step 16’s early completion, and Step 18 still explicitly pending.
11. From a clean Windows checkout, execute and record the real create/open/prepare/play/trim/undo/redo/collision/cancel/export/reopen flow, ffprobe/process/partial proof, failure-state matrix, viewport captures, keyboard/manual accessibility checks, and initial rubric/production-contract review under `apps/desktop/evidence/phase-1/`.
12. Remove one unnecessary decorative idea, fix the weakest rubric criterion and every production-contract failure, recapture/reverify affected evidence, rerun final local and exact-SHA CI gates, and only then mark Step 18 and Phase 1 complete in `ROADMAP.md`, `README.md`, and `DESIGN.md`.
