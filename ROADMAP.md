# Supa Video Producer Roadmap

- **Status:** Active implementation; Phases 1–3 are complete, Phase 4 foundations remain open, and Phase 5 transcript/caption foundations are partially implemented
- **Research baseline:** 24 July 2026
- **Implementation audit:** 9 August 2026 (Phase 5 trim-, split-, standalone MoveClip-, standalone RippleDeleteClip-caption lifecycle, exact-key managed transcript read-boundary, and automatic managed-transcript resolution slices verified and closed; broader Phase 4 and Phase 5 scope remains open)
- **Product and implementation root:** `E:\Projects\supa-video-produzah`
- **Product:** A standalone, agent-native video producer with its own desktop shell, UI, timeline, project model, preview, asset library, render pipeline, quality control, and export system
- **Explicit exclusions:** No dependency on another application repository, Resolve, Premiere, CapCut, or generated-video services such as Veo, Kling, or Runway

---

## Architecture decision

Bootstrap a standalone **pnpm workspace** in this repository with a dedicated **Tauri v2 + React 19** desktop application, browser-safe TypeScript domain packages, and a Rust-owned native media boundary. Phase 1 uses system `ffmpeg` and `ffprobe` discovered on `PATH`; Phase 3 owns binary bundling and records the distribution-review gate, while legal approval is deferred until public distribution. Agent/model infrastructure is deferred until Phase 6 and, when added, is implemented as product-owned packages rather than imported from another product.

```text
Supa Video Producer workspace
  ├── apps/desktop
  │     ├── React 19 studio UI
  │     └── Tauri v2 Rust shell and secure IPC
  ├── packages/video-contracts
  │     └── project, command, event, and render schemas
  ├── packages/video-project
  │     └── rational-time commands, revisions, and history
  ├── packages/video-render
  │     └── deterministic FFmpeg render-plan compiler
  ├── future product-owned media/rights/QC/agent packages
  └── future crates/video-preview
        └── retained Rust/wgpu compositor when measurements justify it
```

### Repository bootstrap and module boundaries

Every path below is relative to `E:\Projects\supa-video-produzah`. This repository is the only source tree, package workspace, build root, and write target.

| Module | Responsibility |
|---|---|
| `apps/desktop/` | Tauri lifecycle, application windows, React studio UI, secure IPC, native project/media/render commands |
| `packages/video-contracts/` | Shared schemas for project state, commands, events, jobs, proposals, rights, and render plans |
| `packages/video-project/` | Canonical deterministic project commands, immutable revisions, and undo/redo |
| `packages/video-render/` | Typed render-plan compiler; no process spawning or path access |
| `packages/video-media/` | Phase 3 ingest, probing, proxy, waveform, thumbnail, transcription, and cache abstractions |
| `packages/video-rights/` | Phase 7 stock adapters, license normalization, snapshots, attribution, and release policy |
| `packages/video-qc/` | Phase 10 technical, editorial, rights, and encoded-master checks |
| `packages/model-gateway/` | Future provider transport owned by this product; absent from Phase 1 |
| `packages/agent-runtime/` | Future typed proposal/approval loop owned by this product; absent from Phase 1 |
| `packages/media-tools/` | Future reusable transcription/audio/caption analysis; no external-NLE control |
| `crates/video-preview/` | Later Rust/wgpu retained preview compositor |

The bootstrap creates root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, strict `tsconfig.json`, ESLint/Prettier configuration, and `apps/desktop/` from an official current Tauri v2 React TypeScript template. All dependency versions and generated Tauri configuration must be verified against current authoritative sources during implementation.

### Rules that apply to every phase

1. UI and future agents use the same validated command/query boundary
2. Models never mutate project JSON directly and never emit executable FFmpeg shell strings
3. Committed project state uses rational frame/sample time; floating-point seconds are presentation values only
4. Final renders consume immutable project revisions
5. Media blobs, decoder handles, GPU textures, and cache objects are never authoritative project state
6. Destructive, expensive, publishing, and rights-sensitive actions are policy-gated
7. Every package and native module is created and built inside this repository
8. Copyleft and source-available references are pattern references only unless a separate license decision authorizes code reuse

---

# Phase 1 — Standalone single-clip vertical slice

**Depends on:** A clean checkout of this repository, Node 22, pnpm 10, the Rust/Tauri prerequisites, and local FFmpeg availability during development  
**Goal:** Bootstrap the product and prove the thinnest complete path from local media to an edited exported file through its own UI

## Implementation checkpoint - re-audited and verified 25 July 2026

Phase 1 is complete and the hard completion gate passes at HEAD `1228855703f62c83739131f56088ee59896537b6`. Steps 1 through 18 are implemented and verified; targeted Windows Step 18 proof was rerun after the playback, source-recovery, and draft-guard changes. Phase 2 is now unblocked.

| Implementation item | State | Audit evidence |
|---|---|---|
| Workspace and desktop scaffold | Complete | The root pnpm workspace, Tauri v2/React 19 shell, strict TypeScript, lint, formatting, and package boundaries build successfully. The desktop package builds all transitive workspace dependencies before its frontend. |
| Browser-safe contracts and rational time | Complete | Strict V1 project, opened-project/source-status, command, render, and event schemas reject unknown or mismatched native data. Rational-time rounding and strict migrations remain covered. |
| Project command engine and history | Complete | `ImportAsset`, `CreateSequence`, `InsertClip`, and `TrimClip`, immutable revisions, stale-base checks, bounded undo/redo, and branch truncation are implemented. |
| Deterministic render-plan compiler | Complete | Immutable revisions compile to validated FFmpeg argv arrays for AV and video-only inputs without filesystem or process access. |
| Deterministic fixture bundle | Complete | `single-clip.mp4`, `single-clip.svpvideo`, provenance, probe facts, and SHA-256 evidence remain tracked. |
| Rust project boundary | Complete | Strict mirrored V1 DTOs, owner-window grants, native picker commands, bounded open, contained locator resolution, and crash-safe atomic save are implemented and tested through production-shaped IPC. |
| Native FFmpeg discovery, supervision, probe, and controlled preparation | Complete | Bounded no-shell execution through Unix process groups or Windows Job Objects, validated probing, cache-contained proxy/thumbnail generation, reuse/repair, redacted errors, and lifecycle cleanup pass portable and real-FFmpeg tests. |
| Render jobs, export, runtime registration, and security | Complete | Steps 11 and 12 are committed on `main`/`origin/main`: strict render validation, owner jobs/events, cancellation, collision handling, verified outputs/previews, explicit CSP/capability policy, and cache-only asset protocol are production-registered. |
| Persistence controller | Complete | Strict frontend adapters and an injected backend implement stale-safe New/Open/Save, source status, history reconstruction, and save-before-activation transactions. Cancellation and failed save preserve the prior canonical project. |
| React editing workflow | Complete | The workbench includes the opener, active project bar, controlled proxy monitor, one-track thumbnail timeline, frame playhead, numeric/range trim controls, persisted Apply/Undo/Redo, frame shortcuts, native overwrite dialog, output facts, and controlled final-preview playback. |
| Integration and accessibility coverage | Complete | The full mocked create/import/play/trim/undo/redo/export/reopen workflow passes. Axe Core 4.12.1 reports zero applicable WCAG A/AA/2.2-tagged violations in opener, ready editor, blocking error, running export, and collision dialog states. |
| Gates and documentation | Complete | Empty-test allowances and duplicate `dist` render discovery are removed, the obsolete CI warning is removed, `DESIGN.md` records the production contract, and every local TypeScript/Rust/Tauri/FFmpeg gate passes. |
| Real Windows runtime and visual proof | Complete | The production executable completed native create/open/prepare/play, exact `[5, 50)` trim, Undo/Redo, export/reopen, controlled final preview, exact 1.5-second ffprobe proof, missing-source and relink-required recovery, source regrant, and unsaved-draft discard guarding on current HEAD. Earlier unchanged proof covers collision cancel/replace, real long-render cancellation with zero process/partial/output residue, 320px/200% reflow, and accessibility review. |

### Next implementation item

Begin Phase 2 planning from the completed Phase 1 baseline.

### Latest verification evidence

- The local worktree passes frozen install; root build, check, test, lint, and format; Rust formatting; all-target/all-feature Clippy with warnings denied; default and `tauri-ipc-test` suites; all eight unchanged real-FFmpeg integrations; asset-protocol feature inspection; `git diff --check`; and `pnpm --dir apps/desktop tauri build --no-bundle --ci`.
- The source contains 159 unique passing TypeScript tests: 40 contract/time/project-I/O/derived-media/render-event tests, 5 project/history tests, 9 render-compiler tests, and 105 desktop IPC/controller/component/integration/accessibility tests.
- The Rust crate passes 63 default-feature tests (61 portable unit tests plus 2 security-configuration tests). With `tauri-ipc-test`, 69 tests pass (67 portable unit/IPC/lifecycle tests plus 2 configuration tests).
- All eight explicit system-FFmpeg integrations pass with FFmpeg/FFprobe 8.1.2. They cover source probing over IPC, preparation/reuse/repair, display geometry, HDR tone mapping, AV/video-only export, collision preservation, and cancellation/process/partial cleanup.
- The process-tree timeout and cancellation proofs each passed 20 consecutive targeted repetitions before feature work and another 20 after the full Phase 1 gate. The complete `tauri-ipc-test` suite passed 10 consecutive Windows repetitions in both runs.
- The locked Cargo feature tree includes `tauri/protocol-asset` and `http-range` in the default production graph. The no-bundle release build produced `apps/desktop/src-tauri/target/release/supa-video-desktop.exe`.
- Exact-SHA GitHub Actions run [`30189534426`](https://github.com/creativeprofit22/supa-video-produzah/actions/runs/30189534426) passed TypeScript/Linux Rust/Windows MSVC and Tauri assembly for HEAD `1228855703f62c83739131f56088ee59896537b6`.
- Sanitized runtime proof under `apps/desktop/evidence/phase-1/` now includes current-HEAD create/import/play, draft discard, `[5, 50)` Apply/Undo/Redo, export/reopen, ffprobe/hash facts, missing-source/relink/source-regrant recovery, plus the earlier unchanged cancellation, responsive, and accessibility evidence.

### Audit notes

- Steps 11 and 12 are committed baseline work, not uncommitted worktree-only changes.
- Step 16 was completed early and has been rerun unchanged after Steps 13 through 15.
- The master `.gg/plans/video-phase-01-single-clip.md` is historical planning context; implementation has progressed beyond its initial-state wording.
- Axe/jsdom evidence is paired with real Windows picker/WebView/media/dialog/reflow/focus/cancellation proof; the raw PowerShell UIA walker exposed only the WebView document root, so no unsupported child-tree claim is made.
- The Phase 1 hard completion gate passes.

## Scope

- Bootstrap the root pnpm workspace and a standalone `apps/desktop/` Tauri v2 + React 19 application
- Create/open a minimal `.svpvideo` project containing one local video asset and one video track
- Probe the source with ffprobe
- Generate one controlled edit proxy and one thumbnail strip
- Display the proxy in a program monitor
- Display one timeline clip with a playhead and trim-in/trim-out controls
- Commit one typed `TrimClip` operation
- Compile the immutable project revision into one FFmpeg export plan
- Export H.264/AAC MP4 to a user-selected location
- Probe the finished output and show duration, resolution, codec, file size, and success/failure

## Non-goals

- Multiple clips or tracks
- Ripple editing, transitions, captions, stock footage, agents, collaboration, cloud rendering
- Model-provider or agent-runtime integration
- Native wgpu preview
- Arbitrary source-codec playback in the WebView
- Frame-perfect parity beyond a single trim
- Production installer licensing approval

## Affected modules

- New root workspace/build/lint/test configuration
- New `apps/desktop/src/` studio shell and single-clip editor
- New `apps/desktop/src-tauri/src/video/` native media/project/render boundary
- New `packages/video-contracts/`
- New `packages/video-project/`
- New `packages/video-render/`

## Deliverables

- Launchable standalone Tauri desktop shell with one Video Project opener
- Versioned minimal `VideoProject` schema and `.svpvideo` save/load format
- Rational timeline time type and explicit rounding policy
- `ImportAsset`, `CreateSequence`, `InsertClip`, and `TrimClip` commands
- Immutable `ProjectRevision`
- Typed `RenderPlan` containing argv arrays, never shell strings
- FFmpeg progress events and cancellable render job
- React surfaces: project opener, asset row, monitor, one-track timeline, trim inspector, export panel
- A checked-in deterministic fixture project using self-generated test media

## Tests

- Workspace package build/check/test smoke gates from a clean checkout
- Schema validation and migration version tests
- Rational-time conversion tests for 24, 25, 30, 30000/1001, and 60000/1001 rates
- Command tests proving trim bounds, invalid range rejection, and unchanged asset identity
- Render-plan snapshot test with normalized paths
- FFprobe parser tests
- Path grant, atomic save, process cancellation, and non-zero exit tests
- Output integration test asserting duration within one output frame, expected dimensions, playable audio/video streams, and no temporary output left behind
- React flow, state, keyboard, and accessible-name tests

## Runtime and visual verification

- Launch the real standalone Tauri application on Windows
- Import the fixture MP4, drag both trim handles, seek, play, export, and open the output in the product monitor
- Close and reopen the `.svpvideo` project and reproduce the duration
- Capture screenshots at 1280×800, 1920×1080, and the 480×360 minimum
- Verify keyboard access to import, play/pause, seek, trim fields, undo/redo, and export
- Verify loading, no-project, missing-file, missing-FFmpeg, save failure, cancellation, success, preview failure, and output-collision states
- Compare displayed project duration with ffprobe output

## Risks

- Bootstrap and media implementation can blur unless the package/native boundaries are created first
- WebView source playback may differ from FFmpeg decoding
- VFR inputs can expose ambiguous frame boundaries
- Expanding Phase 1 into a full editor before the project/command boundary is stable
- FFmpeg binary discovery and distribution licensing are not yet production-ready
- UI timeline may accidentally become authoritative state

## Hard completion gate

Phase 1 is complete only when a clean checkout of this repository can install and build its own workspace, launch its own Tauri app, create/open the fixture project, trim through the product UI, export a validated MP4, cancel safely without surviving processes or partial output, reopen the project, and reproduce output duration within one frame without another source repository, external NLE, browser upload, generated-video service, or manual command-line editing.

## Proven References

### FreeCut — immutable render input and shared composition semantics

- Repository: [walterlow/freecut](https://github.com/walterlow/freecut)
- Files: [`src/features/export/utils/client-render-engine.ts`](https://github.com/walterlow/freecut/blob/main/src/features/export/utils/client-render-engine.ts), [`src/features/export/hooks/use-render-queue-persistence.ts`](https://github.com/walterlow/freecut/blob/main/src/features/export/hooks/use-render-queue-persistence.ts)
- Transferable adaptation:

```text
snapshot = freeze(project.revision)
job = { snapshotId, outputProfile, state: "queued" }
render(snapshot)
```

The transferable pattern is rendering from an immutable revision rather than live UI state. **License:** MIT; copied portions require preservation of the copyright and permission notice.

### FFmpeg — media substrate and progress boundary

- Repository: [FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg)
- Files: [`fftools/ffmpeg_filter.c`](https://github.com/FFmpeg/FFmpeg/blob/master/fftools/ffmpeg_filter.c), [`fftools/ffmpeg_sched.c`](https://github.com/FFmpeg/FFmpeg/blob/master/fftools/ffmpeg_sched.c)
- Transferable adaptation:

```text
project revision → validated inputs → filter/output plan → supervised process
```

Use argument arrays and parsed `-progress pipe:1`; do not concatenate user/model strings. **License:** FFmpeg can be LGPL or GPL depending on build options and linked components; public distribution of the exact bundled build requires a dedicated GPL/source-offer and codec-patent review.

### OpenTimelineIO — rational time concepts

- Repository: [AcademySoftwareFoundation/OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO)
- Files: [`src/opentimelineio/rationalTime.h`](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/main/src/opentimelineio/rationalTime.h), [`src/opentimelineio/timeline.h`](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/main/src/opentimelineio/timeline.h)
- Transferable adaptation:

```text
TimelineTime = { value: integer, rateNumerator: integer, rateDenominator: integer }
```

Use OTIO as an interchange and semantic reference, not the internal executable renderer. **License:** Apache-2.0; preserve license and NOTICE obligations when reusing code.

---

# Phase 2 — Canonical project engine and recoverable command history

**Depends on:** Phase 1

## Implementation checkpoint - re-audited and verified 26 July 2026

Phase 2 is complete at HEAD `7ad26432e6ffa36e63f1fc85349345179c31fd72`, built on baseline `a0a636995a453789b46640512aa9bccb4ed89c31`; Phase 3 is unblocked.

- Rust owns strict V2 state transitions, semantic inverses, monotonic commit/undo/redo revisions, hashes, journal durability, snapshots, recovery, locks, migration, and owner sessions.
- TypeScript owns strict V2 IPC contracts, authority-free command builders, projection selectors, and the unchanged pure render-plan compiler.
- Acknowledgment follows journal append, flush, and `sync_all`; snapshots checkpoint every 25 operations and on clean close.
- Recovery validates snapshot state hashes, journal generation/record chains, deterministic replay output, and repaired valid prefixes. Torn tails recover with a report; verified-record loss reports degraded status.
- V1 migration preserves the selected state and stable entity IDs while recording one irreversible history-reset boundary.
- The production single-clip UI uses grouped native import, trim, monotonic undo/redo, V2 export, native relink, a degraded-recovery alert, and a hidden responsive inspector.
- Current release measurements are 4.57 ms p95 durable acknowledgment and 706 ms for a generated 10,000-record journal scan, below the 100 ms and 2 second gates.
- Local verification passes 122 TypeScript tests, 100 all-feature Rust tests, all eight explicit real-FFmpeg integrations, Clippy with warnings denied, and Windows Tauri production assembly.
- Exact-SHA GitHub Actions run [`30211851450`](https://github.com/creativeprofit22/supa-video-produzah/actions/runs/30211851450) passes TypeScript, Linux Rust performance/recovery, repeated Windows lock/recovery, and Windows Tauri assembly.

### Phase 3 handoff

The pinned FFmpeg/ffprobe distribution baseline is complete. Phase 3 can now use the stable toolchain ID and verified capability contract for content-addressed ingest, deterministic derived-media keys, and durable jobs.

### Storage portability

A portable project is the `.svpvideo` snapshot plus its sibling `.svpvideo.data/` directory. The sidecar journal is authoritative persistent data, not cache. Phase 2 deliberately keeps the complete hash chain; compaction requires a future anchored rotation protocol.

## Scope

- Move authoritative project mutation behind a Rust-owned or process-isolated project service
- Expand the schema to tracks, clips, source ranges, edited ranges, markers, captions, transforms, and nested sequences without implementing every UI
- Add monotonic revisions and optimistic base-revision checks
- Add semantic command groups, inverses, undo/redo, and transaction rollback
- Append commands to `journal.ndjson`
- Periodically write atomic project snapshots
- Recover from the latest valid snapshot plus journal after a simulated crash
- Separate persistent project data, derived/cache records, and runtime-only handles

## Non-goals

- Professional timeline interaction
- Stock acquisition or agent proposals
- Complex compositing
- Collaboration or multi-writer CRDTs

## Affected modules

- `packages/video-contracts/`
- `packages/video-project/`
- `apps/desktop/src-tauri/src/` project gateway
- `apps/desktop/src/` project-state projection only

## Deliverables

- Canonical versioned project schema
- Command registry with preconditions, affected ranges, summary, inverse, and cache invalidations
- `ProjectRevision`, `CommandGroup`, `CommandResult`, and `ProjectEvent`
- Atomic snapshot writer, journal writer, journal replay, migrations, recovery report
- Commands: split, move, trim, insert, remove, set transform, set gain, add marker
- Project integrity validator

## Tests

- Property tests for split/trim/move invariants
- Transaction all-or-nothing tests
- Stale-base rejection tests
- Undo/redo round-trip tests
- Crash injection between journal append, command application, and snapshot rename
- Migration fixtures from every schema version
- Path relinking and missing-asset tests
- Fuzz malformed command payloads and corrupted journal tails

## Runtime and visual verification

- Hidden developer inspector showing revision, last command, journal health, and recovery status
- Execute edits, kill the project service during an edit, reopen, and verify exact recovery
- Verify UI selection and viewport remain ephemeral across project command replay

## Risks

- Treating Immer/JSON patches as the public domain command language
- Overly broad commands that cannot be reviewed or inverted
- Project files containing absolute machine-specific paths only
- Acknowledging a command before durable recording

## Hard completion gate

**Passed.** Every supported command is deterministic, schema-validated, revision-checked, undoable or explicitly irreversible, crash-recoverable, and produces the same project hash after replay from the same base snapshot.

## Proven References

### Kdenlive — transactional timeline mutations

- Repository: [KDE/kdenlive](https://github.com/KDE/kdenlive)
- Files: [`src/timeline2/model/timelinemodel.cpp`](https://github.com/KDE/kdenlive/blob/master/src/timeline2/model/timelinemodel.cpp), [`src/assets/keyframes/model/keyframemodel.cpp`](https://github.com/KDE/kdenlive/blob/master/src/assets/keyframes/model/keyframemodel.cpp)
- Pseudocode adaptation:

```text
redo = apply(command)
undo = restore(previous domain values)
push(label, redo, undo)
```

The relevant pattern is composed semantic undo/redo functions around model invariants. **License:** GPL-3.0-or-later; use as an architecture reference only unless the product license becomes GPL-compatible.

### OpenReelio — command executor and project-safe imports

- Repository: [openreelio/openreelio](https://github.com/openreelio/openreelio)
- Files: [`src-tauri/src/core/commands`](https://github.com/openreelio/openreelio/tree/main/src-tauri/src/core/commands), [`src-tauri/src/ipc/commands/agent.rs`](https://github.com/openreelio/openreelio/blob/main/src-tauri/src/ipc/commands/agent.rs)
- Pseudocode adaptation:

```text
lock project
verify activeProject == command.project
result = executor.execute(command, state)
return operationId + newRevision
```

The pattern prevents a staged operation from committing into a project that changed while work was in flight. **License:** MIT; preserve copyright and permission notice for reused code.

### Blender VSE — persistent, derived, and runtime data separation

- Repository: [blender/blender](https://github.com/blender/blender)
- Files: [`source/blender/makesdna/DNA_sequence_types.h`](https://github.com/blender/blender/blob/main/source/blender/makesdna/DNA_sequence_types.h), [`source/blender/sequencer/SEQ_render.hh`](https://github.com/blender/blender/blob/main/source/blender/sequencer/SEQ_render.hh)
- Adapted categories:

```text
Persistent: clips, tracks, effects, source references
Derived: proxies, waveforms, thumbnails
Runtime: decoders, GPU textures, file handles
```

**License:** GPL-3.0-or-later; pattern reference only for a non-GPL product.

---

# Phase 3 — Durable media ingest, proxies, caches, and jobs

**Depends on:** Phase 2

## Implementation checkpoint - re-audited 2 August 2026

Phase 3B implementation and verification are complete through the ordered local closure series, built on the Phase 2 engine, Phase 3A content-addressed ingest, and pinned Gyan FFmpeg 8.1.2 distribution baseline. Phase 4 is unblocked for private-use development.

The audited implementation includes strict TypeScript/Rust job contracts, SQLite job/event/cache state, hierarchical preparation jobs, durable final-render jobs, priority scheduling, retries, cancellation, restart recovery, cache leases and deterministic LRU eviction, explicit legacy-cache policy, production IPC/event reconciliation, and the app-level Job Center.

The 28 July closure worktree passes frozen install; root build/check/test/lint/format; 204 TypeScript/Vitest tests; 13 Chromium responsive/accessibility tests; Rustfmt; all-target/all-feature Clippy with warnings denied; 171 non-ignored Rust tests; all 11 explicit real-FFmpeg tests; staged FFmpeg verification; all three original stripped-`PATH` packaged gates; three Phase 3B bundled-resource wrappers; release performance tests; Windows no-bundle assembly; and `git diff --check`. Latest release measurements were: generated 10,000-record project journal scan `699.8438 ms`; durable command acknowledgment p95 `4.8993 ms`; media-job enqueue plus durable event p95 `11.5919 ms`; list 100 recent jobs `4.6878 ms`; recovery selection across 10,000 jobs `2.6108 ms`.

The packaged test service now uses each mock Tauri app's resolved local-data/cache roots and cleans both. Render cancellation uses the generated durable UUID while preserving the distinct `planId`. Composite `(updated_at_ms, id)` pagination is lossless across equal timestamps, and Job Center exposes pending, retry, no-more, loaded-depth refresh, focus, polite-status, and responsive states.

The literal assembled Windows gate now passes with stripped `PATH` and bundled FFmpeg: an interrupted long proxy recovered with stable parent/child IDs and one terminal event; ExportPanel and Job Center reconciled cancellation, native save-picker reauthorization, same-job retry, and completion; active leases survived deterministic test-budget LRU eviction; a cache miss regenerated without identity drift; and legacy inventory survived restart until visible confirmation. Independent checks found no final FFmpeg/FFprobe descendant or owned partial residue. Sanitized commands, IDs, hashes, probes, event counts, totals, and screenshots are recorded in `apps/desktop/evidence/phase-3/assembled-windows-runtime-closure.md`.

Exact-SHA Actions run [`30764490903`](https://github.com/creativeprofit22/supa-video-produzah/actions/runs/30764490903) passed at HEAD `dbcb519eb2f562834d7ea7086219f87f5d7fbf2f`: the TypeScript, Rust, and Windows jobs all executed successfully. The signed-installer job was correctly skipped because this was a push rather than a published release.

Public distribution review remains explicitly pending for GPL/source-offer and codec-patent obligations. The project is private-use-only at this checkpoint; legal approval is deferred until public distribution and does not block Phase 4.

### Next implementation item

Begin **Phase 4 functional multitrack editing UI** without starting public release work.

## Implemented Phase 3B deliverables

- Persistent hierarchical `MediaJob` and atomic `MediaJobEvent` records for preparation, proxy, thumbnail, and final render work
- Bounded priority scheduler with deterministic FIFO aging, cancellation, automatic/manual retry, and restart recovery
- Explicit blocked recovery when fresh source or output authorization is required
- Persistent cache catalog with a 20 GiB default budget, current-session leases, deterministic unleased LRU eviction, stale-build cleanup, and cache-miss regeneration
- Explicit legacy `$APPCACHE/video-phase1` inventory and confirmed clear action; no automatic migration or deletion
- Strict native and TypeScript list/event/cancel/retry/cache contracts with sanitized public DTOs
- App-level accessible Job Center available with or without an open project
- Functional/release-performance benchmark separation and local measurement coverage

## Phase 3B verification/closure result

- Complete: exact-SHA GitHub Actions run `30764490903` executed and passed the TypeScript, Rust, and Windows jobs at HEAD `dbcb519eb2f562834d7ea7086219f87f5d7fbf2f`

## Phase 3B scope

- Make existing proxy, thumbnail, and final-render work observable, persistent, deduplicated, and restart-safe
- Keep one FFmpeg permit and two bounded blocking-I/O permits initially
- Preserve the existing `video_prepare_asset`, `video_start_render`, `video_cancel_render`, and render-event compatibility surfaces
- Store job/cache query state in machine-local SQLite while project snapshots and journals remain authoritative files
- Measure and bound the managed `supa-video-media-v1` object and derived trees without weakening exact-path and symlink/reparse protections
- Keep the production editor intentionally limited to its proven local single-clip workflow

## Phase 3B non-goals

- Audio intermediates, waveform pyramids, keyframe indexes, transcription chunks, embeddings, or semantic search
- Running-job preemption, remote workers, cloud queues, collaboration, or multi-process writers
- User-editable cache budgets, project-journal compaction, SQLite-backed canonical project state, or automatic legacy-cache deletion
- Phase 4 multitrack interaction or an editor redesign

## Affected modules

- `packages/video-media/`
- `apps/desktop/src-tauri/src/video/` job, scheduler, render, derived-media, and cache boundaries
- `apps/desktop/src/` job controller, IPC validation, Job Center, and compatibility status links
- Root CI, release-performance evidence, `README.md`, and `DESIGN.md`

## Phase 3B tests and runtime verification

- Strict schema/parity/redaction, SQLite migration/transaction/recovery, scheduler ordering/retry/cancellation, and cache lease/eviction/security tests
- Subscribe-before-snapshot UI reconciliation, every lifecycle and recovery state, keyboard/focus/live-region behavior, and zero applicable Axe WCAG A/AA/2.2 violations
- 1280x800, 480x360, and 320 CSS pixels at 200% text; long content, forced colors, reduced motion, and no horizontal document overflow
- Real bundled-FFmpeg restart/resume, priority, export cancellation/retry, lease/eviction/cache-miss, stripped-`PATH`, and legacy-policy proof

## Risks

- SQLite work can block Tokio unless every operation stays short and runs through `spawn_blocking`
- A crash can leave false running state unless startup recovery owns every nonterminal transition
- Eviction can race playback/build unless session leases, exact locks, and post-lock rechecks all agree
- Stale filesystem grants must never be persisted or silently restored
- Progress can flood disk/UI unless writes and announcements are coalesced
- Public distribution remains unavailable until documented GPL/source-offer and codec-patent legal approval is recorded; this deferred release gate does not block private-use Phase 4 development

## Phase 3B hard completion gate

Phase 3B is complete: every proxy, thumbnail, and final-render operation has one strict durable lifecycle; a terminated real app resumes the same deduplicated proxy job from its canonical object without stale processes or partials; deterministic tests prove bounded priority, cancellation, retry, blocked authorization, and recovery; managed usage is bounded by lease-aware safe LRU eviction and cache misses regenerate without changing project identity; the legacy cache has a visible confirmed policy; the existing single-clip workflow and all path/toolchain guarantees pass; the Job Center passes keyboard, required reflow, forced-color, reduced-motion, Axe, and redaction checks; every local TypeScript, browser, Rust, FFmpeg, packaged-resource, performance, Tauri, staged-media, and diff gate passes; and exact-SHA Actions run `30764490903` executed and passed. Phase 4 may proceed under the private-use-only scope; public distribution remains separately fail-closed pending legal approval.

## Proven References

### Kdenlive — proxy deduplication and separate worker pools

- Repository: [KDE/kdenlive](https://github.com/KDE/kdenlive)
- Files: [`src/jobs/proxytask.cpp`](https://github.com/KDE/kdenlive/blob/master/src/jobs/proxytask.cpp), [`src/jobs/taskmanager.cpp`](https://github.com/KDE/kdenlive/blob/master/src/jobs/taskmanager.cpp), [`src/utils/thumbnailcache.cpp`](https://github.com/KDE/kdenlive/blob/master/src/utils/thumbnailcache.cpp)
- Pseudocode adaptation:

```text
if validProxy(cacheKey): reuse
if equivalentJobPending(assetId): join
else enqueue(proxyPool, cancellableJob)
```

**License:** GPL-3.0-or-later; architecture reference only unless GPL compatibility is accepted.

### LosslessCut — viewport-oriented derived-media scheduling

- Repository: [mifi/lossless-cut](https://github.com/mifi/lossless-cut)
- Files: [`src/renderer/src/hooks/useThumbnails.ts`](https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/hooks/useThumbnails.ts), [`src/renderer/src/hooks/useWaveform.ts`](https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/hooks/useWaveform.ts)
- Adaptation:

```text
cancel requests outside viewport
request current window first
prefetch adjacent windows
revoke stale object URLs
```

**License:** GPL-2.0; pattern reference only unless licensing is made compatible.

### Audacity — multiresolution waveform data

- Repository: [audacity/audacity](https://github.com/audacity/audacity)
- Files: [`au3/libraries/au3-wave-track-paint/waveform/WaveDataCache.cpp`](https://github.com/audacity/audacity/blob/master/au3/libraries/au3-wave-track-paint/waveform/WaveDataCache.cpp), [`WaveBitmapCache.cpp`](https://github.com/audacity/audacity/blob/master/au3/libraries/au3-wave-track-paint/waveform/WaveBitmapCache.cpp)
- Adaptation:

```text
samplesPerPixel → raw samples | 256-sample summary | 64K summary
```

Separate waveform data caches from painted bitmap caches. **License:** GPL-3.0; reference only for a non-GPL product.

---

# Phase 4 — Functional multitrack editing UI

**Depends on:** Phases 2 and 3

## Implementation checkpoint — transform/opacity inspector slice verified 9 August 2026

Phases 1–3 remain complete for private-use development. Phase 4 is active and explicitly unfinished. This checkpoint closes the transform/opacity inspector vertical slice on top of the previously verified viewport, editing, track-state, and command-registry work; it does not claim the broader inspector or Phase 4 completion gates.

- **Viewport and projection foundations (`4edea0b`–`7292335`):** exact rational viewport geometry and the canonical, ordered, virtualized multitrack projection remain the read-only base for interaction work.
- **Selection and editing (`cc42d24`–`18aeb7c`):** ephemeral single-clip selection now drives split, move, and trim through the existing validated command-group controller; one completed action adopts one returned canonical revision, while drag/selection previews remain outside persisted project state.
- **Ripple delete (`bd9bde5`–`fc4a604`):** track-local ripple deletion removes the selected clip, shifts only later clips on that track by the deleted duration, preserves unaffected tracks, round-trips through inverse history, and is exposed as an accessible timeline action.
- **Track lock (`f1a30bf`–`43b5bfd`):** canonical lock state is persisted and projected, locked tracks reject clip/caption mutations, and one controller command powers accessible lock/unlock controls and disabled editing affordances.
- **Exact snapping (`bd6be44`–`a6d41e5`):** the rational snap engine evaluates predecessor/successor candidates without floating-point conversion, excludes the moving clip, supports clip edges, playhead, markers, grid, and caption boundaries, and keeps mixed-rate move results exact.
- **Track mute (`6896754`–`7192db9`):** video/audio mute is strict canonical state with inverse history, exact affected ranges and summaries, projection/controller/UI coverage, source-monitor and render-plan enforcement, active-render cancellation, persisted undo/redo proof, responsive controls, and focused browser interaction coverage; caption tracks remain invalid mute targets.
- **Track visibility (`8ff8824`–`9700903`):** strict `SetTrackHidden` canonical state applies to video and caption tracks while audio targets reject atomically; deterministic same-value handling, exact visual invalidations/summaries, locked-target behavior, inverse history, hashes, save/reopen, journal recovery, and migration/default omission are covered. Projection and controller state drive accessible show/hide controls and shown/hidden row semantics. The program monitor overlays the selected canonical video as hidden without coupling visibility to audio mute. Render plans add one exact full-frame black `drawbox` only for hidden video, retain unmuted audio, suppress audio only when muted, and leave caption visibility argv-neutral; native validation rejects filter mutation/removal/injection, accepted changes cancel an active render, and local FFmpeg/FFprobe proof produced black output.
- **Application command registry/remapping (`3b529c4`–`6913556`):** 15 stable desktop command IDs now share one runtime execution path across buttons and one global keyboard dispatcher. Versioned sparse `localStorage` preferences support exact remapping, disabling, per-command/all reset, collision rejection, strict corrupt-data fallback, immediate visible/ARIA updates, centralized modal/input/context/repeat suppression, and focus restoration without changing project or Rust persistence.
- **Transform/opacity inspector slice:** selected video clips expose bounded X/Y position, independent X/Y scale, clockwise rotation, reset/apply, and the existing opacity control. Draft geometry is ephemeral and updates the program monitor immediately; one explicit apply sends one complete validated `SetClipTransform` command through the canonical controller. Locked tracks and pending saves disable edits, validation and save errors remain visible, and selection/revision changes discard stale drafts.
- **Canonical transform and render parity:** Rust validates transform bounds before mutation and preserves exact inverse, hash, undo/redo, and journal-recovery behavior. V2 render metadata now carries all fixed-point geometry fields. TypeScript compilation and native argv validation independently derive the same contain → center → scale → rotate → canvas-relative translate → opacity composition, reject metadata/filter mismatches, and keep opacity independent from audio mute.

Track-visibility verification actually run against clean, synchronized `97009038b281f9dea08ea85156d6937b97c4fa52`: contracts **113/113**, project projection **16/16**, render compiler **13/13**, and desktop controller/UI/monitor/workspace **151/151** tests passed (**293/293** total); all four package typechecks and root ESLint passed. Focused Playwright visibility coverage passed **5/5** at desktop, 320 CSS px with 200% text, forced colors, RTL, and a long label. The full Rust suite passed **189** tests (**184** library + **5** integration), with **11** ignored; the focused project/history/persistence set passed **50/50**; native render security passed **2/2** with **1** ignored; and the explicitly run local FFmpeg/FFprobe test passed **1/1**, proving **60/60 black frames in both renders**, audio retained while hidden/unmuted, and audio absent while hidden/muted. Rustfmt, Clippy with `-D warnings`, `git diff --check`, and the final Prettier check passed; the initial Prettier check reported eight committed files, and formatting them produced **0 files, +0/−0** semantic Git diff with every worktree blob matching `HEAD`. This was local verification; no GitHub Actions success is claimed.

Command-registry verification actually run while closing that slice: `ShortcutSettings.test.tsx` passed **7/7**; the eight affected desktop Vitest files passed **89/89** before the final edit-saving guard correction, and `App.test.tsx` then passed **12/12** with its added regression; the full desktop Playwright set passed **32/32**; and all three desktop TypeScript configurations passed. `git diff --check` also passed. No Rust, mobile, native-menu, or broader Phase 4 completion claim is made from that slice.

Transform/opacity verification actually run for this checkpoint: `pnpm check` and `pnpm build` passed all workspace packages; `pnpm lint` and `pnpm format:check` passed; contracts passed **27/27** focused tests; the render compiler passed **23/23** tests; the desktop Vitest suite excluding browser fixtures and the Playwright-config isolation test passed **243/243**; and the full Rust suite passed **233/233** with **11** environment-dependent FFmpeg tests ignored. Focused Rust transform/render commands also passed after the final edits. Chromium Playwright passed **8/8** inspector tests at 1280×800 and 320×800, covering keyboard focus, axe, overflow, apply/reset, lock, saving, and error states; screenshots are tracked under `apps/desktop/evidence/phase-4/`. `git diff --check` passed. The root `pnpm test` run was not counted as a clean gate because its Playwright-config isolation test could not bind an already occupied external port 4173; the underlying non-browser desktop suite was rerun directly and passed **243/243**. No real-FFmpeg transformed-output or broader Phase 4 hard-gate claim is made.

The remaining Phase 4 scope—including speed, volume, fades, source-range and multiselect inspector controls, workspace/layout completion, stress/runtime proof, and the Phase 4 hard completion gate—is not complete and is not claimed complete here.

### Next planning item

Continue **P4-S05 — Commands, accessibility, monitors, and inspector** with the next bounded inspector control; do not reopen the completed transform/opacity slice unless a regression is found.

## Scope

- Multitrack video/audio/caption timeline
- Time-viewport virtualization with overscan
- Selection, move, split, trim, ripple delete, track lock/mute/visibility
- Snapping to clip edges, playhead, markers, grid, and caption boundaries
- Keyboard command registry and remapping
- Accessible alternatives to drag operations
- Source and program monitors
- Inspector for transform, opacity, speed, volume, fades, and source range

## Non-goals

- Advanced color grading, masks, optical flow, plugin hosting, multicamera
- Agent-generated edits
- Web/mobile editor

## Affected modules

- `apps/desktop/src/` studio workspaces and shared components
- `packages/video-project/` editing commands
- `packages/video-media/` visible-range caches
- `packages/video-contracts/` selection-independent view models

## Deliverables

- Canvas/WebGPU or immediate-mode timeline projection with semantic DOM controls
- One command registry shared by menus, shortcuts, toolbar, accessibility actions, and future agents
- Snap engine returning both corrected time and matched targets
- Ephemeral drag preview followed by one committed command
- Undo/redo labels understandable to users
- Resizable Assemble workspace

## Tests

- Geometry/time conversion tests at multiple zooms and DPI scales
- Snapping predecessor/successor tests and self-candidate exclusion
- Drag/trim command grouping tests
- Virtualization tests with thousands of clips
- Keyboard completion of core editing flow
- Screen-reader names, roles, selection, mute, lock, and track state
- 200% text, forced-colors, reduced-motion, RTL, long CJK/German labels

## Runtime and visual verification

- Maintain interactive scrubbing and dragging with a stress project
- Capture 1280×720, 1920×1080, ultrawide, and narrow-window layouts
- Verify timeline zoom/scroll does not reconstruct expensive media delegates outside the viewport
- Complete import → split → trim → move → undo → export by keyboard

## Risks

- Canvas timeline becoming inaccessible
- React rerendering the entire timeline every playback frame
- Whole-project snapshots for drag undo
- Timeline visual state leaking into persisted project state

## Hard completion gate

The stress project must remain responsive while only visible timeline media is materialized; every core pointer edit must have a keyboard/single-pointer alternative; one action must produce one understandable undo entry; playback updates must not rerender the full timeline.

## Proven References

### Kdenlive — visible-range delegate activation and snapping

- Repository: [KDE/kdenlive](https://github.com/KDE/kdenlive)
- Files: [`src/timeline2/view/qml/Track.qml`](https://github.com/KDE/kdenlive/blob/master/src/timeline2/view/qml/Track.qml), [`ClipAudioThumbs.qml`](https://github.com/KDE/kdenlive/blob/master/src/timeline2/view/qml/ClipAudioThumbs.qml), [`src/timeline2/model/snapmodel.cpp`](https://github.com/KDE/kdenlive/blob/master/src/timeline2/model/snapmodel.cpp)
- Adaptation:

```text
renderExpensiveClip = clipRange intersects visibleFrameRange + overscan
snap = nearest(predecessor(target), successor(target)) excluding moving clip
```

**License:** GPL-3.0-or-later; pattern reference only.

### FreeCut — editor/store/render separation

- Repository: [walterlow/freecut](https://github.com/walterlow/freecut)
- Files: [`src/shared/timeline`](https://github.com/walterlow/freecut/tree/main/src/shared/timeline), [`src/features/editor`](https://github.com/walterlow/freecut/tree/main/src/features/editor)
- Pattern: canonical timeline data remains independent of selection, viewport, scrub caches, and export queue. **License:** MIT with notice preservation.

### Audacity — centralized commands and accessibility events

- Repository: [audacity/audacity](https://github.com/audacity/audacity)
- Files: [`au3/src/TrackPanelAx.cpp`](https://github.com/audacity/audacity/blob/master/au3/src/TrackPanelAx.cpp), [`au3/libraries/au3-menus/CommandManager.cpp`](https://github.com/audacity/audacity/blob/master/au3/libraries/au3-menus/CommandManager.cpp)
- Adaptation:

```text
command(id).canExecute(state).execute()
menu, shortcut, accessibility action, and agent all resolve the same command
```

**License:** GPL-3.0; reference only for a non-GPL product.

---

# Phase 5 — Transcript editing, captions, and production audio

**Dependency status:** Implemented transcript/caption foundations depend on Phase 3 durable media and the verified Phase 4 V2 project, command, and projection primitives; remaining production-audio work retains its dependency on unfinished Phase 4 audio-envelope and fade primitives.

## Audited implementation checkpoint — 9 August 2026

Completed foundation slices:

- Versioned transcript artifacts, deterministic lineage, and native managed-cache storage
- Transcript-to-timeline mapping with reversible transcript edit proposals and desktop controller application
- Versioned caption contracts, deterministic caption generation, and candidate-state remapping
- Persistent `ApplyCaptionArtifact` command handling with grouped-command undo, redo, journal replay, and stale-lineage rejection
- Trim-caption lifecycle preparation and desktop integration: complete trim geometry includes optional `MoveClip`; caption-aware groups are ordered `TrimClip` → optional `MoveClip` → `ApplyCaptionArtifact`; missing, ambiguous, or stale transcript lineage fails closed; caption-free timelines retain the bare-trim fallback
- Split-caption lifecycle preparation and desktop integration: a standalone contiguous `SplitClip` replays and validates the candidate state, requires retained and artifact-invariant captions, and persists no replacement artifact; transcript-generated edits preserve right-to-left `SplitClip` → optional `SplitClip` → `RippleDeleteClip` geometry, remap once against the complete candidate state, then append deterministic `ApplyCaptionArtifact` commands in caption-track order. Missing, stale, ambiguous, inexact, unsupported, unsafe, or over-100-command groups fail closed before backend submission; caption-free splits and proposals retain bare geometry. Native commit, undo, redo, rejection, journal replay, and checkpoint tests verify atomic ordering and caption provenance.
- Standalone MoveClip-caption lifecycle preparation and desktop integration: the candidate `MoveClip` is contract-validated, replayed, and geometry-checked before submission; every active caption artifact is remapped against that candidate state and one deterministic atomic group is ordered `MoveClip` → `ApplyCaptionArtifact[]` in caption-track order. Missing, stale, mismatched, or ambiguous lineage; locked source or caption targets; invalid or inexact geometry; unsafe integer bounds; and groups over 100 commands fail closed before backend submission. Caption-free moves retain one validated bare `MoveClip`. Native proof covers one-revision atomic commit, exact inverse ordering, undo, redo, journal recovery, and close-time checkpoint persistence.
- Standalone RippleDeleteClip-caption lifecycle preparation and desktop integration: native-equivalent candidate replay validates index-based target deletion and suffix shifts before submission, and only active caption artifacts whose exact source lineage occurs in the deleted/shifted clip set are remapped. Atomic groups are ordered `RippleDeleteClip` → `ApplyCaptionArtifact[]` in sequence caption-track order; caption-free and unrelated-caption edits retain one validated bare command. Distinct affected transcript keys/source identities require exact artifacts, one exact transcript may serve multiple tracks, disappearing lineage persists an empty-cue replacement, and incomplete, invalid, duplicate, stale, ambiguous, locked, inexact, underflowing, remap-invalid, or over-100-command preparation fails before backend submission. Native proof covers mixed-source suffix shifts, two caption artifacts, one-revision commit, reverse caption inverses before ripple restoration, exact undo/redo, invalid-group rollback, unclean recovery, and close-time checkpoint persistence.
- Exact-key managed transcript read boundary: desktop callers can request one lowercase SHA-256 artifact key through a deny-unknown-fields Tauri command registered in production and test invoke handlers. The command derives the artifact path only from the initialized managed cache root, preserves bounded reads and identity verification, and returns the typed transcript artifact. Frontend IPC validates the key, parses the response with the shared transcript artifact schema, exposes the required method through `VideoBackend`, and sanitizes unstructured command failures. Arbitrary paths, publishing, ASR execution, and UI remain excluded.
- Automatic managed-transcript resolution: standalone split, move, trim, and ripple-delete controller edits derive exact transcript keys from active caption artifacts, deduplicate managed reads in deterministic first-reference order, reject missing or mismatched artifacts before submission, and keep edit ownership across asynchronous preparation. Manual transcript inputs are removed from those edit APIs. Ripple affected-caption selection is shared with the canonical project lifecycle selector, preserving suffix source-lineage matching and sequence caption-track order without a duplicate desktop implementation.

Open Phase 5 scope remains planned; this checkpoint does not claim completion of the phase.

### Verification actually run for the closed trim-caption slice

- `pnpm --filter @supa-video/project exec vitest run src/transcript-caption.test.ts src/transcript-caption-remap.test.ts src/trim-clip-caption-lifecycle.test.ts` — 70 passed
- `pnpm --filter @supa-video/desktop exec vitest run src/use-video-project.test.tsx` — 33 passed
- `pnpm --filter @supa-video/contracts exec vitest run src/project-caption-application.test.ts` — 17 passed
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml trim_clip_caption_lifecycle_is_atomic_across_history_and_recovery --lib` — 1 passed
- `pnpm --filter @supa-video/desktop exec tsc -b --pretty false` — passed
- `pnpm exec prettier --check apps/desktop/src/use-video-project.ts apps/desktop/src/use-video-project.test.tsx packages/video-project/src/trim-clip-caption-lifecycle.ts packages/video-project/src/trim-clip-caption-lifecycle.test.ts` and `git diff --check` — passed

### Verification actually run for the closed split-caption slice

- `pnpm --filter @supa-video/project exec vitest run src/transcript-caption-remap.test.ts src/split-clip-caption-lifecycle.test.ts src/transcript-edit.test.ts` — 50 passed
- `pnpm --filter @supa-video/desktop exec vitest run src/use-video-project.test.tsx` — 36 passed
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml split_clip_caption_lifecycle --lib` — 1 passed
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml transcript_edit_caption_lifecycle --lib` — 1 passed
- `pnpm --filter @supa-video/project check && pnpm --filter @supa-video/desktop check` — passed
- `pnpm exec prettier --check` on the changed TypeScript files, `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`, and `git diff --check` — passed

### Verification actually run for the closed standalone MoveClip-caption slice

- `pnpm --filter @supa-video/project test` — 9 files and 116 tests passed
- `pnpm --dir apps/desktop exec vitest run src/use-video-project.test.tsx` — 1 file and 38 tests passed
- `pnpm --filter @supa-video/project build` — passed
- `pnpm --filter @supa-video/project check` — passed
- `pnpm --filter @supa-video/desktop check` — passed
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml move_clip_caption_lifecycle_is_atomic_across_history_recovery_and_checkpoint -- --nocapture` — 1 passed, 246 filtered out in the native library target; the other targets ran zero matching tests
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml caption_lifecycle_ -- --nocapture` — 4 passed, 243 filtered out in the native library target; the other targets ran zero matching tests
- `pnpm exec prettier --check packages/video-project/src/move-clip-caption-lifecycle.ts packages/video-project/src/move-clip-caption-lifecycle.test.ts packages/video-project/src/index.ts apps/desktop/src/use-video-project.ts apps/desktop/src/use-video-project.test.tsx` — passed
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` — passed
- `git diff --check` — passed

### Verification actually run for the closed standalone RippleDeleteClip-caption slice

- `pnpm --filter @supa-video/project exec vitest run src/ripple-delete-clip-caption-lifecycle.test.ts src/transcript-caption-remap.test.ts src/split-clip-caption-lifecycle.test.ts` — 3 files and 52 tests passed
- `pnpm --dir apps/desktop exec vitest run src/use-video-project.test.tsx` — 1 file and 42 tests passed
- `pnpm --filter @supa-video/project build && pnpm --filter @supa-video/project check && pnpm --filter @supa-video/desktop check` — passed
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ripple_delete_caption_lifecycle_is_atomic_across_history_recovery_and_checkpoint -- --nocapture` — 1 passed, 247 filtered out in the native library target; the other targets ran zero matching tests
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml caption_lifecycle_ -- --nocapture` — 5 passed, 243 filtered out in the native library target; the other targets ran zero matching tests
- `pnpm exec prettier --check packages/video-project/src/ripple-delete-clip-caption-lifecycle.ts packages/video-project/src/ripple-delete-clip-caption-lifecycle.test.ts packages/video-project/src/index.ts apps/desktop/src/use-video-project.ts apps/desktop/src/use-video-project.test.tsx` — passed
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` — passed
- `git diff --check` — passed

### Verification actually run for the closed exact-key managed transcript read-boundary slice

- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml video::transcript::tests:: --lib` — 10 passed
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features tauri-ipc-test managed_transcript_exact_key_command_returns_the_checked_artifact --lib` — 1 passed
- `pnpm --filter @supa-video/desktop exec vitest run src/video-ipc.test.ts` — 1 file and 17 tests passed
- `pnpm --filter @supa-video/media exec vitest run src/transcript.test.ts` — 1 file and 5 tests passed
- `pnpm --filter @supa-video/media check && pnpm --filter @supa-video/media build` — passed
- `pnpm --filter @supa-video/desktop check && pnpm --filter @supa-video/desktop exec vite build` — passed
- Focused Rustfmt and Prettier checks plus `git diff --check` — passed
- The failed accidentally broad desktop test run is explicitly excluded and is not verification evidence for this slice.

### Verification actually run for the closed automatic managed-transcript resolution slice

- `pnpm --filter @supa-video/desktop exec vitest run src/managed-transcript-resolution.test.ts src/use-video-project.test.tsx src/video/workflow.integration.test.tsx src/video-ipc.test.ts` — 4 files and 87 tests passed (5 resolver, 45 controller, 20 workflow integration, and 17 IPC tests)
- `pnpm --filter @supa-video/project build` — passed
- `pnpm --filter @supa-video/project check && pnpm --filter @supa-video/desktop check` — passed
- `pnpm lint` — passed
- Focused Prettier checks plus `git diff --check` — passed

## Scope

- Local transcription with word timing and speaker labels
- Transcript-to-source and transcript-to-timeline mapping
- Delete transcript ranges to create reversible cut proposals
- Caption generation, cue editing, styling, safe-area preview, SRT/VTT/ASS export
- Dialogue/music/SFX tracks, gain, fades, ducking, cleanup, and loudness targets
- Word-level navigation between transcript, timeline, and monitor

## Non-goals

- Voice cloning by default
- Facial lip-sync generation
- Full DAW plugin hosting
- Automatic multilingual dubbing in this phase

## Affected modules

- `packages/video-contracts/` versioned transcript/caption application contracts
- `packages/video-media/` transcript and caption artifacts
- `packages/video-project/` mapping, proposal, generation, remapping, and lifecycle preparation
- `apps/desktop/src/` controller integration and planned Text Edit, Captions, and Audio workspaces
- `apps/desktop/src-tauri/` managed transcript storage and canonical caption command persistence
- `packages/media-tools/` planned reusable transcription/audio primitives; not yet present

## Deliverables

- Versioned transcript artifact with source-time mapping
- Transcript edit proposal and deterministic kept-range conversion
- Caption track schema and style contract
- Audio render-plan nodes and loudness report
- Text Edit, Captions, and Audio workspaces

## Tests

- Timestamp remapping after split, trim, move, and ripple operations
- Overlap, CPS, line-length, cue-duration, and safe-area checks
- Speaker mapping fixtures
- Loudness and true-peak integration tests
- Ducking envelope golden tests
- Transcript artifact invalidation when source fingerprint or ASR configuration changes

## Runtime and visual verification

- Delete a sentence in the transcript, preview the proposed cut, apply it, undo it, and verify the original transcript remains intact
- Verify captions at multiple aspect ratios and 200% UI zoom
- Export a master meeting the selected LUFS/true-peak target

## Risks

- Treating ASR text as ground truth
- Caption timing drifting after edits
- Destructive transcript editing
- Audio normalization hiding clipped or damaged sources

## Hard completion gate

Transcript edits must remain reversible and source-linked; captions must survive timeline changes without orphaning; final audio must pass measured loudness and peak checks; no ASR operation may overwrite source media.

## Proven References

### WhisperX — forced word alignment

- Repository: [m-bain/whisperX](https://github.com/m-bain/whisperX)
- File: [`whisperx/alignment.py`](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py)
- Adaptation:

```text
ASR segments + alignment model → word spans with confidence
store source-time spans; derive edited-time spans from timeline mapping
```

**License:** BSD-2-Clause for project code; model weights and dependent model licenses require separate review.

### AutoClip — chunked transcript extraction and bounded timestamp repair

- Repository: [zhouxiaoka/autoclip](https://github.com/zhouxiaoka/autoclip)
- Files: [`backend/pipeline/step2_timeline.py`](https://github.com/zhouxiaoka/autoclip/blob/main/backend/pipeline/step2_timeline.py), [`backend/utils/video_editor.py`](https://github.com/zhouxiaoka/autoclip/blob/main/backend/utils/video_editor.py)
- Adaptation:

```text
for transcriptChunk:
  validate structured result
  clamp timestamps to chunk
merge chronologically
convert text deletions to kept source intervals
```

**License:** MIT; preserve notice for reused code.

### libass and FFmpeg — subtitle shaping and loudness

- Repositories: [libass/libass](https://github.com/libass/libass), [FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg)
- Files: [`libass/ass_render.c`](https://github.com/libass/libass/blob/master/libass/ass_render.c), [`libavfilter/af_loudnorm.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_loudnorm.c)
- Pattern: render final shaped captions for geometry checks and use measured loudness passes rather than UI estimates. **License:** libass ISC; FFmpeg build may be LGPL/GPL depending on configuration.

---

# Phase 6 — Agent proposals, approvals, checkpoints, and review

**Depends on:** Phases 2, 4, and 5

## Scope

- Expose project queries and typed commands as bounded product agent tools
- Add immutable proposals against a base revision
- Read-only planning followed by explicit mutation proposals
- Review affected tracks/shots/ranges with before/after proof
- Project-scoped allow-once, always-allow, reject, and revise policies
- Checkpoint before each applied proposal
- Add bounded editorial review and repair loops
- Keep conversation, editorial decision journal, project revisions, and workflow checkpoints distinct

## Non-goals

- Autonomous publishing
- Stock download
- Unlimited self-repair loops
- Raw MCP mutation of project JSON

## Affected modules

- `packages/agent-runtime/`
- `packages/video-contracts/`
- `packages/video-project/`
- New proposal/review tools in a self-hosted subset of `packages/media-tools/`
- `apps/desktop/src/` agent drawer, proposal inspector, proof comparison, approval UI

## Deliverables

- `Proposal`, `ProposalOperation`, `Approval`, `Checkpoint`, `Evaluation`, and `RepairAttempt`
- Base-revision and stale-proposal rejection
- Risk classes for read-only, reversible, high-impact, expensive, rights-sensitive, and external operations
- Before/after duration and frame proof
- “Undo agent turn” and restore checkpoint
- Compact human-readable run feed

## Tests

- Tool schema and permission tests
- Stale-base and changed-project tests
- Partial approval tests
- Approval scope and expiry tests
- Checkpoint restore tests
- Agent cannot invoke unregistered command or arbitrary shell/FFmpeg operation
- Repair attempt and maximum-attempt enforcement
- Audit record redaction tests

## Runtime and visual verification

- Ask the agent to remove silences and tighten a section
- Inspect proposed ranges, reject one operation, approve the rest, apply, compare, undo the agent turn, and restore the checkpoint
- Close the app during approval and verify the approval remains pending after restart
- Verify tool-call details collapse into understandable editorial actions

## Risks

- Chat becoming the only inspectable surface
- Approval fatigue
- Model/tool version drift making proposals irreproducible
- Checkpoints confused with fine-grained undo
- Agent success treated as editorial correctness

## Hard completion gate

No agent mutation can reach the canonical timeline without schema validation, base-revision validation, policy evaluation, an atomic command group, a checkpoint, an audit record, and a user-visible result linked to affected timeline ranges.

## Proven References

### OpenChatCut — proposal-first editing

- Repository: [0xsline/OpenChatCut](https://github.com/0xsline/OpenChatCut)
- Files: [`src/agent/proposal.ts`](https://github.com/0xsline/OpenChatCut/blob/main/src/agent/proposal.ts), [`src/agent/external-tool-policy.ts`](https://github.com/0xsline/OpenChatCut/blob/main/src/agent/external-tool-policy.ts)
- Pseudocode adaptation:

```text
proposal = { baseRevision, operations, generatedArtifacts }
if project.revision != baseRevision: reject stale
if approved: commit operations atomically
```

**License:** AGPL-3.0; architecture reference only unless AGPL obligations are accepted.

### Pireel — shared tool runner and frame verification

- Repository: [pireel/pireel](https://github.com/pireel/pireel)
- Files: [`packages/studio-ui/src/agent-tool-runner.ts`](https://github.com/pireel/pireel/blob/main/packages/studio-ui/src/agent-tool-runner.ts), [`packages/studio-engine/src/mcp.ts`](https://github.com/pireel/pireel/blob/main/packages/studio-engine/src/mcp.ts)
- Adaptation:

```text
UI command and agent tool → same dispatcher
mutating tool → snapshot undo state
capture frame → verify current revision
```

**License:** AGPL-3.0; pattern reference only unless the product adopts compatible terms.

### OpenCode — scoped approval decisions

- Repository: [anomalyco/opencode](https://github.com/anomalyco/opencode)
- File: [`packages/app/src/context/permission.tsx`](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/context/permission.tsx)
- Adaptation:

```text
decision = once | alwaysWithin(project, operationClass, budget) | reject
```

License must be verified at the pinned commit before code reuse; use the interaction contract as a pattern until then.

### Dify — durable human-input pause

- Repository: [langgenius/dify](https://github.com/langgenius/dify)
- Files: [`api/core/workflow/nodes/human_input/boundary.py`](https://github.com/langgenius/dify/blob/main/api/core/workflow/nodes/human_input/boundary.py), [`api/core/workflow/nodes/agent_v2/ask_human_resume.py`](https://github.com/langgenius/dify/blob/main/api/core/workflow/nodes/agent_v2/ask_human_resume.py)
- Pattern: persist waiting, submitted, timed-out, and expired states; correlate a response to the exact workflow node. **License:** modified Apache-2.0 with commercial and frontend restrictions; pattern reference only unless legal review approves reuse.

---

# Phase 7 — Rights-first stock and public-media acquisition

**Depends on:** Phases 2, 3, and 6

## Scope

- Provider adapter contract and normalized candidate envelope
- Initial adapters: Wikimedia Commons, Openverse, Smithsonian CC0, Pexels, Pixabay, Freesound CC0/BY
- Rights classification by intended use
- Authoritative metadata refresh before acquisition and release
- Quarantine, streamed hashing, MIME/probe validation, atomic promotion
- Immutable API, landing-page, terms, and item-license snapshots
- Structured attribution and release gates
- Rights inspector in the UI

## Non-goals

- Scraping sites without supported APIs or explicit permission
- Treating Internet Archive uploader metadata as automatic clearance
- YouTube, TikTok, Instagram, broadcaster, or Google Arts & Culture downloading
- Automatic acceptance of unknown, NC, ND, editorial-only, or conflicting terms

## Affected modules

- `packages/video-rights/`
- `packages/video-media/`
- `packages/video-contracts/`
- `apps/desktop/src/` asset search, candidate comparison, rights inspector, attribution preview
- product agent tools for read-only search and policy-safe acquisition proposals

## Deliverables

- Provider/source distinction and normalized search result
- License policy profiles: personal, commercial, advertising, editorial, education
- Acquisition receipt and license snapshot schemas
- Redirect allowlists, download limits, modern hashes, deduplication
- Attribution sidecar and human-readable credits
- Export release gate

## Tests

- License matrix tests for CC0, PDM, BY, BY-SA, NC, ND, unknown, and custom terms
- Conflicting item/collection rights tests
- Redirect, path traversal, oversized file, MIME mismatch, interrupted download, and changed-ETag tests
- Attribution completeness tests
- Snapshot immutability and content hash tests
- Provider fixture tests without live API dependency
- Release blocked when evidence is missing or stale

## Runtime and visual verification

- Search across at least three providers
- Compare candidates by relevance, quality, source, license, attribution, and restrictions
- Download one permitted asset, inspect its receipt, place it on the timeline, export credits, then simulate a withdrawn/changed upstream record and verify release blocking

## Risks

- “Free” conflated with reusable
- Provider API terms differing from item license
- Public-domain material containing logos, people, private locations, or third-party inserts
- Credentials leaking into receipts or logs
- License UI oversimplifying legal uncertainty

## Hard completion gate

No remotely acquired asset may enter a releasable render unless its bytes are content-hashed, its authoritative rights evidence and provider terms are snapshotted, its intended use passes policy, required attribution is complete, and the timeline references the exact acquisition receipt.

## Proven References

### Openverse — provider federation and license normalization

- Repository: [WordPress/openverse](https://github.com/WordPress/openverse)
- Files: [`catalog/dags/providers/provider_api_scripts/provider_data_ingester.py`](https://github.com/WordPress/openverse/blob/main/catalog/dags/providers/provider_api_scripts/provider_data_ingester.py), [`catalog/dags/common/storage/media.py`](https://github.com/WordPress/openverse/blob/main/catalog/dags/common/storage/media.py), [`catalog/dags/common/licenses/licenses.py`](https://github.com/WordPress/openverse/blob/main/catalog/dags/common/licenses/licenses.py)
- Adaptation:

```text
providerResult → preserve raw rights → normalize source/provider/license → reject incomplete required fields
```

**License:** MIT; preserve copyright and permission notice for reused code.

### OpenReelio — license policy and persisted snapshots

- Repository: [openreelio/openreelio](https://github.com/openreelio/openreelio)
- Files: [`src-tauri/src/core/assets/license_policy.rs`](https://github.com/openreelio/openreelio/blob/main/src-tauri/src/core/assets/license_policy.rs), [`src-tauri/src/ipc/commands/agent.rs`](https://github.com/openreelio/openreelio/blob/main/src-tauri/src/ipc/commands/agent.rs)
- Short attributed excerpt:

```text
Allowed | Warning | Blocked
required actions: snapshot, attribution, manual review, provider terms
```

Its import path writes media and `.license.json` atomically, then links proof to the imported asset. **License:** MIT with notice preservation.

### Internet Archive client — resilient acquisition mechanics

- Repository: [jjjake/internetarchive](https://github.com/jjjake/internetarchive)
- Files: [`internetarchive/files.py`](https://github.com/jjjake/internetarchive/blob/master/internetarchive/files.py), [`internetarchive/item.py`](https://github.com/jjjake/internetarchive/blob/master/internetarchive/item.py)
- Pattern: range resume, checksum validation, original/derivative selection, and traversal protection. Use the mechanics, not uploader metadata as rights authority. **License:** AGPL-3.0; pattern reference only unless compatible licensing is accepted.

### C2PA Rust SDK — ingredient and output provenance

- Repository: [contentauth/c2pa-rs](https://github.com/contentauth/c2pa-rs)
- Files: [`sdk/src/ingredient.rs`](https://github.com/contentauth/c2pa-rs/blob/main/sdk/src/ingredient.rs), [`sdk/src/manifest.rs`](https://github.com/contentauth/c2pa-rs/blob/main/sdk/src/manifest.rs)
- Pattern: record ingredient identity, relationship, hashes, assertions, validation, and signatures. C2PA proves asserted history and integrity, not copyright validity. **License:** Apache-2.0 and MIT dual licensing; preserve selected-license obligations.

---

# Phase 8 — Semantic asset matching and automatic first-cut production

**Depends on:** Phases 5, 6, and 7

## Scope

- Convert brief and script into timed narrative beats and typed shot intents
- Search owned media first, then policy-approved remote sources
- Multilingual lexical retrieval, transcript search, visual embeddings, and audio embeddings
- Candidate reranking by semantic fit, rights confidence, quality, motion, orientation, duration, diversity, and repetition
- Generate a reviewable first-cut proposal with deterministic fallback graphics
- Support explainers, archive documentaries, podcast-to-video, and product-release templates

## Non-goals

- Generated video
- Unbounded autonomous publishing
- End-to-end aesthetic decisions without evaluation or user policy
- Treating embedding similarity as rights or quality proof

## Affected modules

- `packages/video-media/` indexes and embeddings
- `packages/video-rights/`
- `packages/video-project/`
- Agent skills in `packages/media-tools/` or a new producer-specific package
- `apps/desktop/src/` Produce workspace, storyboard, candidate comparison, first-cut review

## Deliverables

- `NarrativeBeat`, `ShotIntent`, `AssetCandidate`, `CandidateScore`, and `FirstCutProposal`
- Local asset index and shot/keyframe embeddings
- Repetition and near-duplicate controls
- Candidate explanation and rejected-candidate audit
- Template-based graphics for gaps: titles, maps, charts, screenshots, still-image motion
- End-to-end “brief → reviewable first cut” workflow

## Tests

- Deterministic ranking fixtures with rights hard filters
- Must-show/must-not-show and orientation constraints
- Duplicate/repetition penalties
- Multilingual query fixtures
- Candidate diversity by provider and visual cluster
- First-cut timeline invariant tests
- Model output schema rejection and timestamp clamping

## Runtime and visual verification

- Produce fixture videos for at least an explainer and podcast segment
- Review every beat’s selected candidate and alternatives
- Verify no generic candidate is reused beyond policy limits
- Verify rejected or unknown-license candidates never reach the proposal
- Compare first-cut duration and beat coverage with the script plan

## Risks

- Semantically relevant but visually generic footage
- Cultural stereotypes in geographic searches
- Model-generated shot intents too vague to retrieve useful media
- Large embedding indexes consuming excessive storage
- First cut optimized for similarity rather than editorial continuity

## Hard completion gate

Given the same project revision, provider snapshots, model/tool versions, and ranking configuration, the system must produce a reproducible first-cut proposal in which every selected asset has rights evidence, every script beat is covered or explicitly unresolved, and every edit remains inspectable and reversible.

## Proven References

### clip-retrieval — scalable embedding search and deduplication

- Repository: [rom1504/clip-retrieval](https://github.com/rom1504/clip-retrieval)
- Files: [`clip_retrieval/clip_back.py`](https://github.com/rom1504/clip-retrieval/blob/main/clip_retrieval/clip_back.py), [`clip_retrieval/clip_index.py`](https://github.com/rom1504/clip-retrieval/blob/main/clip_retrieval/clip_index.py)
- Adaptation:

```text
queryEmbedding → ANN candidates → metadata join → rights hard filter → diversity rerank
```

Do not use process-local Python hashes as durable asset identity. **License:** MIT with notice preservation.

### Pireel — narrative planning separated from picture cuts

- Repository: [pireel/pireel](https://github.com/pireel/pireel)
- Files: [`packages/studio-engine/src/plan.ts`](https://github.com/pireel/pireel/blob/main/packages/studio-engine/src/plan.ts), [`packages/studio-engine/src/build-draft.ts`](https://github.com/pireel/pireel/blob/main/packages/studio-engine/src/build-draft.ts)
- Pattern: retain semantic script ranges independently from actual source clip boundaries so editorial intent survives candidate replacement. **License:** AGPL-3.0; architecture reference only.

### FableCut — compact revision-safe timeline operations

- Repository: [ronak-create/FableCut](https://github.com/ronak-create/FableCut)
- File: [`mcp-server.js`](https://github.com/ronak-create/FableCut/blob/main/mcp-server.js)
- Adaptation:

```text
read compact revision
validate targeted operations
re-read latest revision
commit all-or-nothing
```

**License:** MIT; preserve notice for copied code.

---

# Phase 9 — Native retained preview compositor

**Depends on:** Phases 2–5 and measured evidence that proxy/WebView preview is insufficient

## Scope

- Implement a Rust/wgpu retained render DAG
- Persistent decoder and texture lifecycle
- Shared canonical timeline evaluator for proxy preview and export parameters
- GPU transforms, opacity, crop, blend, basic transitions, masks, captions, and template layers
- Explicit color, alpha, scaling, rotation, and pixel-aspect policy
- Exact paused-frame path and bounded playback queues
- Golden-frame comparison against CPU/reference renders

## Non-goals

- Full Resolve-grade color system
- Third-party effect plugins
- 3D scene editor
- Replacing FFmpeg demux/encode/audio
- Chromium as the complete compositor

## Affected modules

- New `crates/video-preview/`
- `packages/video-contracts/` render DAG and capability manifest
- `packages/video-render/` shared evaluator and fallback nodes
- `apps/desktop/src/` monitor surface and diagnostics

## Deliverables

- Typed render DAG with stable node/pad IDs
- Capability planner and CPU/FFmpeg fallbacks
- Persistent decode and GPU resource budgets
- Exact-frame capture API for agent and QC proof
- Preview quality tiers and diagnostics
- Color and parity test corpus

## Tests

- Golden frames at cuts, transitions, speed changes, alpha edges, captions, and VFR boundaries
- CPU-versus-GPU differential tests in linear light
- GPU resource leak and device-loss recovery tests
- Playback backpressure and frame-reordering tests
- Proxy-versus-original geometry/time tests
- Cross-GPU bounded perceptual-difference tests

## Runtime and visual verification

- Sustained playback of a two-layer 1080p stress sequence
- Rapid scrubbing and repeated seek across keyframes
- GPU device reset simulation
- Side-by-side proxy preview, exact paused frame, and final export comparison
- Display dropped frames, decode queue, GPU memory, and fallback-node diagnostics

## Risks

- Building an NLE engine before product workflows are proven
- GPU/vendor divergence
- Color conversion mismatch with final export
- Native surface integration complexity in Tauri
- Browser/CEF code accidentally becoming a required engine dependency

## Hard completion gate

The native compositor replaces the Phase 1 preview path only after it meets measured seek/playback targets, stays within declared GPU budgets, survives device loss, and passes golden-frame tolerances against the canonical evaluator and final render.

## Proven References

### Smelter/live-compositor — retained Rust/wgpu graph and browser isolation

- Repository: [software-mansion/live-compositor](https://github.com/software-mansion/live-compositor)
- Files: [`smelter-render/src/state/render_graph.rs`](https://github.com/software-mansion/live-compositor/blob/master/smelter-render/src/state/render_graph.rs), [`smelter-render/src/transformations/web_renderer/chromium_context.rs`](https://github.com/software-mansion/live-compositor/blob/master/smelter-render/src/transformations/web_renderer/chromium_context.rs), [`smelter-render/src/transformations/web_renderer/shared_memory.rs`](https://github.com/software-mansion/live-compositor/blob/master/smelter-render/src/transformations/web_renderer/shared_memory.rs)
- Adaptation:

```text
retained scene nodes + input textures → output texture
web template node → isolated browser → bounded shared-memory/GPU transfer
```

**License:** custom dual-use agreement; offline processing is permissive-like, while real-time processing, SaaS, embedding, and distribution can trigger restrictions. Do not copy or bundle code without a product-specific legal review.

### FreeCut — one composition semantic with distinct cache policy

- Repository: [walterlow/freecut](https://github.com/walterlow/freecut)
- File: [`src/features/export/utils/client-render-engine.ts`](https://github.com/walterlow/freecut/blob/main/src/features/export/utils/client-render-engine.ts)
- Pattern: preview and export share composition logic while using different caches and quality policies. **License:** MIT with notice preservation.

### Remotion — bounded frame pools and ordered handoff

- Repository: [remotion-dev/remotion](https://github.com/remotion-dev/remotion)
- Files: [`packages/renderer/src/render-frames.ts`](https://github.com/remotion-dev/remotion/blob/main/packages/renderer/src/render-frames.ts), [`packages/renderer/src/render-media.ts`](https://github.com/remotion-dev/remotion/blob/main/packages/renderer/src/render-media.ts)
- Adaptation:

```text
bounded workers render frames concurrently
completed frames enter encoder in deterministic order
failed worker is replaced within retry policy
```

Remotion is an optional HTML/template renderer reference, not the canonical preview engine. License and commercial terms for the exact packages used must be checked before adoption.

---

# Phase 10 — Quality control, bounded repair, delivery, and provenance

**Depends on:** Phases 5–9

## Scope

- Technical checks: decode, duration, dimensions, codec, black/freeze frames, clipping, silence, loudness, subtitle bounds, missing media, duplicate shots
- Editorial checks: continuity, pacing, repeated B-roll, beat coverage, must-show/must-not-show
- Rights and attribution release checks
- Bounded repair proposals with attempt limits and visible deltas
- Multi-format outputs: 16:9, 9:16, 1:1, captions, metadata, thumbnails
- C2PA ingredient/output manifests where supported
- Secure packaging, CSP, IPC/path restrictions, updater, crash diagnostics, and license notices

## Non-goals

- Claiming subjective scores prove quality
- Silent infinite repair loops
- Automatic publishing before destination-specific approval policy exists
- Bit-identical output across every GPU/hardware encoder

## Affected modules

- New `packages/video-qc/`
- `packages/video-render/`
- `packages/video-rights/`
- `apps/desktop/src/` Review and Deliver workspaces
- `apps/desktop/src-tauri/` CSP, capability scopes, packaged binaries, diagnostics

## Deliverables

- Typed QC finding and severity taxonomy
- Deterministic checks separated from subjective evaluators
- `Evaluation` and `RepairAttempt` history
- Delivery presets and immutable render manifests
- Post-render ffprobe/loudness/subtitle verification
- Attribution package and optional C2PA manifest
- Security and dependency/license inventory
- Release evidence bundle

## Tests

- Synthetic black, freeze, clipping, silence, missing-frame, subtitle-overflow, and loudness fixtures
- Duplicate and repeated-shot fixtures
- Repair attempt limit and accept-anyway policy tests
- Multi-aspect safe-area and caption tests
- Render snapshot reproducibility tests
- CSP, IPC sender, path grant, redirect allowlist, and secret-redaction tests
- Installer smoke tests and third-party notice verification

## Runtime and visual verification

- Run QC against intentionally broken fixture masters and inspect exact timeline-linked findings
- Repair selected findings, compare before/after, stop a repair loop, and accept a documented warning
- Export all supported aspect ratios and validate each encoded master
- Test offline mode, process crash recovery, update failure, missing binary, and low-disk-space behavior
- Complete keyboard and screen-reader review of Produce, Assemble, Review, and Deliver workflows

## Risks

- Subjective evaluator scores presented as objective truth
- Automated repairs changing creative intent
- False confidence from C2PA or technical checks
- FFmpeg build/license drift
- Tauri command surface expanding without narrow capabilities
- Existing `csp: null` remaining in production

## Hard completion gate

A release candidate must produce verified masters from immutable revisions, block unresolved hard rights/technical failures, expose every repair and override, pass security and accessibility gates, include reproducible render and license manifests, and install/run without external NLE software or system-installed media dependencies.

## Proven References

### FFmpeg — deterministic technical checks

- Repository: [FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg)
- Files: [`libavfilter/vf_blackdetect.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_blackdetect.c), [`libavfilter/vf_freezedetect.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_freezedetect.c), [`libavfilter/af_loudnorm.c`](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_loudnorm.c)
- Adaptation:

```text
encoded master → deterministic detectors → time-ranged findings → release policy
```

**License:** exact FFmpeg build determines LGPL/GPL obligations.

### Trigger.dev — operational run timeline

- Repository: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- Files: [`apps/webapp/app/components/run/RunTimeline.tsx`](https://github.com/triggerdotdev/trigger.dev/blob/main/apps/webapp/app/components/run/RunTimeline.tsx), [`apps/webapp/app/components/runs/v3/WaitpointDetails.tsx`](https://github.com/triggerdotdev/trigger.dev/blob/main/apps/webapp/app/components/runs/v3/WaitpointDetails.tsx)
- Pattern: distinguish queued, waiting, executing, delayed, completed, expired, and failed rather than displaying one synthetic progress state. **License:** Apache-2.0; preserve license and NOTICE requirements for copied code.

### InvokeAI — provenance inspector and parameter recall

- Repository: [invoke-ai/InvokeAI](https://github.com/invoke-ai/InvokeAI)
- Files: [`invokeai/frontend/web/src/features/gallery/components/ImageMetadataViewer/ImageMetadataViewer.tsx`](https://github.com/invoke-ai/InvokeAI/blob/main/invokeai/frontend/web/src/features/gallery/components/ImageMetadataViewer/ImageMetadataViewer.tsx), [`ImageMetadataActions.tsx`](https://github.com/invoke-ai/InvokeAI/blob/main/invokeai/frontend/web/src/features/gallery/components/ImageMetadataViewer/ImageMetadataActions.tsx)
- Pattern: provenance is inspectable and reusable; recalling a recipe should create a proposal/variant rather than overwrite current state. **License:** Apache-2.0.

### Inngest — checkpoint concepts only

- Repository: [inngest/inngest](https://github.com/inngest/inngest)
- File: [`pkg/execution/checkpoint/checkpoint.go`](https://github.com/inngest/inngest/blob/main/pkg/execution/checkpoint/checkpoint.go)
- Pattern: serialize workflow state when moving from synchronous work into resumable asynchronous execution. **License:** SSPL-1.0 with future-license terms in the repository; use as a conceptual reference only unless legal review approves reuse.

---

# Dependency order and release milestones

```text
Phase 1  Single clip: import → trim → export
   ↓
Phase 2  Canonical project, commands, revisions, recovery
   ↓
Phase 3  Durable media ingest, proxies, caches, jobs
   ↓
Phase 4  Functional multitrack editor UI
   ↓
Phase 5  Transcript, captions, and production audio
   ↓
Phase 6  Agent proposals, approvals, checkpoints, review
   ↓
Phase 7  Rights-first stock/public-media acquisition
   ↓
Phase 8  Semantic matching and automatic first cut
   ↓
Phase 9  Native retained preview compositor, only when measured
   ↓
Phase 10 QC, repair, delivery, provenance, release hardening
```

### Milestone A — Self-contained editor proof

Phases 1–4 complete: local media can be edited and exported entirely in our application.

### Milestone B — Agentic production proof

Phases 5–8 complete: a brief can become a rights-cleared, inspectable, reviewable first cut with minimal manual editing.

### Milestone C — Production-grade release

Phases 9–10 complete where profiling requires Phase 9: preview, QC, delivery, security, provenance, and packaging meet release gates.

---

# Unresolved decisions

1. **Product license:** proprietary, source-available, permissive open source, or copyleft; this determines whether GPL/AGPL implementation code may ever be reused
2. **FFmpeg public-distribution profile:** LGPL-focused build versus the current GPL-enabled build; GPL/source-offer, codec-patent, and platform review is deferred until public distribution and does not block private-use implementation phases
3. **Phase 1 target platforms:** recommend Windows-first, then macOS, then Linux after the project/render boundaries stabilize
4. **Project storage container:** directory project with JSON/journal/assets versus a packaged archive; default recommendation is an inspectable directory during early phases
5. **Rust boundary:** Tauri process versus dedicated local engine process; default to a project service boundary that can later move out-of-process without changing contracts
6. **SQLite role:** derived indexes/jobs only versus canonical project state; default is canonical snapshots/journal in files and SQLite for derived/query-heavy records
7. **Proxy codec:** platform-compatible H.264/AAC versus intraframe editing codec; benchmark legal, size, seek, and decode behavior before locking
8. **Native preview trigger:** define measured seek latency, dropped-frame, parity, and layer-count thresholds before authorizing Phase 9
9. **Model policy:** local-first versus hosted providers for transcription, embeddings, and editorial reasoning
10. **Stock provider credentials:** user-supplied keys, bundled service credentials, or both; credentials must never enter project receipts
11. **Commercial-use default:** recommend commercial-safe policy so outputs do not accidentally depend on NC or unclear assets
12. **C2PA scope:** final outputs only versus every derived artifact; begin with final masters and acquisition receipts
13. **Collaboration:** deliberately excluded until single-writer revision and recovery semantics are proven
14. **Publishing:** destinations, authentication, scheduling, and approval policy remain outside this roadmap’s implementation phases
15. **Smelter reference:** its custom real-time/embedding restrictions require legal review before any code reuse; default to independent implementation from observed patterns

---

# Exact Plan Mode prompt for Phase 1 only

```text
Enter Plan Mode and produce an implementation plan for Phase 1 of ROADMAP.md only. Use E:\Projects\supa-video-produzah as the sole product root, implementation root, workspace root, and write target.

Read ROADMAP.md first, inspect the currently sparse repository, and plan the bootstrap of a root pnpm workspace plus apps/desktop as a standalone Tauri v2/React TypeScript application. Plan product-owned packages/video-contracts, packages/video-project, and packages/video-render; do not import code, packages, process supervisors, UI primitives, or runtime services from another local repository.

Plan the thinnest self-contained vertical slice: create/open a minimal one-video .svpvideo project, probe one local MP4, generate a controlled proxy and thumbnail strip, display it in the product's own program monitor and one-track timeline, commit a typed TrimClip command using rational time, render an immutable project revision through a typed FFmpeg argv plan, support progress and cancellation, probe the finished MP4, and display verified output metadata.

Do not include multitrack editing, agents, model providers, stock footage, captions, semantic search, native wgpu preview, external NLE integration, cloud rendering, or production publishing.

The plan must specify bootstrap files, exact files to add/change, package ownership, schemas and IPC boundaries, an independently implemented FFmpeg boundary, fixture-media licensing, FFmpeg development/runtime discovery, security constraints, error states, unit/integration/UI tests, Tauri runtime verification, visual verification at 1280×800, 1920×1080, and 480×360, keyboard/accessibility checks, build commands, rollback strategy, risks, and the Phase 1 hard completion gate.

Resolve dependency/API uncertainties from authoritative current sources. Do not implement or modify production code. Write the plan under .gg/plans/ and submit it for review.
```
