# Roadmap implementation audit and next item

## Outcome

The repository is **still in Phase 1**. The workspace and browser-safe domain foundation are present, but the standalone single-clip vertical slice does not exist end to end.

The actual next atomic implementation item is **Phase 1 fixture creation**: add the deterministic `single-clip.mp4`, matching `single-clip.svpvideo`, and provenance/verification README under `apps/desktop/src-tauri/fixtures/video-phase1/`.

This is Roadmap Phase 1's checked-in deterministic fixture deliverable (`ROADMAP.md:111`) and Step 7 of `.gg/plans/video-phase-01-single-clip.md`. The later recovery plan explicitly stopped after Step 6 and left fixtures as the first remaining item (`.gg/plans/video-phase-01-render-plan.md:5-7,121,138`).

## Audit basis

The audit covered every tracked production source/configuration file, package manifest, test source, Tauri manifest/capability/configuration file, both existing Phase 1 plans, repository history, and the complete roadmap dependency order.

The worktree is clean on `main`, and the repository has one commit. Ignored local `dist/` and Rust `target/` artifacts show local tools have run at some point, but they are not clean-checkout or current-pass evidence.

No build, test, formatter, linter, Cargo, FFmpeg, or runtime command is claimed as passing in this read-only audit. Those gates must be rerun before implementation continues.

## Current implementation status

### Completed foundation

- **Workspace scaffold:** root `package.json`, `pnpm-workspace.yaml`, lockfile, strict TypeScript configuration, ESLint, Prettier, and ignores exist and match the planned package layout.
- **Desktop shell scaffold:** `apps/desktop` is a Tauri v2 + React 19 application with the planned 1280×800 default and 480×360 minimum window.
- **Package boundaries:** `@supa-video/contracts`, `@supa-video/project`, and `@supa-video/render` are private ESM workspace packages with topological dependencies and build/check/test scripts.
- **Rational time:** `packages/video-contracts/src/time.ts` implements reduced rational rates, BigInt-backed rescaling, explicit rounding, half-open ranges, source-duration conversion, and safe-integer validation.
- **Project contracts:** `packages/video-contracts/src/project.ts` and `migrations.ts` define and strictly parse the Phase 1 V1 project, asset, probe, sequence, track, clip, revision, and locator contracts.
- **Typed commands:** `packages/video-contracts/src/commands.ts` defines `ImportAsset`, `CreateSequence`, `InsertClip`, and `TrimClip` envelopes.
- **Project engine:** `packages/video-project/src/` creates immutable projects, validates stale bases and Phase 1 invariants, commits revisions, and provides undo/redo with branch truncation.
- **Pure render compiler:** `packages/video-render/src/compile-render-plan.ts` validates a renderable immutable revision and emits a frozen, ordered FFmpeg argv plan for AV and video-only inputs without I/O or process access.
- **Domain tests present:** source contains 17 contract/time cases after `it.each` expansion, 5 project/history cases, and 9 render-compiler cases.

These findings align with completed Steps 1–6 in `.gg/plans/video-phase-01-single-clip.md` and the focused render-plan recovery plan.

### Partial or unverified roadmap deliverables

- **Launchable desktop shell:** scaffold code and ignored local build artifacts exist, but the current source was not launched during this read-only audit.
- **Versioned `.svpvideo` format:** TypeScript schemas and migration dispatch exist; native open/save, atomic persistence, path grants, and reopen behavior do not.
- **Immutable revisions and undo/redo:** implemented in the browser-safe project package, but not connected to Tauri persistence or React state.
- **Typed render plan:** implemented and source-tested, but Rust does not revalidate or execute it.
- **Security boundary:** the intended boundary exists only in README prose. Tauri currently has `csp: null`, only `core:default`, no dialog plugin, no cache asset scope, and no native path/process validation.

### Missing Phase 1 implementation

- No `apps/desktop/src-tauri/fixtures/video-phase1/` directory, fixture MP4, fixture project, provenance, or hash evidence.
- No `apps/desktop/src-tauri/src/video/` module and no Tauri commands, managed state, sender/window ownership, path grants, dialogs, atomic saves, or project loading.
- No FFmpeg/ffprobe discovery, process supervisor, parser, proxy generation, thumbnail generation, render execution, progress events, cancellation, post-render probe, output promotion, or cleanup.
- No frontend IPC adapter, project controller, opener, asset row, program monitor, timeline, trim inspector, export panel, or meaningful application state; `App.tsx` is a 12-line centered boot placeholder.
- No desktop React tests, Rust tests, FFmpeg integration tests, checked-in evidence, accessibility verification, responsive screenshots, or real Tauri flow verification.
- The desktop test script uses `--passWithNoTests`, so a green root test command would not prove any desktop behavior.

### Documentation drift

`README.md` describes FFmpeg checking, Rust-owned dialogs/path grants, project persistence, controlled proxy playback, exact-frame trimming, and verified export as current product behavior. None is wired into the current Rust or React source. Treat those sections as intended Phase 1 behavior until Steps 8–18 are complete.

`ROADMAP.md:3` still says no implementation is authorized, while Steps 1–6 are now represented in source. The roadmap has no completion markers, so source plus the tracked implementation plans are the reliable status record.

## Phase and dependency conclusion

Phase 1's hard gate (`ROADMAP.md:146`) is not close to satisfied: the app cannot create/open a fixture project, import/probe/proxy media, trim through the UI, export/cancel/validate an MP4, or reopen and reproduce duration.

Phase 2 is therefore **not next**, even though the current domain packages already contain small Phase 2-like concepts such as stale-base rejection and undo/redo. Phase 2's canonical service, expanded schema, command groups/inverses, journal, snapshots, crash recovery, migrations, and integrity validator are absent.

The fixture bundle must precede native project/media work because it gives Step 8 a shared TypeScript/Rust schema-parity input and gives Steps 9–11 stable probe, proxy, render, cancellation, and output-validation media.

## Next-item scope

Add only:

- `apps/desktop/src-tauri/fixtures/video-phase1/single-clip.mp4`
- `apps/desktop/src-tauri/fixtures/video-phase1/single-clip.svpvideo`
- `apps/desktop/src-tauri/fixtures/video-phase1/README.md`

The MP4 should be a short self-generated FFmpeg `testsrc2` plus sine-audio source with fixed duration, frame rate, dimensions, H.264 video, AAC audio, deterministic encoding settings, and no third-party media rights.

The project JSON should be a strict V1 document with stable UUIDs, one asset, one sequence, one video track, one full-range clip, rational frame times, and a project-relative `single-clip.mp4` locator. Its probe snapshot must exactly match ffprobe evidence from the committed media.

The README should record the exact generation and inspection commands, FFmpeg/ffprobe version, platform, expected duration/rate/dimensions/codecs/audio shape/file size, SHA-256, self-generated provenance, and the limit that re-encoding under another FFmpeg build may not reproduce identical bytes.

Do not pull Rust IPC, proxy generation, process supervision, UI, or runtime export into this item; those begin at Step 8.

## Risks and verification

- **False determinism:** pin every practical encoder/input option and hash the committed artifact; define the checked-in bytes as canonical rather than promising cross-version libx264 byte identity.
- **Schema/media mismatch:** derive probe metadata from the final committed bytes, then validate the JSON through `parseVideoProjectFile` and confirm the clip source-out matches the declared frame range.
- **Fixture bloat:** keep duration and resolution small while retaining both audio and video and enough frames for trim/proxy/thumbnail tests.
- **Ignored binary:** `.gitignore` already explicitly retains the exact planned MP4 path; verify all three fixture files are tracked.
- **Baseline uncertainty:** run existing frozen-install and quality gates before fixture generation, then rerun them after adding the fixture so pre-existing failures are separated from fixture defects.

## Steps

1. Run the current frozen-install, root build/check/test/lint/format gates and Rust fmt/clippy/test gates, recording any pre-existing failure without changing fixture scope.
2. Generate the small canonical AV MP4 under `apps/desktop/src-tauri/fixtures/video-phase1/` with fixed FFmpeg lavfi, codec, timing, threading, and metadata options.
3. Probe and hash the final MP4, then add a strict fully populated `single-clip.svpvideo` whose locator, probe snapshot, rational times, and source range match those bytes.
4. Add the fixture README with exact generation/probe/hash commands, tool versions, expected metadata, self-generated provenance, and reproducibility limits.
5. Validate the fixture project through the TypeScript V1 parser, verify ffprobe metadata and SHA-256, confirm all fixture files are tracked, and rerun the focused plus root quality gates.
