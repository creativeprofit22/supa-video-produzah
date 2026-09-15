# Deterministic start-transition retries, with separate SQLite contention coverage

## Change

`transient_start_transition_failures_requeue_and_complete_once` no longer uses three real SQLite busy waits as its retry stimulus. A per-store `cfg(test)` hook injects exactly three SQLITE_BUSY start-transition errors through the existing scheduler start/retry/requeue path. A one-shot fourth-transition gate prevents a scheduling race with the fixture's queued-state inspection. The test releases that gate only after inspecting the registered 10/50/100ms delays, queued state and absence of worker execution.

Production retry behavior is unchanged. All hook fields, types, configuration methods and transition interception are excluded from non-test builds. No retry delay, SQLite busy timeout or existing test deadline was enlarged. Existing final Complete state, attempt=1, single worker invocation and single Running event assertions are retained; an explicit single Complete event assertion was added.

New test coverage:

- `start_transition_injection_is_per_store_shared_by_clones_and_one_shot`: another store is unaffected, clones consume the same three errors, failed transitions leave the job queued with no extra events, and release permits a real transition before the hook disappears.
- `start_transition_real_sqlite_contention_preserves_queued_state_and_events`: no injection; hold a real BEGIN IMMEDIATE lock, observe a real busy/locked transition error, release the lock, verify unchanged queued state/events, and then complete a real Running transition. This does not assert a wall-clock bound on three SQLite waits.

Changed source files are `apps/desktop/src-tauri/src/video/jobs/store.rs` and `apps/desktop/src-tauri/src/video/jobs/scheduler.rs`. Earlier dirty changes were preserved. No dependency or lockfile change was required. No Roadmap status changed; P2 remains open.

## Verification

Targeted command:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml start_transition -- --nocapture
```

Execution `8134517e-71f1-43e6-b3d6-721b68b4b1be`, independent exit **0**. All three selected tests passed, zero failed/ignored, 324 library tests filtered out; library execution 2.42s. Whole command 112.028s includes compilation. Existing non-failing linker-output warning remained.

Then, sequentially:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=32
```

Execution `9259a036-4cf4-4b0f-9214-9e53701de78f`, independent exit **101**. Library **306 passed, 1 failed, 20 pre-existing ignored**, 77.53s; whole command 78.794s. Integration tests were not reached. The modified scheduler test and both new store tests passed in this full run (log lines 67, 98, 268).

The sole full-suite failure was unchanged `video::cache::tests::failed_eviction_reconciles_after_both_database_waits`, at `cache.rs:2201:24`: `result.unwrap()` received `Timeout` from its ten-second receive. It was not fixed, weakened, ignored or replaced by a passing rerun.

The historical supervisor timeout test passed in this run (log line 386), but its prior intermittent failure remains unresolved and is not explained by this test-only change.

`git diff --check`, execution `50de677a-3caa-4109-8b6f-6f56ffaa0c42`, independently exited **0**. Final focused diff, including existing dirty edits, was retained by execution `fa90dee0-5ef7-4ddd-918b-239c66b195e0`, exit 0. Source was not changed between targeted and full test runs or afterward. No current full-suite pass is claimed.

Complete sanitized logs remain at `C:/Users/SPARTAN PC/.gg/foreground/<execution-ID>.log`. The current work is on the previously inspected base `b21a303c51c258d3aa63fa51217bcbb4508fef0f` plus dirty edits; no whole-tree fingerprint was recorded for these executions. This report does not promote historical passed labels or establish readiness for Done.
