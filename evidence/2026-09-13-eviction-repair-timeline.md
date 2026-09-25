# Failed eviction and repair: actual SQLite errors and worker outcome

## Single requested execution

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=32
```

Execution `75b3601c-854e-4b28-83a6-0db7a4ffe4a0`, independent exit **0**. Library: **307 passed, 0 failed, 20 pre-existing ignored**, 70.95s. Security integration: **5 passed**. Whole command: 125.778s including compilation/startup. No overlapping agent-run tests/builds or subsequent test reruns.

Complete sanitized log:
`C:/Users/SPARTAN PC/.gg/foreground/75b3601c-854e-4b28-83a6-0db7a4ffe4a0.log`

The original ten-second receive did **not** time out. The historical cache receive failure and supervisor timeout therefore remain unresolved; this passing instrumented run is not a fix. P2 remains open and no Roadmap status changed.

## Diagnostic scope and preservation

Only the evictor clone in `failed_eviction_reconciles_after_both_database_waits` enabled an instance-local cfg(test) timing origin. Logs recorded connection setup, immediate-transaction acquisition, eviction result, repair result, and worker result including actual error details. No fault injection was added.

The worker sent its original typed result through the original channel and also returned a diagnostic String copy through its existing thread join. The test still waited ten seconds on the original receive, released the writer, joined the worker, and asserted the **original** receive result. A late result could be reported after join without turning a receive timeout into a pass. No extra observation timeout or production behavior change was introduced. Existing assertions were retained.

Full diagnostic patch: `02517c25-c687-415b-bfe5-c9ef3e3e581e.log`, from direct `git diff --binary -- apps/desktop/src-tauri/src/video/cache.rs`, exit 0.

## Captured timeline

Elapsed time starts after the fixture acquired its existing writer transaction, immediately before spawning the eviction worker.

| Event                                                        | Elapsed                       |
| ------------------------------------------------------------ | ----------------------------- |
| Original receive begins, limit=10s                           | 0.0000619s                    |
| Eviction begins                                              | 0.0014439s                    |
| Eviction connection open/configuration                       | 0.0039366–0.0255551s, success |
| Eviction immediate transaction requested                     | 0.0257149s                    |
| Eviction transaction acquisition returns error               | 5.8200357s                    |
| Eviction error propagates after guards unwind                | 5.9117881s                    |
| Repair begins                                                | 5.9122888s                    |
| Repair connection open/configuration                         | 5.9123085–5.9158527s, success |
| Repair immediate transaction requested                       | 5.9158890s                    |
| Repair transaction acquisition returns error                 | 8.7228436s                    |
| Repair error propagates                                      | 8.7234219s                    |
| Worker produces its result                                   | 8.7234842s                    |
| Original receive returns Ok(Err(...)); writer release begins | 8.7236764s                    |
| Writer release complete; join begins                         | 8.7237592s                    |
| Join returns the retained worker result                      | 8.7237775s                    |
| Post-release state inspected                                 | 8.7238611s                    |

Both immediate-transaction acquisitions returned the actual SQLite error:

```text
SqliteFailure(Error { code: DatabaseBusy, extended_code: 5 }, Some("database is locked"))
```

Acquisition intervals: eviction approximately **5.794321s**, repair approximately **2.806955s**. The log stage was named `*_transaction_acquired`, but both results were errors: neither transaction was acquired, and neither path reached commit/unlink in this worker attempt. Connection setup succeeded before each wait. These wall-clock intervals include scheduling and SQLite busy-handler behavior, not just CPU execution.

`evict_reserved_candidate` returned the repair error via its existing propagation path. The join retained:

```text
Err(Sqlite(SqliteFailure(Error { code: DatabaseBusy, extended_code: 5 }, Some("database is locked"))))
```

## Post-release outcome

Immediately after releasing the writer and joining:

- Catalog state: `Ok(Some("reserved"))`.
- Artifact file still existed.
- One failed-eviction repair obligation remained queued.
- The worker's retained error matched the channel result and had been produced before release, not after a receive timeout.

The original remainder of the test passed: a further blocked repair retained its obligation, subsequent status reconciled successfully, the other active reservation remained protected, the failed candidate could be evicted, and the active worker eventually succeeded. Those later operations used the original non-diagnostic cache instance; they are assertion evidence, not individually timestamped operations.

This run does not exercise the diagnostic late-result branch following a receive timeout. It cannot supply a post-timeout outcome for earlier failing runs. No root-cause fix is claimed.

## Restoration

The temporary diagnostics and diagnostic result retention were removed after preserving the log. Before editing, `git diff --exit-code -- apps/desktop/src-tauri/src/video/cache.rs` returned 0 (`2de9119d-e516-4464-a581-60c753d562e3`). The same command after restoration returned 0 (`3b689e64-9dfa-4606-bf2b-db84ed76dcd6`), confirming exact restoration relative to the unchanged HEAD version of that file. Earlier dirty changes in other files were not touched. No post-restoration test pass is claimed. This report is the only retained addition from the diagnostic task.
