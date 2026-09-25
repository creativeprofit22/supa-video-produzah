# Supervisor fix attempt: no causal fix established

Date: 2026-09-13. Requested task: fix the unresolved intermittent Windows supervisor timeout. Outcome: incomplete. Three full default-parallel executions with temporary stage tracing did not reproduce that timeout. One execution instead failed the existing cancellation write-delay regression. No production fix, changed deadline, weakened assertion, new ignore, dependency change or Roadmap status change was made.

## Scope

HEAD `b21a303c51c258d3aa63fa51217bcbb4508fef0f`, with the pre-existing dirty tree documented in `2026-09-13-supervisor-bounded-diagnostic.md`.

Only clean `video/process.rs` and `video/tests.rs` were temporarily instrumented. Test-only trace tag `[DBG-b493]` recorded spawn, reader setup, execution timeout, kill/reap, stdout/stderr joins and the outer timeout result. As in the previous diagnostic, the timeout branch in test compilation inlined the same kill/wait/join sequence to measure it. These traces may perturb scheduling. All instrumentation was removed afterward.

Restoration execution `5f8d0e8c-8440-4c2c-863e-2f5f0c053849`, independent exit 0, confirmed no diff in either file and the same complete tracked-tree fingerprint as before this work:

`d0efb9236796f7263281274474d8aa45b6f99dee9416a76de2890af79f0b7a1a`

Fingerprint method: SHA-256 of LF-joined, sorted tracked paths plus each file's SHA-256. Excludes untracked files, ignored artifacts and runtime environment. No per-run instrumented full-tree fingerprint was captured; do not describe these runs as a fully archived instrumented snapshot. The pre-existing cancellation job source was not edited.

## Commands and independent exits

Full command, unchanged across all three attempts:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture
```

Each command ran directly in foreground, with a 600000ms command budget; the actual 3-second supervisor test watchdog and 1500ms process timeout were unchanged.

| Execution ID                           | Independent exit | Result                                                                              |
| -------------------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `c64a00e6-1f1c-4c0d-8a99-ab54fb44676e` | 0                | 304 library passed, 20 existing ignored; 5 integration passed                       |
| `d179f8d3-7558-42d7-a582-cf9038852716` | 101              | 303 library passed, 1 failed, 20 existing ignored; stopped before integration suite |
| `ad65e48c-a501-46e4-8d57-5238e57c208a` | 0                | 304 library passed, 20 existing ignored; 5 integration passed                       |

After restoring the source:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml supervisor -- --nocapture
```

Execution `20577909-280d-4e65-a90a-0197de746e46`, independent exit 0: all four selected supervisor tests passed, 320 library tests filtered out. No full suite was rerun after restoration. The existing non-failing linker-output warning remained.

Complete sanitized logs: host `.gg/foreground/<execution-ID>.log`.

## Supervisor observations — all passing, not failed-stage evidence

Elapsed times are from immediately before wrapped spawn, except the final outer result measured by the test.

| Execution | Spawn returned | Execution timeout selected | Termination/reaping complete | Stdout joined | Stderr joined | Outer result returned |
| --------- | -------------- | -------------------------- | ---------------------------- | ------------- | ------------- | --------------------- |
| c64a00e6  | 0.2180873s     | 1.7350024s                 | 1.7384913s                   | 1.7385364s    | 1.738569s     | 1.7388334s            |
| d179f8d3  | 1.2782914s     | 2.7918981s                 | 2.800042s                    | 2.8000963s    | 2.8001164s    | 2.8002999s            |
| ad65e48c  | 0.8234564s     | 2.3577325s                 | 2.4038008s                   | 2.424079s     | 2.4241197s    | 2.4242963s            |

All three outer results were `Ok(Err(Timeout { operation: "helper_tree_timeout" }))`; the supervisor timeout test passed. Startup delay remains a plausible contributor to the original three-second outer watchdog failure, not an established explanation. No failing supervisor stage trace was captured. Passing reruns do not erase the failure in `supervisor-timeout-unresolved.md`.

## New actual failure: cancellation write-delay regression

Execution `d179f8d3-7558-42d7-a582-cf9038852716`, log lines 90–97, preserved verbatim values:

```text
controlled cancellation: hold=80ms write_gate_reached=10.3261ms
controlled cancellation: held=82.3452ms api_elapsed=92.6713ms observation=Err(Elapsed(()))
controlled cancellation: released write; api_elapsed=505.2461ms returned=Err(Elapsed(()))
thread 'video::jobs::tests::cancellation_write_delay_distinguishes_acknowledgement_from_caller_watchdog' panicked at src\video\jobs\mod.rs:550:17:
assertion failed: matches!(returned, Ok(Err(MediaStateStoreError::CancellationPending)))
```

Observed: the 500ms outer caller watchdog expired in the 80ms controlled-delay case. The expected `CancellationPending` was not returned within that watchdog. This is a current failed regression, not merely stale verification. The next full-suite pass does not resolve it.

Code inspection: the outer watchdog covers API startup, the controlled write gate, intervening test assertions including an asynchronous store read, durable work after gate release, and the acknowledgement wait. The existing log does not timestamp actual gate release separately from completion, so it cannot allocate the additional delay among these stages. It does not prove whether durable I/O, scheduling, or fixture work caused this failure. The assertion, its deadline, and the dirty source file were left intact.

Do not conflate this failure with the supervisor failure, or bounded cancellation acknowledgement with bounded eventual durable cleanup. This test also failed before its normal explicit teardown assertions; this run supplies no completion proof for that fixture.

## Research limits and next evidence

Read installed `process-wrap` 9.1.0 Windows JobObject implementation and queried existing nextest corpus code. The local implementation confirms wrapped spawn is synchronous, with job setup/resume before return. No relevant corrective pattern was established; no dependency was patched or upgraded.

A causal fix still requires a reproducible supervisor failure or a deterministic regression tied to its actual violated contract, without moving or relaxing deadlines to hide the symptom. The separately observed cancellation failure requires stage-specific timing around its real gate release, store work and acknowledgement before a corrective change can be justified. No claim of fixed, verified complete, or Ready for Done is made.
