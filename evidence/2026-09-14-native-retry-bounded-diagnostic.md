# Native retry readiness: bounded diagnostic, unresolved

## Outcome

No permanent code correction is justified by this experiment. The focused retry-cancellation baseline and the instrumented 32-thread suite passed. The historical retry-readiness, acknowledgement-p95, and Windows supervisor failures remain independently **unresolved**, not fixed by a passing rerun.

The first full diagnostic invocation failed to compile because temporary instrumentation used an incorrect module path in the scheduler test module. No tests ran in that invocation. The user explicitly authorized exactly one replacement invocation after the path correction. That replacement passed. There were no further Cargo invocations.

All temporary instrumentation was removed. The five touched source files match their captured baseline SHA-256 hashes exactly. This report is the only lasting change from this work; pre-existing work remains intact. No commits, publishing, dependency changes, timeout increases, assertion relaxation, or Roadmap changes were made.

## Scope and baseline

Approved plan: `.gg/plans/approved/7ea15007-dcba-465f-8cac-219cad1cc2c6.md`.

HEAD: `b21a303c51c258d3aa63fa51217bcbb4508fef0f`.

The worktree was already dirty. Scheduler/store hashes matched the known baseline recorded in `2026-09-14-acknowledgement-parallel-attribution.md`. The scheduler diff's retained start-transition fixture matched the separate existing deterministic-start-transition evidence. Process, journal, and project tests had no initial diff. The current Cargo changes and the jobs module's cancellation changes were preserved, not introduced here.

Full relevant baseline diff and hashes were captured in local foreground log `664269ea-5698-44b7-8275-4969d5e1d827.log`. The jobs-module diff and journal/project-test baseline hashes were captured in `32defcf1-d22d-458a-ad4c-b8390f83d90e.log`. Status and diff statistics were also inspected before editing.

All local logs named here reside under `C:\Users\SPARTAN PC\.gg\foreground\`. They are external local evidence, not repository artifacts or portable CI links.

## Ranked hypotheses shown before execution

1. Repeated readiness reads/open-close operations compete with the durable retry transition. Trace overlap and connection lifetime boundaries.
2. Blocking-runtime or host scheduling delays consume the readiness deadline. Separate submission-to-entry from operation wall time.
3. The scheduler fails before registering retry sleep. Trace dispatch, worker return, transition results, and sleep construction for the specific fixture job.
4. Acknowledgement and supervisor failures are independent load effects. Keep independent measurements; do not infer a shared cause without evidence.

## Executed test commands and exits

### 1. Focused uninstrumented baseline — exit 0

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::jobs::scheduler::tests::cancellation_interrupts_each_automatic_retry_delay_without_requeue -- --exact --nocapture --test-threads=1
```

- 1 passed, 0 failed, 326 filtered out; library test time 0.38 s.
- Build preparation reported 2 m 34 s and initially waited for the package-cache lock.
- Log: `04e5f7e0-2311-4e64-a739-a3bc200eb516.log`.

### 2. First diagnostic invocation — exit 101, compilation failure

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=32
```

- Six E0433 errors: temporary `super::store::diagnostic` references inside the nested scheduler test module could not resolve `store`.
- This was an instrumentation mistake, not a reproduced application failure.
- Corrected those diagnostic references to the crate-qualified path. Stopped and obtained explicit authorization for one replacement full invocation before executing it.
- Log: `b331d0b5-3b89-44f4-8df5-4d929f793f59.log`.

### 3. Authorized replacement diagnostic — exit 0

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=32
```

- 307 library tests passed, 0 failed, 20 pre-existing ignored; library test time 88.00 s.
- 5 integration tests passed; main and doc-test targets had 0 tests.
- Build preparation reported 3 m 39 s; total command elapsed 317.446 s.
- Retry-cancellation, acknowledgement-p95, and supervisor timeout/descendant/pipe tests all reported `ok`.
- Log: `c33f8a2c-3907-4ebc-9bf8-e2c546560486.log`.
- Existing Windows symlink assertions reported OS error 1314 and skipped those assertion branches. The suite pass does not verify those branches.
- The logged panic at `project/ipc.rs:484` is the intentional panic in `project_ipc_worker_failure_remains_a_typed_error`, whose purpose is checking typed worker failure handling; it is not an independent suite failure.

## Temporary tracing and limits

One tag, `[DBG-native-93bd]`, covered test-only buffers capped at 4,096 records per buffer, with an overflow count and deferred printing on drop. Stages used fixed labels and monotonic microsecond offsets. No payloads, paths, job identifiers, or process command lines were added to trace output.

- Retry trace selected one fixture job per iteration. It recorded readiness reads, blocking submission/entry, connection open/configure, query return, post-connection-drop scope completion, transition commit and return, worker outcome return, and injected-clock sleep construction.
- Acknowledgement trace was thread-local to the existing 100-call performance fixture and bracketed the journal stages without changing the existing measured interval or budget.
- Process buffers recorded supervisor entry, spawn return, execution timer creation/firing, timeout settlement return, and separate kill/wait/pipe-join boundaries. These covered supervised commands generally, not only the target test.
- Reconstructed stderr contains 3 retry buffers, 1 acknowledgement buffer, 240 supervisor buffers, and 9 settlement buffers; all overflow counts are zero.
- Buffers used independent origins. Process buffers have no per-invocation correlation ID, so independently printed settlement buffers cannot be conclusively paired with supervisor buffers merely by adjacency.
- Read and connection markers for overlapping operations share the job buffer without per-operation IDs. Exact pairing of every concurrent connection interval is not supported.
- Markers bracket close indirectly: query/commit return before close, then scope/synchronous-function return after close. Those gaps include scheduling and intervening Rust work, not just SQLite close time.
- Instrumentation adds clock, mutex, allocation, and output overhead. It can perturb scheduling. These are instrumented wall-time observations, not OS wait attribution or an uninstrumented final gate.

## Observed retry readiness

Offsets below are milliseconds from each iteration's trace-buffer creation; iterations exercise the original 1/5/30-second injected delays.

| Injected delay | Readiness begins | Retrying transition submitted | Blocking entry | Sync return after connection close | Transition await returns | Sleep constructed | Readiness satisfied |
| -------------- | ---------------: | ----------------------------: | -------------: | ---------------------------------: | -----------------------: | ----------------: | ------------------: |
| 1 s            |            0.055 |                        86.947 |         86.972 |                            161.573 |                  161.867 |           161.875 |             180.572 |
| 5 s            |            0.044 |                       104.319 |        104.357 |                            135.926 |                  136.000 |           136.011 |             208.183 |
| 30 s           |            0.040 |                       104.499 |        104.621 |                            167.593 |                  167.686 |           167.694 |             181.340 |

Readiness elapsed approximately 180.517, 208.139, and 181.300 ms, all below the unchanged two-second deadline. Retrying-transition submission-to-blocking-entry took 0.025, 0.038, and 0.122 ms. Blocking operation wall times were 74.601, 31.569, and 62.972 ms.

Readiness polling overlapped durable transitions, but overlap alone does not establish contention as the cause of a historical timeout. All three observed transitions returned successfully, followed by sleep construction and successful readiness. No traced worker-settlement error occurred. The unchanged cancellation, idle, exactly-once, and no-requeue assertions passed.

**Conclusion:** none of hypotheses 1–3 was demonstrated as a failure mechanism. No notification-based readiness rewrite or store connection-lifecycle change was made.

## Independent acknowledgement result

The original test reported debug p95 **268.8893 ms**, below the unchanged **300 ms** gate. This is not a resolution of the historical p95 failure. Release performance was not measured.

The outer diagnostic markers reconstruct 100 complete seven-stage call sequences with monotonic offsets. Their p95 is 268.890 ms, slightly wider than the original measurement. Four individual outer intervals exceed 300 ms:

| Zero-based call | Total ms | Before append | Hash/serialize | Metadata/open | Write/flush |    Sync | After sync through execute return |
| --------------- | -------: | ------------: | -------------: | ------------: | ----------: | ------: | --------------------------------: |
| 60              |  833.618 |         7.785 |          3.893 |         0.194 |      57.317 |  20.279 |                           744.150 |
| 61              | 1004.335 |       267.145 |          3.750 |       183.574 |       0.264 | 548.742 |                             0.860 |
| 62              | 1094.578 |       841.383 |          3.704 |       149.491 |       0.129 |  83.447 |                            16.424 |
| 63              | 1534.500 |       151.636 |          3.854 |        64.244 |     645.711 | 634.926 |                            34.129 |

These stages contain wall-clock tails in multiple places. The last column includes file close and subsequent service work, not only append return. No OS trace distinguishes storage latency from scheduling/host delays. Individual slow calls do not fail a p95 contract. No sync, replay/hash-chain, or durable-before-acknowledgement behavior was changed.

The first log-analysis probe could not parse interleaved stdout/stderr. Reconstructing stderr resolved that, followed by a probe assertion failure caused by retaining a mutable reference to the last call's list while the final scope-drop marker was appended. The corrected read-only parser copied completed call lists and verified exactly 100 ordered seven-stage sequences. It exited 0 (`1921d521-0328-4102-a3df-a117eec95ef0.log`). These were log-processing commands, not test reruns; original logs were not altered.

## Independent supervisor result

The existing `supervisor_timeout_terminates_grandchild_and_releases_inherited_pipes` test passed with its 1,500 ms execution timeout and three-second outer watchdog unchanged. Its existing ready-marker, timeout result, inherited-pipe completion, and descendant-survival assertions remained in place.

One observed supervisor timeline, consistent with the 1,500 ms execution timer, records:

| Stage                      | Offset ms |
| -------------------------- | --------: |
| Supervisor entry           |     0.014 |
| Spawn returns              |   397.487 |
| Execution timer created    |   397.531 |
| Execution deadline fires   |  1908.848 |
| Timeout settlement returns |  1987.347 |

This demonstrates successful progress in this run, not the cause of the historical watchdog failure. Separate settlement buffers record kill/wait and both pipe-join boundaries, but lack identifiers for exact cross-buffer pairing. No process-ownership rewrite or supervisor fix was made.

## Restoration and final verification

Temporary additions were reversed with targeted edits, not a worktree reset. Before and after SHA-256 values match:

| File (under `apps/desktop/src-tauri/`) | Baseline = restored SHA-256                                        |
| -------------------------------------- | ------------------------------------------------------------------ |
| `src/video/jobs/scheduler.rs`          | `644a36463da82746864bff1a3276b98a3168898b96723b9f3f68388515bb9e79` |
| `src/video/jobs/store.rs`              | `0895b06f663bfb4273f98d34ea17f5739b618ee23a2bc1cd588735c4f2f8a353` |
| `src/video/process.rs`                 | `f8f8c76dc3cd7ac455bb2c8e315a041aeddc7f4c62672fe63dc23d1ed849f38b` |
| `src/video/project/journal.rs`         | `7aa2bac531ce4a10bd592c6dbc602f217653c86923aa70c786d5d0da3abe7edb` |
| `src/video/project/tests.rs`           | `100aa507a72f43dcfe509e49575629e40b35150b1a4740f6ebbddc803f466b90` |
| `src/video/jobs/mod.rs` (not edited)   | `0583e10de2ae215976e69d27669619065d4f958dbbbe05d17dbec074aac1b2fd` |
| `Cargo.toml` (not edited)              | `96da3a4c6998477fdd124e35fc3031bf2a02694daf3b0846fbe6c80ae9de1e40` |

- Full relevant Cargo/scheduler/store/process diff equals the captured initial diff, programmatically checked with exit 0 (`279fd508-9058-4ac5-a9db-b543948ae505.log`).
- Journal, project tests, and process remain without a git diff.
- Source search for the diagnostic tag and helper references found no matches.
- `git diff --check` produced no errors after restoration; status/stat returned to the pre-existing dirty baseline before this report was added.
- No cause-specific dependency-source/corpus research or deterministic regression was pursued: the prerequisite failing mechanism was absent.
- Steps 5–6's permanent correction, regression red/green, affected-test run, Rust formatting check, Clippy, and uninstrumented final 32-thread gate were **not run**, as required by the no-permanent-change branch. Hash restoration is not presented as a fresh uninstrumented suite pass.

## Primary log hashes

| Log                        | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| Focused baseline           | `9073be0977037a16e16c28aa41e41a4e599d5adef4eece7af6ec616ba520f834` |
| Diagnostic compile failure | `a00249ca420167fa37a61472f31f2a678e6f37cfe4cda93dd46d220c9c98e0e7` |
| Authorized replacement     | `81b372a66db1456722029c9d4b25f9bb3991c7405a3f4adea8087e49bfbe5b91` |

## Stop boundary

Steps 1–4 and the report/restoration branch of step 7 are complete. Steps 5–6 are not applicable without an evidence-backed correction. All three historical issues remain unresolved. Any further full-suite experiment or redesign needs a new reviewed scope; this report does not authorize it or any lifecycle/status change.
