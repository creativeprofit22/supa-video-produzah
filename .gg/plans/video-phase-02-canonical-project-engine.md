# Video Phase 02: Canonical project engine and recoverable command history

**Status:** Proposed implementation plan; implementation has not started
**Depends on:** Completed Phase 1 baseline at repository HEAD `a0a6369`
**Product, workspace, and implementation root:** `E:\Projects\supa-video-produzah`

## Outcome

Move all authoritative project mutation out of the React webview and into one Rust-owned project service. Phase 2 will add a strict V2 project model, semantic command groups, monotonic revisions, durable undo/redo, an append-and-sync NDJSON journal, periodic atomic snapshots, V1 migration, deterministic state hashing, integrity validation, and exact crash recovery.

The existing Phase 1 editor remains usable during the transition. Its monitor, trim controls, export path, source recovery, cache boundary, and render pipeline will consume a read-only V2 project projection returned by Rust; ephemeral playhead, trim draft, selection, viewport, prepared media, decoder state, render jobs, and file handles will remain outside persistent project state.

Phase 2 is complete only when the same snapshot and valid journal prefix always replay to the same SHA-256 project-state hash, acknowledged commands survive process termination, stale or malformed commands never mutate disk or memory, and every supported edit is undoable or explicitly recorded as an irreversible migration boundary.

## Verified baseline

- Phase 1 is complete, the worktree is clean, and `main` matches `origin/main` at `a0a6369`.
- `packages/video-contracts/src/project.ts` currently defines a strict one-asset, one-sequence, one-track, one-clip V1 file with full state copied into every revision.
- `packages/video-project/src/execute-command.ts` currently mutates V1 documents in the browser-safe TypeScript package; `history.ts` moves a cursor through the revision array.
- `apps/desktop/src/use-video-project.ts` currently constructs commands in React, computes candidate documents locally, calls `video_save_project`, and activates the candidate only after save.
- `apps/desktop/src-tauri/src/video/project_io.rs` validates mirrored V1 DTOs, owns dialogs and path grants, and atomically replaces one `.svpvideo` file, but it does not execute project commands or retain an active project session.
- `apps/desktop/src-tauri/src/video/types.rs` manually mirrors the V1 schema. Shared TypeScript/Rust fixtures already establish a parity-testing pattern.
- `VideoPathGrants` already supports multiple source paths per owner, but `grant_opened_project` and source resolution currently accept only one current source.
- `sha2 = 0.10.9`, `fs4 = 1.1.0`, and `tempfile = 3.27.0` are already locked. `fs4` exposes cross-platform advisory whole-file locks through `FileExt::try_lock`; `tempfile::NamedTempFile::persist` atomically replaces a same-filesystem target but explicitly does not sync contents or the containing directory by itself.
- Tauri v2 managed state supports an interior-mutable Rust service accessed from commands and lifecycle handlers. The project service can therefore be managed beside `VideoPathGrants` and `VideoRenderJobs` without a Node sidecar.
- RFC 8785 defines deterministic JSON canonicalization suitable for hashing. Current `serde_json_canonicalizer 0.3.2` exposes `to_vec`, is MIT licensed, and is the selected production dependency. Existing `sha2` will produce lowercase SHA-256 state and record hashes.
- Current `proptest 1.11.0` supports Rust 1.85 and is compatible with this crate's Rust 1.87 floor. Add it only as a dev dependency for invariant, malformed-input, and crash-sequence generation.
- NDJSON 1.0 requires one UTF-8 JSON text followed by `\n` per record. Journal writers will emit compact single-line objects and parsers will accept `\n` or `\r\n` while treating an unterminated final line as a torn tail.
- Existing CI already runs TypeScript build/check/test/lint/format, Rust fmt/Clippy/all-feature tests on Linux and Windows, and a Windows Tauri production build. Phase 2 extends these gates rather than creating a second pipeline.

No build, test, formatter, linter, Cargo, FFmpeg, or runtime command was run during this read-only planning pass.

## Resolved architecture

Choose a **Rust-owned in-process project service**, not a process-isolated TypeScript worker.

Reasons:

- Rust already owns project paths, source grants, bounded file I/O, atomic replacement, Tauri lifecycle cleanup, and the security boundary.
- Moving TypeScript mutation into another process would require bundling and supervising a new runtime solely to preserve code that is currently trusted by the webview.
- An in-process service can acknowledge a command only after its journal record is synced, keep an exclusive project lock for the active session, and release the lock automatically when the process dies.
- Crash behavior remains testable through storage failpoints and real forced application termination; no separate daemon is required by the roadmap hard gate.

The browser-safe packages remain useful but lose authority:

- `@supa-video/contracts` owns strict persisted, command, result, event, projection, recovery, and IPC schemas.
- `@supa-video/project` owns command-group builders, immutable projection selectors, Phase 1 compatibility helpers during migration, and renderable-revision extraction. It must not apply or persist V2 mutations.
- Rust owns command validation after deserialization, preconditions, state transitions, inverse generation, revision assignment, hashes, journal/snapshot durability, replay, undo/redo stacks, and integrity checks.
- React owns only ephemeral drafts and renders Rust-returned projections.

## Persistent storage layout

Keep `.svpvideo` as the user-selected file and latest portable snapshot. Place recovery data in one deterministic sibling directory so the native picker and Phase 1 file association continue to work:

```text
My Project.svpvideo
My Project.svpvideo.data/
  project.lock
  journal.ndjson
  snapshot.previous.svpvideo
  recovery-report.json        # present only after migration/recovery needs reporting
```

Rules:

- `My Project.svpvideo` is the latest V2 snapshot and remains strict, human-readable JSON.
- `journal.ndjson` contains one header followed by append-only operation records. It is persistent project data, not cache.
- `snapshot.previous.svpvideo` retains the prior valid snapshot before a checkpoint replaces the main file. Recovery selects the highest valid snapshot whose generation, revision, and state hash can be reconciled with the journal.
- `project.lock` is opened read/write and held with `fs4::FileExt::try_lock` for the full active session. A second window or process receives a typed `project_in_use` error rather than racing writes. The lock is advisory, so every product write path must use the service.
- `recovery-report.json` is an atomically written diagnostic record after migration, torn-tail repair, fallback-snapshot use, or corruption truncation. It is not part of the authoritative state hash.
- Snapshot reads are capped at 16 MiB, the journal at 64 MiB, each journal line and command-group request at 1 MiB, and each group at 100 commands. Exceeding a cap fails before mutation with an actionable typed error.
- Phase 2 does not compact acknowledged journal records. Periodic snapshots bound state reconstruction work, while retaining the complete hash chain avoids a risky snapshot/journal truncation protocol. Later compaction must introduce an anchored journal rotation protocol before removing records.

## V2 project contract

Add V2 contracts without deleting V1 parsing or fixtures. `parseVideoProjectFile` dispatches versions 1 and 2; only Rust may migrate a V1 file on open.

### Snapshot envelope

`VideoProjectSnapshotV2` contains:

- `schemaVersion: 2`
- stable `id`, `name`, `createdAt`, and `updatedAt`
- `storageGenerationId`, binding the snapshot, sidecar, journal header, and backup snapshot
- `revision`: `{ number, id, parentId, committedAt, operationId, stateHash }`; revision zero is project creation and every commit, undo, or redo increments the safe integer exactly once
- `state`: the canonical persistent project state
- `history`: bounded `undoStack` and `redoStack` entries containing semantic forward commands, semantic inverse commands, group summary, affected ranges, cache invalidations, and original group identity
- checkpoint metadata: `lastAppliedRecordNumber` and `lastRecordHash`

State hashes are lowercase SHA-256 over RFC 8785 canonical JSON bytes of `state` only. Journal record hashes cover the canonical record excluding its own `recordHash`; each operation includes `previousRecordHash`, `previousStateHash`, and `resultingStateHash` to detect deletion, reordering, duplication, and state divergence.

### Canonical state

`VideoProjectStateV2` contains arrays rather than object maps so ordering is explicit and portable:

- `assets: VideoAsset[]`
- `sequences: VideoSequenceV2[]`
- `activeSequenceId: UUID | null`

Use existing locator and media-probe records. Expand sequences and editing entities as follows:

- `VideoSequenceV2`: stable ID, nonblank name, rational frame rate, even dimensions, audio sample rate, ordered heterogeneous `tracks`, and ordered `markers`.
- `ProjectTrack`: strict discriminated union of `video`, `audio`, and `caption` tracks.
- Video/audio tracks contain ordered `ProjectClip[]`; caption tracks contain ordered `ProjectCaption[]`.
- `ProjectClip`: stable ID, `source` union (`asset` or nested `sequence`), exact `timelineStart`, exact `sourceIn`/`sourceOut`, fixed-point `transform`, and integer `gainMilliDecibels`.
- `ClipTransform`: integer `positionXPermille`, `positionYPermille`, positive `scaleXPermille`, `scaleYPermille`, `rotationMilliDegrees`, and `opacityPermille` from 0 through 1000. Fixed-point values avoid cross-language floating serialization drift.
- `ProjectMarker`: stable ID, exact rational `time`, nonblank label, and a small optional semantic color enum.
- `ProjectCaption`: stable ID, exact rational `start`/`end`, nonblank text, and optional language tag; caption styling remains out of Phase 2.

Persistent documents never contain resolved native paths beyond existing locators, proxy/thumbnail paths, object URLs, decoder/GPU/file handles, render jobs, UI selection, playhead, draft edits, viewport state, inspector visibility, or cache health.

### Integrity validator

The TypeScript schema performs shape, bounds, and local checks. Rust runs the authoritative graph validator after migration, before a command is journaled, after every transaction, and after replay:

- all entity IDs are canonical UUIDs and globally unique
- all asset, sequence, track, clip, caption, and marker references resolve
- `activeSequenceId` resolves or is null only when no active sequence exists
- sequence nesting is acyclic and cannot reference itself directly or indirectly
- rational rates are reduced; timeline values use their parent sequence rate; source values use the referenced asset/sequence rate
- every source range is nonempty and inside the referenced source duration
- clips are sorted by timeline start and do not overlap on the same track; overlap across tracks remains valid
- split, move, and trim preserve exact half-open ranges without negative or unsafe values
- captions and markers are in sequence bounds; transforms, gain, dimensions, and array counts stay bounded
- relative locators cannot escape the project directory; absolute fallbacks remain native-only strings and require source grants before media work
- history stack entries validate against their semantic command schemas and remain consistent with current undo/redo availability
- snapshot revision/hash metadata and journal hash chains reconcile exactly

## Command language and registry

Replace V1 command envelopes with strict V2 command groups:

```text
CommandGroupRequest = {
  groupId,
  projectId,
  baseRevision,
  commands: ProjectCommand[]
}
```

Each command has its own `commandId` and strict discriminant. Timestamps, summaries, revisions, hashes, affected ranges, inverses, and cache invalidations are generated by Rust, not accepted from the caller.

Public commands:

- `ImportAsset`
- `CreateSequence`
- `InsertClip`
- `RemoveClip`
- `SplitClip`
- `MoveClip`
- `TrimClip`
- `SetClipTransform`
- `SetClipGain`
- `AddMarker`
- `RemoveMarker` so `AddMarker` has a semantic inverse
- `RelinkAsset` for a native-picked replacement locator and refreshed probe

`ImportAsset` and `RelinkAsset` receive additional gateway validation: referenced absolute paths must exactly match an owner source grant, and probe/locator values must match native-selected media data. The generic command engine never opens caller-supplied paths.

For every command, one Rust registry entry owns:

- strict preconditions and reference lookup
- deterministic application to a cloned working state
- semantic inverse generation from pre-command domain values
- concise user-facing summary
- exact affected sequence/time ranges
- typed cache invalidations (`timeline`, `preview`, `audio_mix`, `captions`, `render_plan`, or `asset_source`)
- whether the operation is undoable; only V1 migration/project initialization may be explicitly irreversible

A command group executes against one cloned state. If any command or final integrity validation fails, no journal bytes, revision, history stack, event, snapshot, or in-memory projection changes. Successful inverses are stored in reverse execution order.

`CommandResult` contains project ID, group/operation ID, prior and new revision descriptors, new state hash, the complete validated `ProjectProjection`, affected ranges, cache invalidations, and typed `ProjectEvent[]`. Duplicate `groupId` with identical canonical payload is idempotent and returns its prior result; reuse with different bytes is rejected.

## Monotonic undo and redo

Undo/redo must not move a cursor backward through old snapshots.

- A normal successful group pushes its command/inverse record onto `undoStack` and clears `redoStack`.
- Undo applies the latest stored inverse group transactionally, moves the original group to `redoStack`, appends and syncs a `kind: "undo"` journal record, and creates a new monotonic revision.
- Redo reapplies the original forward group, moves it back to `undoStack`, appends and syncs a `kind: "redo"` record, and creates another new revision.
- An invalid inverse is an integrity failure, not a partial undo.
- Project initialization and V1 migration are explicit irreversible boundaries and never appear as enabled undo actions.
- Replay reconstructs state and both stacks exactly, so undo/redo availability survives restart and recovery.

## Journal, snapshot, and recovery protocol

### Journal format

The first line is a `journalVersion: 1` header containing project ID, storage generation, base revision/state hash, creation time, and header hash. Every following line is a strict operation record:

- `kind: "commit" | "undo" | "redo"`
- contiguous `recordNumber`
- operation/group identity and commit timestamp
- base and resulting revision descriptors
- forward request or referenced history group needed for deterministic replay
- affected ranges, invalidations, and summary generated by the registry
- previous/resulting state hashes
- previous/current record hashes

Serialization uses compact RFC 8785-compatible JSON with one trailing `\n`; no record may contain raw CR/LF outside JSON string escaping.

### Commit ordering

For commit, undo, and redo:

1. Locate the owner session and take its per-project mutex.
2. Reject project mismatch, stale base revision, invalid payload, duplicate conflict, or failed precondition.
3. Apply all commands to a cloned state, generate inverses/metadata, run integrity validation, and compute resulting hashes.
4. Append the complete journal line, flush, and call `sync_all`.
5. Publish state, revision, history stacks, journal metadata, and the idempotency result in memory.
6. If the checkpoint threshold is reached, attempt a snapshot; a snapshot failure returns success with explicit unhealthy/pending snapshot status because the command is already durable in the journal.
7. Return the result. No success response is sent before step 4.

Checkpoint after every 25 durable operations and on clean project close/window teardown. The checkpoint writer serializes and validates the candidate snapshot, writes a same-directory temp, flushes and syncs it, preserves the prior valid main snapshot in `snapshot.previous.svpvideo`, atomically replaces the main file, and syncs the parent directory where the platform supports it. Injected failure before replacement must leave the previous main snapshot readable; failure after replacement must leave either the old or new complete snapshot plus the durable journal.

### Open and recovery

Opening a project:

1. Normalize and grant the selected `.svpvideo` path, derive the sibling data directory without accepting a webview path, and acquire its exclusive lock.
2. Bounded-read the main and previous snapshots; strictly parse/migrate candidates and verify their state hashes.
3. Bounded-read `journal.ndjson`, validate its header/generation/hash chain, and scan complete lines in order.
4. Select the highest valid snapshot compatible with a journal prefix, then replay later valid operations while checking base revision, registry output, state hash, record number, record hash, and final integrity after every record.
5. Resolve every current asset locator into a unique source record and grant all contained project-relative sources.
6. Register the recovered session only after successful reconstruction and return a projection plus `RecoveryReport`.

Recovery policy is explicit:

- Clean EOF after a newline is `clean`.
- Any unterminated final bytes are a torn tail and are discarded; the valid prefix is retained.
- Malformed JSON, schema failure, hash break, noncontiguous revision, or invalid command truncates recovery at the last valid record. The original invalid tail is preserved in the recovery report before the active journal is atomically repaired to the valid prefix.
- If the main snapshot is invalid but the previous snapshot plus journal recovers exactly, status is `recovered` and the main snapshot is rewritten.
- If recovery drops any newline-terminated record or cannot prove a hash chain, status is `degraded`; the UI shows a visible warning with the recovered revision and possible lost-change boundary.
- If neither snapshot and no valid journal base can reconstruct a valid project, open fails without registering a session or altering evidence.
- A missing sidecar for a valid V2 snapshot creates a new journal header anchored at that snapshot and reports `journal_recreated`; the snapshot's persisted history remains available.

Storage tests use deterministic failpoints before append, after partial append, after append before sync, after sync before publish, before snapshot temp sync, after snapshot sync before replace, and after replace. Reopening after each failpoint must produce either the last acknowledged hash or the newly durable hash, never a third state.

## V1 migration

Preserve V1 fixtures and parsing permanently for this phase.

On first native open of V1:

- validate the complete V1 document and identify its selected `currentRevisionId`
- convert that selected state into V2 arrays, a named active sequence, one typed video track, default fixed-point transform, zero gain, and no markers/captions
- preserve project/asset/sequence/track/clip IDs, timestamps, media probe, and source locator
- create V2 revision zero with a new storage generation and a hash of the migrated state
- record one explicit irreversible `v1_migration` boundary; V1 undo/redo branches cannot be reconstructed semantically because V1 persisted summaries and full states but not original command payloads
- write the V2 snapshot and journal header through the durable protocol while retaining the original V1 bytes as `snapshot.previous.svpvideo`
- return a recovery report stating that current state was preserved and legacy history was reset

Migration failure leaves the original V1 file untouched and creates no active session. Fixtures cover minimal, imported, trimmed, undone-current, relative-source, absolute-fallback, missing-source, malformed, and future-version inputs. Reopening the migrated bytes must be idempotent and must not emit a second migration.

## Native project service and IPC

Add a dedicated `apps/desktop/src-tauri/src/video/project/` module instead of growing `types.rs` and `project_io.rs` further:

- `types.rs`: mirrored V2 snapshot, state, command, result, event, projection, journal, and recovery DTOs with `deny_unknown_fields`
- `integrity.rs`: graph/rate/range/history validator
- `commands.rs`: registry, deterministic handlers, inverse generation, summaries, ranges, and invalidations
- `history.rs`: transaction commit plus monotonic undo/redo stack transitions
- `hash.rs`: RFC 8785 canonicalization and SHA-256 helpers
- `journal.rs`: header/record serialization, bounded append-and-sync, scan, hash-chain validation, tail classification, and repair
- `snapshot.rs`: bounded read, durable atomic checkpoint, previous-snapshot handling, and candidate selection
- `migration.rs`: strict V1-to-V2 migration
- `recovery.rs`: snapshot selection, replay, and recovery-report generation
- `service.rs`: `VideoProjectService`, owner sessions, per-session mutexes, project locks, idempotency, create/open/close/query/execute/undo/redo
- `ipc.rs`: narrow Tauri commands and conversion to existing source records/grants
- `tests.rs`: focused unit/property/crash/replay tests; keep media/process/render tests in their current module

Register and mock-test these commands:

- `video_create_project(path, name)` after the existing native save picker grant
- `video_open_project()` upgraded to migrate/recover and register a session
- `video_execute_project_group(request)`
- `video_undo_project(projectId, baseRevision, operationId)`
- `video_redo_project(projectId, baseRevision, operationId)`
- `video_project_inspector(projectId)`
- `video_relink_project_asset(projectId, assetId)` using a native picker and refreshed native probe
- `video_close_project(projectId)` for clean checkpoint/release during project switches

Retire `video_save_project` from production registration after all frontend callers move to the service. Keep only private migration/test helpers where required. Window destruction must checkpoint/close all owner sessions before revoking grants; app exit attempts a bounded best-effort checkpoint, while durability never depends on that cleanup.

`ProjectProjection` returned to the webview includes only canonical state, revision descriptor, can-undo/can-redo, last command metadata, source records, journal health, snapshot revision, and recovery status. It excludes journal paths, lock handles, inverse payloads, native file handles, and raw corrupted bytes.

## Frontend and render integration

Refactor `apps/desktop/src/video-ipc.ts` and `use-video-project.ts` around projections:

- New project: choose a native path, call `video_create_project`, and activate its returned projection. React no longer calls `createProject` or saves arbitrary project JSON.
- Open: parse the strict opened-project V2 response, display recovery status, prepare resolved active media, and preserve the current project if open/migration/recovery fails.
- Import: retain native pick/probe/prepare, then submit `ImportAsset + CreateSequence + InsertClip` as one command group against the current base revision. A failed group leaves the project empty.
- Trim Apply: keep draft range ephemeral; submit one `TrimClip` group and replace the projection only from the successful native result.
- Undo/redo: call native operations and use returned monotonic projections; remove the browser `ProjectHistory` cursor and save-before-activation candidate flow.
- Export: change `compileSingleClipRenderPlan` to consume a strict renderable revision projection (`revision.id` plus V2 state), while retaining the existing RenderPlan V1 IPC grammar and Rust revalidation.
- Source records: support all V2 assets in contracts and controller state; the Phase 1 workspace continues to display/prepare the active single clip only.
- Stale results: retain operation counters and additionally require returned project ID, operation ID, and base/new revisions to match before activation.
- Project switch/unmount: cancel any owned render, call `video_close_project`, then activate the new session. A close checkpoint warning must not discard the already journaled state.

Remove `executeCommand`, `commit`, `createHistory`, browser undo/redo, and arbitrary `saveVideoProject` from production frontend paths. Preserve V1 helpers only where migration fixtures or compatibility tests still use them.

`packages/video-render` remains a pure compiler. Its Phase 2 change is structural adaptation from a V1 full revision to the V2 renderable projection; single-clip export behavior and FFmpeg argv order remain unchanged and keep their existing snapshots.

## Developer inspector and recovery UI

Preserve the existing compact dark workbench, shared rail, Geist/Geist Mono pairing, Lucide icon family, borders, focus treatment, responsive breakpoints, reduced-motion behavior, and forced-colors support. This is a diagnostic addition, not a redesign.

Add `apps/desktop/src/video/ProjectInspector.tsx`:

- hidden by default and toggled by `Ctrl/Cmd+Alt+D`
- rendered as an in-flow bordered panel below the project bar, not an obscuring modal or floating overlay
- includes a visible Close button, a heading, and a semantic `<dl>` for revision number/ID/hash, last command/group, snapshot revision, journal health, replay count, and recovery status
- wraps long identifiers, collapses to one column below the existing narrow breakpoint, remains operable at 320 CSS pixels and 200% text, and uses existing mono/data styles
- announces only health/recovery status changes through a restrained status region; it does not announce every revision field
- never displays full native paths, corrupted journal bytes, inverse payloads, or private diagnostics

A `degraded` recovery is also shown as a normal workspace alert outside the hidden inspector because possible lost edits are user-impacting. Clean recovery and migration details remain in the inspector. Update the header phase label to `Phase 2 · Canonical history` and update `apps/desktop/DESIGN.md` with the inspector/recovery states and evidence matrix.

Test shortcut suppression when form/media controls own focus, Close focus behavior, keyboard order, accessible names, axe states, narrow reflow, long hashes, forced colors, reduced motion, and no pointer-sticky focus. No new UI library, icon family, font, theme, card system, gradient, or decorative motion is introduced.

## Test plan

### TypeScript contracts and helpers

- V2 valid/invalid fixture parity, strict unknown-field rejection, safe integer/rate/fixed-point bounds, source unions, nested-sequence cycle fixture rejection, and unsupported future versions
- command-group, command-result, event, projection, inspector, journal-health, and recovery-report schema tests
- command builder emits no timestamps, summaries, hashes, paths, or authority-only fields
- V1 parsing remains stable; V2 response parsing rejects malformed native data
- renderable projection produces the unchanged single-clip FFmpeg plan

### Rust engine

- unit tests for every command's preconditions, result, inverse, summary, affected ranges, invalidations, and stable hash
- `proptest` split/trim/move sequences proving nonempty half-open ranges, reference integrity, non-overlap, unchanged source identity, and apply/inverse round trips
- grouped transaction all-or-nothing behavior and final-integrity rollback
- stale base, duplicate-identical idempotency, duplicate-conflict, safe-integer overflow, unknown ID, nested cycle, and malformed payload rejection
- commit/undo/redo round trips with strictly increasing revisions and restart-preserved stacks
- same snapshot/request produces the same JCS state and record hashes on repeated execution
- random `serde_json::Value` command/journal inputs never panic or bypass size/schema limits

### Persistence and recovery

- append is one compact UTF-8 NDJSON record plus newline and is synced before acknowledgement
- every crash failpoint reopens to exactly the last durable hash
- torn final byte ranges at every offset recover the valid prefix; newline-terminated corruption reports degraded recovery and never silently claims clean health
- record deletion, reordering, duplication, hash alteration, mismatched generation, stale snapshot, corrupt main snapshot, valid previous snapshot, missing sidecar, and journal-cap cases
- checkpoint replacement preserves the prior main file on injected promotion failure and can recover from the previous snapshot plus journal
- V1 migration fixtures for every V1 state listed above, idempotent V2 reopen, and original-byte preservation on migration failure
- path lock contention across two service instances, owner isolation, lifecycle release, project-relative containment, all-assets source resolution, missing sources, regrant, and relink

### IPC, controller, render, and UI

- production-shaped IPC reachability and strict malformed/stale/owner rejection for create/open/execute/undo/redo/query/relink/close
- complete mocked create/import grouped commit/trim/undo/redo/export/reopen workflow with monotonic revisions and no `video_save_project`
- stale async project/import/edit results cannot activate after a switch
- journaled command failure versus snapshot warning presentation
- active source preparation and Phase 1 render continue to work from V2 projection
- inspector hidden/toggle/close states, clean/recovered/degraded values, responsive long-content behavior, keyboard operation, and axe checks
- existing Phase 1 source recovery, controlled playback, cancellation, collision, export validation, and accessibility suites remain green

## Runtime and completion verification

- Launch the real Windows Tauri application from a clean build, create a V2 project, import the canonical fixture, apply trim, undo, redo, export, close, and reopen.
- Record revision number, state hash, snapshot revision, journal health, and recovery status before and after reopen; hashes must match.
- Force-terminate the application after a journal sync but before an injected test checkpoint, relaunch, and verify the acknowledged edit and undo/redo availability recover exactly.
- Repeat with a deliberately torn unacknowledged tail and verify recovery stops at the prior durable hash and reports the discarded tail.
- Open a Phase 1 V1 fixture, verify state/source preservation and the irreversible migration report, then reopen as V2 without a second migration.
- Verify missing, relink-required, and native relink source states without exposing source files through the asset protocol.
- Capture the inspector at 1280×800 and 480×360 plus a 320-CSS-pixel/200%-text stress state; manually verify keyboard toggle/close, focus visibility/return, long hashes, reduced motion, and Windows forced colors.
- Run axe against clean editor, recovered warning, degraded warning, inspector open, and project-in-use/error states; record automated output as defect detection rather than complete conformance.
- Measure command acknowledgement and reopen/replay time on a generated 10,000-operation journal and record the result. The resolved Phase 2 target is p95 command acknowledgement below 100 ms for the fixture on the verification machine and reopen below 2 seconds; a miss blocks completion and must be profiled rather than hidden.
- Run frozen install; root build/check/test/lint/format; Rust fmt, all-target/all-feature Clippy with warnings denied, default and `tauri-ipc-test` tests; unchanged real-FFmpeg integrations; `git diff --check`; and Windows `tauri build --no-bundle --ci`.
- Extend CI job names and assertions to describe the canonical engine/recovery work, and add an explicit repeated Windows crash-recovery test invocation so platform-specific lock/replace behavior cannot pass only on Linux.
- Store sanitized screenshots, recovery facts, hash/revision facts, failpoint matrix, performance measurements, and exact-SHA CI links under `apps/desktop/evidence/phase-2/verification.md`; never commit user paths, raw corrupted content, caches, lock files, journals from manual projects, or generated targets.
- Update `README.md`, `ROADMAP.md`, and `apps/desktop/DESIGN.md` only after the hard gate passes, including the `.svpvideo.data` portability requirement and V1 migration boundary.

## Risks and controls

- **Dual TypeScript/Rust schemas drift:** keep shared fixture manifests and make both suites accept/reject the same V1, V2, command, projection, and recovery cases.
- **Acknowledging before durability:** centralize all mutation through one append/flush/sync/publish function and inject failure at every boundary.
- **Atomic rename overclaim:** sync temp contents explicitly, preserve a previous valid snapshot, test Windows behavior, and claim only observed recovery guarantees.
- **Corrupted-tail data loss hidden from users:** preserve/report the invalid tail boundary, mark recovery degraded, and show a visible workspace warning.
- **Unbounded journal growth:** enforce the 64 MiB cap and record the no-compaction Phase 2 decision; design anchored compaction before ever deleting records.
- **History snapshots becoming JSON patches:** persist typed forward/inverse semantic commands only; no Immer patch or arbitrary JSON pointer enters the public language.
- **Nested-sequence cycles or mixed-rate ambiguity:** use a graph validator and exact rational equality/rescaling checks before journaling.
- **Path authority leaking back to the webview:** derive sidecar paths in Rust, require grants for asset source mutations, and expose only sanitized source status/projection data.
- **Two writers:** hold an exclusive sidecar lock for the whole session, reject contention, and route lifecycle/project switching through service close.
- **V1 history cannot be reconstructed:** preserve current selected state exactly and report one explicit irreversible migration/history-reset boundary instead of inventing commands.
- **Snapshot failure after durable command:** return success with unhealthy checkpoint status and rely on journal replay; retries remain idempotent by group ID.
- **Phase 2 turning into a professional timeline:** implement and test the domain commands and projections, but keep production UI changes to the existing single-clip flow, relink recovery, and hidden inspector.

## Expected file map

Primary new or substantially changed paths:

```text
packages/video-contracts/src/
  project.ts                  # retained V1 exports/dispatcher
  project-v2.ts
  project-commands-v2.ts
  project-service.ts
  project-io.ts
  migrations.ts
  *.test.ts
packages/video-contracts/fixtures/project-v2/
packages/video-contracts/fixtures/migrations/

packages/video-project/src/
  command-group.ts
  projection.ts
  legacy-v1.ts                # compatibility only
  *.test.ts

packages/video-render/src/
  compile-render-plan.ts
  compile-render-plan.test.ts

apps/desktop/src-tauri/src/video/project/
  mod.rs
  types.rs
  integrity.rs
  commands.rs
  history.rs
  hash.rs
  journal.rs
  snapshot.rs
  migration.rs
  recovery.rs
  service.rs
  ipc.rs
  tests.rs

apps/desktop/src-tauri/src/video/
  mod.rs
  project_io.rs
  grants.rs
  error.rs
  types.rs
apps/desktop/src-tauri/src/lib.rs
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/Cargo.lock

apps/desktop/src/
  video-ipc.ts
  video-ipc.test.ts
  use-video-project.ts
  use-video-project.test.tsx
  video/ProjectInspector.tsx
  video/ProjectInspector.test.tsx
  video/VideoWorkspace.tsx
  video/AssetPanel.tsx
  video/workflow.integration.test.tsx
  video/accessibility.test.tsx
  App.tsx
  App.css

.github/workflows/ci.yml
README.md
ROADMAP.md
apps/desktop/DESIGN.md
apps/desktop/evidence/phase-2/verification.md
```

## Steps

1. Run and record the complete Phase 1 baseline gates before changing contracts, separating any pre-existing failure from Phase 2 work.
2. Add pinned `serde_json_canonicalizer 0.3.2` and dev-only `proptest 1.11.0`, update `Cargo.lock`, and verify license/MSRV/locked builds.
3. Add strict TypeScript V2 snapshot, state, entity, projection, command-group, result, event, journal-health, inspector, and recovery schemas while retaining V1 dispatch and exports.
4. Add shared V2 and V1-to-V2 migration fixture manifests covering valid, malformed, future, nested, missing-source, relative, absolute, trimmed, and undone-current projects.
5. Replace production `@supa-video/project` V2 mutation exports with command-group builders and projection/render selectors, retaining isolated V1 compatibility helpers only for migration tests.
6. Create the Rust `video/project/types.rs`, `hash.rs`, and `integrity.rs` mirrors, then prove TypeScript/Rust fixture parity and deterministic RFC 8785 SHA-256 hashes.
7. Implement the Rust semantic command registry for import/create/insert/remove/split/move/trim/transform/gain/marker/relink, including preconditions, inverses, summaries, affected ranges, invalidations, and transaction rollback.
8. Implement monotonic revisions, command-group idempotency, and durable semantic undo/redo stack transitions in `history.rs`, with unit and property round-trip tests.
9. Implement bounded sidecar derivation, session-long `fs4` locking, append/flush/sync NDJSON records, record hash chains, and strict journal scanning/tail classification.
10. Implement durable periodic snapshots, previous-snapshot preservation, platform-aware atomic replacement, checkpoint thresholds, and injected promotion failure tests.
11. Implement V1 migration, snapshot selection, replay, journal repair, recovery reports, and the full crash-failpoint matrix proving recovery to an exact durable hash.
12. Implement `VideoProjectService` owner sessions and create/open/execute/undo/redo/query/relink/close operations, including all-assets source resolution and lifecycle cleanup.
13. Register the new Tauri IPC surface and production-shaped mock tests, then remove `video_save_project` from production registration once no caller depends on arbitrary document saves.
14. Extend frontend IPC adapters and strict response parsing for V2 projections, operation identities, recovery state, and native project-service errors.
15. Refactor `use-video-project.ts` to create/open/import/trim/undo/redo/close through the Rust service while keeping drafts, playhead, preparation, render jobs, and stale async guards ephemeral.
16. Adapt the pure render compiler and existing single-clip workspace selectors to V2 renderable projections without changing validated FFmpeg argument order or Phase 1 export behavior.
17. Add native relink integration and update source-state handling so missing/relink-required V2 assets recover through grants without exposing source URLs.
18. Add the hidden in-flow `ProjectInspector`, degraded-recovery alert, Phase 2 header label, responsive/focus/forced-color styling, component tests, workflow tests, and axe coverage using the existing design system.
19. Add generated 10,000-operation performance coverage, repeated Windows crash-recovery CI proof, and update CI labels/gates without weakening existing Phase 1 media tests.
20. Run the full TypeScript, Rust, Tauri, FFmpeg, formatting, lint, diff, accessibility, performance, and clean-build gates; fix every regression and rerun affected gates.
21. Execute the real Windows create/import/edit/undo/redo/force-terminate/recover/migrate/relink/export flow and capture sanitized desktop, narrow, 200%-text, inspector, and recovery evidence.
22. Update `README.md`, `ROADMAP.md`, `apps/desktop/DESIGN.md`, and `apps/desktop/evidence/phase-2/verification.md` with exact hashes, measurements, screenshots, limits, portability rules, and CI evidence only after the Phase 2 hard completion gate passes.
