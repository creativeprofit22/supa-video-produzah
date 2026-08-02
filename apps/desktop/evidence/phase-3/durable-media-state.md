# Phase 3B durable media state evidence

## Status

Phase 3B implementation is present at exact audited baseline `3fd99757c16e9932c042400dab9c946b47718ddd`. Source, pagination, browser, packaged IPC, bundled-resource, performance, no-bundle assembly, and literal assembled Windows runtime gates now pass locally in the closure worktree. This checkpoint remains **in verification/closure** only because an executing exact-SHA CI run is still outstanding. Phase 4 is not unblocked.

## Dependency and storage baseline

- `rusqlite` is exactly pinned to `0.40.1` with default features disabled and `bundled` enabled.
- Cargo resolves `libsqlite3-sys 0.38.1`; the bundled feature compiles and links vendored SQLite instead of relying on a platform installation.
- The effective Rust minimum is 1.94 because the bundled SQLite graph uses `std::cfg_select!` in its build script.
- `media-state-v1.sqlite3` is rooted in application local data, separate from managed cache bytes and authoritative project snapshots/journals.
- Connections enable foreign keys, a two-second busy timeout, WAL journaling, `synchronous=FULL`, and bounded WAL autocheckpointing.
- Application ID and `user_version=1` reject unrelated databases and unsupported downgrades.
- V1 owns constrained job, event, cache-artifact, lease, and setting tables plus query indexes. The versioned default managed-cache budget is 20 GiB.

## Durable job and scheduler implementation

- Strict TypeScript and Rust DTOs cover list, event, cancel, retry, cache status, lease, and legacy cleanup operations without exposing private paths or raw process output.
- Preparation is represented as one parent with proxy and thumbnail children; final render has one durable generated job UUID while preserving the requested render `planId` as separate identity.
- Job and event mutation is transactional in SQLite. The scheduler uses bounded FFmpeg/blocking-I/O permits, deterministic priority/FIFO aging, deduplication, cancellation, automatic/manual retry, and startup recovery.
- Fresh source or output authorization is represented as an explicit blocked state instead of persisting stale filesystem grants.
- Subscribe-before-snapshot reconciliation and event sequencing keep the frontend projection durable while avoiding progress-tick announcements.

## Cache and legacy policy

- Managed objects and derived artifacts remain under the Phase 3A content-addressed app-cache tree; exact-path validation, per-key locks, post-lock validation, and partial cleanup remain enforced.
- The catalog tracks artifact size/use, active-session leases, and deterministic unleased LRU eviction. Current playback leases protect active media; cache misses regenerate deterministic artifacts without changing project or asset identity.
- The old `$APPCACHE/video-phase1` tree is inventory-only. It is neither migrated nor removed automatically and clears only after visible user confirmation.

## Job Center implementation

- The app-level Job Center is available with or without an open project and displays ordered parent work, child stages, recovery actions, cache pressure, and legacy inventory.
- Native buttons, semantic headings/lists, visible focus, aggregated polite status, forced-colors rules, reduced-motion rules, long-content wrapping, and narrow-layout behavior are implemented.
- Browser evidence covers 1280x800, 480x360, 320 CSS pixels at 200% text, keyboard focus, reduced motion, forced colors, Axe, horizontal overflow, pagination pending/failure/retry/no-more states, and long equal-timestamp content.
- Pagination now uses the native `(updated_at_ms, id)` order end to end, requires both cursor parts, fetches one extra row to prove continuation, merges by durable UUID, and refetches the exposed page depth after live/focus reconciliation.

## 28 July 2026 closure verification

Passed locally in the closure worktree:

- frozen install and root build/check/test/lint/format;
- 204 TypeScript/Vitest tests: 54 contracts, 26 media, 8 project, 10 render, and 106 desktop;
- 13 Chromium responsive/accessibility tests;
- Rustfmt and all-target/all-feature Clippy with warnings denied;
- 171 non-ignored Rust tests across the all-feature library and security suites;
- all 11 explicit real-FFmpeg tests;
- all three original stripped-`PATH` packaged tests, each in its own process;
- three explicit Phase 3B bundled-resource wrappers for hierarchy/restart, render recovery/cancellation, and cache/legacy policy;
- staged FFmpeg verification and Windows Tauri no-bundle assembly;
- five release performance gates;
- `git diff --check`.

Latest measured release results:

| Gate                                         |        Result |
| -------------------------------------------- | ------------: |
| Generated 10,000-record project journal scan | `699.8438 ms` |
| Durable command acknowledgment p95           |   `4.8993 ms` |
| Media-job enqueue plus durable event p95     |  `11.5919 ms` |
| List 100 recent jobs                         |   `4.6878 ms` |
| Recovery selection across 10,000 jobs        |   `2.6108 ms` |

## Packaged and bundled proof

The two audited failures are repaired:

1. `packaged_media_app` initializes `MediaJobService` from the mock Tauri app's resolved local-data and cache roots, asserts database containment, uses a unique application identifier, shuts down the service, and cleans both owned roots.
2. Packaged render tests parse the generated durable job UUID, assert it differs from `planId`, cancel by that UUID, and require every compatibility event to preserve both identities with exactly one terminal event.

With `PATH` stripped to Windows system directories, the assembled Gyan FFmpeg 8.1.2 overlay passed status/probe/prepare/render completion, executable replacement rejection, render cancellation and partial cleanup, hierarchical preparation, all three restart boundaries, final-render reauthorization/retry, AV/video-only output, collision preservation, cancellation/process cleanup, cache leases/LRU/cache-miss repair, and legacy inventory/confirmed clear. The CI workflow names and executes every proof individually after assembly with proof-specific failure text.

## CI status

Exact-SHA Actions run [`30320315684`](https://github.com/creativeprofit22/supa-video-produzah/actions/runs/30320315684) targeted `3fd99757c16e9932c042400dab9c946b47718ddd` and created TypeScript, Rust, and Windows jobs, but every job executed zero steps because of the external account billing/spending block. No exact-SHA pass is claimed; the Phase 2 run remains the last completed successful CI proof.

## Literal runtime observation

The assembled no-bundle Windows executable launched with a stripped `PATH` and bundled Gyan FFmpeg 8.1.2. The literal gate imported a generated 180-second fixture, force-terminated the app while its proxy child was running, relaunched, and observed the same parent/proxy/thumbnail IDs reach exactly one completion. The recovered proxy and thumbnail passed bundled `ffprobe`; no FFmpeg/FFprobe descendant or owned partial remained after completion.

ExportPanel and Job Center then exercised cancellation, process-death blocking, a cancelled native save picker, exact-destination reauthorization, retry on the same durable job/plan/revision, and verified completion. Independent event inspection found exactly one terminal event for each cancellation/recovery stream. Process and `.svp-part-*` / `.derive-*.part.*` checks were empty after settlement.

Job Center visibly showed three active leases totaling 548,614,045 bytes. Under the deterministic test budget, six unleased entries evicted in catalog LRU order while all three leased artifacts remained. Removing the active proxy produced a cache miss; assembled-app regeneration preserved project ID, asset ID, source digest, and proxy key. Legacy inventory survived restart and cleared only after the visible confirmation dialog.

The first literal run exposed and drove fixes for a concurrent SQLite transition race and owned final-render partial cleanup on fresh reauthorization. The assembled executable was rebuilt and every literal scenario was rerun. Sanitized IDs, hashes, probes, cache totals, event counts, residue checks, exact commands, and screenshot hashes are in [`assembled-windows-runtime-closure.md`](./assembled-windows-runtime-closure.md). `assembled-job-center-runtime.png` remains the earlier empty-profile launch capture; it is not used as recovery proof.

No private paths, raw process output, assistive-technology, or field-performance claim is made.

## Remaining closure gate

Phase 3B remains in progress until an exact-SHA GitHub Actions run executes and passes its TypeScript, Rust, and Windows jobs.

Service tests, packaged IPC tests, and literal app observations are labeled separately. Private paths and raw process output are excluded from evidence.
