# Phase 2 verification

**Date:** 26 July 2026
**Baseline:** `a0a636995a453789b46640512aa9bccb4ed89c31`
**Implementation worktree diff SHA-256:** `e7c5f5c0c5f18a7d5f89319b7e97872b5faef47aff4006125852283a7e065904` before this evidence/documentation update
**External CI:** unavailable until this implementation worktree is committed and pushed

## Outcome facts

- Rust is the only V2 mutation authority.
- A successful command response follows journal append, flush, and `sync_all`.
- Commit, undo, and redo produce monotonic revisions.
- V1 migration preserves the selected state and resets unreconstructable legacy history at one explicit irreversible boundary.
- Reopen after commit, undo, redo, clean close, and a new service instance returned revision **3** and exact state hash `5290a23aa47cd89256a9cf1d31eaf4a7dfee0f9b2eaaf480a3eeda973f4213de`.
- A torn final journal line recovered the prior exact snapshot hash, repaired to a clean prefix, and reported recovered status.
- A second service instance cannot acquire the active project's advisory lock.
- React sends authority-free command groups and activates only validated native projections.

## Storage contract

A portable project is both:

```text
My Project.svpvideo
My Project.svpvideo.data/
```

The sidecar contains `project.lock`, `journal.ndjson`, and `snapshot.previous.svpvideo`; `recovery-report.json` appears after recovery or migration reporting. The journal is persistent project data, not cache.

| Limit                                |                 Value |
| ------------------------------------ | --------------------: |
| Snapshot                             |                16 MiB |
| Journal                              |                64 MiB |
| Journal line / command-group request |                 1 MiB |
| Commands per group                   |                   100 |
| Checkpoint interval                  | 25 durable operations |

Phase 2 deliberately retains the complete journal hash chain and performs no compaction.

## Automated gates

| Gate                                                     | Result                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Frozen pnpm install                                      | Passed                                                                            |
| Root build and TypeScript check                          | Passed                                                                            |
| Contracts                                                | 44 passed                                                                         |
| Browser-safe project helpers                             | 7 passed                                                                          |
| Render compiler                                          | 10 passed, including unchanged V2 FFmpeg argv                                     |
| Desktop IPC/controller/components/workflow/accessibility | 48 passed                                                                         |
| ESLint and Prettier check                                | Passed                                                                            |
| Rust formatting                                          | Passed                                                                            |
| All-target/all-feature Clippy with `-D warnings`         | Passed                                                                            |
| Rust default suite                                       | 75 passed plus 2 security tests; 7 system tests ignored by the default invocation |
| Rust all-feature suite                                   | 81 passed plus 2 security tests; 8 system tests ignored by the default invocation |
| Real FFmpeg probe                                        | Passed                                                                            |
| Real FFmpeg preparation/reuse/repair                     | Passed                                                                            |
| Real FFmpeg AV/video-only export                         | Passed                                                                            |
| Real FFmpeg cancellation/process/partial cleanup         | Passed                                                                            |
| Windows Tauri `build --no-bundle --ci`                   | Passed; produced `supa-video-desktop.exe`                                         |
| `git diff --check`                                       | Passed                                                                            |

Axe Core reported zero applicable WCAG A/AA/2.2-tagged violations in the opener, ready editor with inspector, degraded recovery warning, running export, and overwrite dialog states. Automated scanning is defect detection, not full conformance proof.

## Performance

Measured in optimized Rust on this Windows machine:

| Scenario                                                    | Measurement |     Gate |
| ----------------------------------------------------------- | ----------: | -------: |
| Durable command acknowledgment p95, 100 synced trim commits |  **2.9 ms** | < 100 ms |
| Scan and verify generated 10,000-record journal             |  **656 ms** |    < 2 s |

Both gates passed. Debug-mode thresholds are looser only to keep ordinary unit-test builds useful; CI separately runs the release-mode budget tests.

## Windows and visual evidence

The production executable launched with a real native window titled **Supa Video Producer**. The same Windows build passed native source probe, controlled preparation, verified render, and cancellation integrations.

Representative sanitized captures:

- [`opener-native-1280x800.png`](./opener-native-1280x800.png)
- [`opener-native-480x360.png`](./opener-native-480x360.png)
- [`inspector-1280x800.png`](./inspector-1280x800.png)
- [`inspector-480x720.png`](./inspector-480x720.png)
- [`inspector-320x800.png`](./inspector-320x800.png)

The inspector capture uses deterministic sanitized projection data injected into the compiled UI for visual review only. It proves the actual component CSS and responsive composition, not native persistence. Native persistence is proven separately by Rust service/IPC/recovery tests.

### Rendered critique

Quality rubric score: **22/24**. Accessibility, consistency/flow, responsive behavior, state completeness, and content authenticity each scored at least 2. The weakest first pass was desktop fact-grid rhythm: the state hash spanning two columns left an unused cell. The span was removed so all nine facts now form a uniform three-by-three grid, then the desktop and narrow captures were regenerated. No decorative element was added; the existing bordered data grid is the only diagnostic device.

Visual review found:

- desktop facts align in a stable three-column grid;
- long revision IDs and SHA-256 hashes wrap without horizontal overflow;
- 480 px uses two columns;
- 320 px uses one column with full-width New/Open/Close controls;
- the panel stays in document flow and never obscures the workbench;
- forced-colors and reduced-motion have explicit CSS paths;
- no native paths, inverse payloads, journal bytes, or sidecar names appear in the inspector.

## Recovery matrix covered

- clean journal EOF;
- torn unterminated tail and exact-prefix repair;
- malformed/hash-broken tail classification;
- compatible main/previous snapshot selection;
- missing sidecar recreation;
- session lock contention and release;
- atomic snapshot failure before and after promotion;
- grouped transaction rollback;
- stale revision and duplicate-payload conflict;
- commit/undo/redo stack survival across close and reopen;
- V1 selected-state migration and idempotent V2 reopen.

## Remaining boundary

Phase 2 does not implement professional multitrack interaction or journal compaction. The production workspace intentionally displays and prepares only the active single clip while the canonical V2 domain and native service support the broader entity model.
