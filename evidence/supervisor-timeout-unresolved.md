# Unresolved — Windows supervisor timeout / inherited pipes

## Status and scope

**UNRESOLVED. Not fixed.** This note preserves evidence from local Windows/MSVC runs timestamped 2026-09-13. Passing reruns did not reproduce the earlier failure and do not establish its cause or resolution. No code, timeout, assertion, or Roadmap status is changed by this record.

Affected test: `video::tests::supervisor_timeout_terminates_grandchild_and_releases_inherited_pipes` in `apps/desktop/src-tauri/src/video/tests.rs`.

Related engineering evidence: [checkpoint/cancellation investigation](p2-checkpoint-cancellation.md). This is a separate process-supervisor failure, not the cancellation API/polling-contract mismatch.

The base commit reported during these investigations was `b21a303c51c258d3aa63fa51217bcbb4508fef0f`. The working tree included uncommitted Cargo/job-test/job-store/scheduler changes and an existing `ROADMAP.md` edit. **These results are not clean-commit or exact-revision CI verification.** The full historical working-tree patch was not archived with each run.

## OBSERVED — original retained failure

Source: `supa-ack-contract-parallel-2.log`, lines 379–380, 525, 529. The following excerpt is preserved verbatim:

```text
thread 'video::tests::supervisor_timeout_terminates_grandchild_and_releases_inherited_pipes' (25072) panicked at src\video\tests.rs:6200:10:
timeout termination must close grandchild-inherited stdout and stderr pipes: Elapsed(())

test result: FAILED. 303 passed; 1 failed; 20 ignored; 0 measured; 0 filtered out; finished in 116.93s

CARGO_EXIT_CODE=101
```

Invocation used the full suite with Cargo's default test parallelism (no serial or reduced-thread override):

```sh
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture
```

The failure establishes that the outer test future did not complete before its watchdog expired. **The assertion's wording is not evidence that the stall was specifically in pipe closure.** There were no stage timestamps in this failing run. The test panicked before its later descendant-survival assertions; their outcome is unavailable for this run.

## CODE — timer scopes and independent assertions

At the inspected source:

- The outer `PROCESS_TREE_PIPE_RELEASE_DEADLINE` is **3 seconds**, wrapping the entire supervised run, including spawn/setup.
- The test requests a **1,500 ms** process execution timeout.
- In `video/process.rs`, the execution timer is created **after** `wrapped.spawn()`, stream extraction, and reader-task setup.
- On execution timeout, the supervisor awaits termination/reaping and reader-task joins before returning `ProcessFailure::Timeout`. These awaits were not individually timed in the original failure.
- The descendant helper uses a **4-second survival delay**. After a successful timeout result, the test independently checks readiness and that the descendant does not leave its delayed survival marker. Its post-return survival observation includes an additional 250 ms.

The 3-second wrapper is a test-level condition; its name does not isolate pipe-release latency or establish a documented end-to-end product guarantee. No decision to change that condition has been made.

## OBSERVED — instrumented full-parallel reruns

Temporary, test-only tracing recorded elapsed time from immediately before `wrapped.spawn()`. The outer measurement began separately immediately before polling the supervised run. Those origins are close but not identical; do not subtract an outer timestamp from an inner timestamp as if they shared one clock origin.

| Run | Spawn returned | Execution timeout fired | Termination and pipe joins finished | Outer returned | Native result          | Cargo exit |
| --- | -------------- | ----------------------- | ----------------------------------- | -------------- | ---------------------- | ---------- |
| 1   | 158.706 ms     | 1.6730943 s             | 1.680635 s                          | 1.6807912 s    | 304 passed, 20 ignored | 0          |
| 2   | 155.3352 ms    | 1.6693292 s             | 1.6762904 s                         | 1.6765068 s    | 304 passed, 20 ignored | 0          |
| 3   | 508.6838 ms    | 2.0231178 s             | 2.034069 s                          | 2.0342112 s    | 304 passed, 20 ignored | 0          |
| 4   | 92.5472 ms     | 1.6041139 s             | 1.6067903 s                         | 1.6069648 s    | 304 passed, 20 ignored | 0          |

Each run also passed all five security-configuration checks. No descendant-survival assertion failed in these runs. The 20 ignored native scenarios were not executed.

Derived from the same-origin timestamps, timeout-branch entry through termination and both pipe joins took **7.5407, 6.9612, 10.9512, and 2.6764 ms**, respectively. This combines several operations; it does not isolate kill, reap, stdout EOF, or stderr EOF.

Verbatim trace lines, retained here independently of temporary storage:

```text
# supa-tree-trace-1.log:325,366–368
[DBG-tree] spawn returned at 158.706ms
[DBG-tree] execution deadline fired at 1.6730943s
[DBG-tree] termination and pipe joins finished at 1.680635s
[DBG-tree] outer returned at 1.6807912s: Ok(Err(Timeout { operation: "helper_tree_timeout" }))

# supa-tree-trace-2.log:329,374–376
[DBG-tree] spawn returned at 155.3352ms
[DBG-tree] execution deadline fired at 1.6693292s
[DBG-tree] termination and pipe joins finished at 1.6762904s
[DBG-tree] outer returned at 1.6765068s: Ok(Err(Timeout { operation: "helper_tree_timeout" }))

# supa-tree-trace-3.log:338,378–380
[DBG-tree] spawn returned at 508.6838ms
[DBG-tree] execution deadline fired at 2.0231178s
[DBG-tree] termination and pipe joins finished at 2.034069s
[DBG-tree] outer returned at 2.0342112s: Ok(Err(Timeout { operation: "helper_tree_timeout" }))

# supa-tree-trace-4.log:334,380–382
[DBG-tree] spawn returned at 92.5472ms
[DBG-tree] execution deadline fired at 1.6041139s
[DBG-tree] termination and pipe joins finished at 1.6067903s
[DBG-tree] outer returned at 1.6069648s: Ok(Err(Timeout { operation: "helper_tree_timeout" }))
```

Tracing also temporarily borrowed the supervised future at the original watchdog and would have observed it for up to 15 additional seconds on timeout, while preserving the original failure. **That branch never executed:** there is no captured late completion from a failing supervisor run. Instrumentation can affect scheduling, so four instrumented passes are not proof of uninstrumented reliability.

Temporary tracing was removed afterward. A source diff check confirmed `video/process.rs` and `video/tests.rs` were restored exactly. The restored, uninstrumented focused test passed:

```text
# supa-tree-restored.log:13,28
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 323 filtered out; finished in 5.80s

CARGO_EXIT_CODE=0
```

The 5.80-second focused-test duration includes the independent post-return descendant-survival observation; it is not a measured pipe-release duration. There was no full-suite rerun after removing the tracing in this investigation.

## HYPOTHESIS — not established

Slow process startup or delayed runtime scheduling under parallel load could consume enough of the outer 3-second window that the supervisor's later-starting 1.5-second execution timer plus cleanup exceeds it. The differing timer scopes make this possible; the passing traces show variable startup latency.

**No failing trace proves this happened.** Delayed termination, descendant/Job Object membership problems, inherited handles remaining open, reader-task delays, and other scheduling effects remain unexcluded. Do not claim a startup-delay root cause, a leaked descendant, a fixed bug, or authorization to increase a deadline from this evidence.

## Evidence availability and provenance

All six source files below were available and reread when this note was written. Their SHA-256 hashes identify the raw inputs used for these excerpts. The source logs were in the local shell's `/tmp` directory. **This checked-in-location Markdown note, not those temporary paths, is the durable evidence record.** Full raw logs have not been copied into the repository; unrelated suite output and local paths are omitted from this curated record. Nothing has been committed or published by creating it.

| Source log                         | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `supa-ack-contract-parallel-2.log` | `1dc670d3f84d8050b94e8a110a928d21a9dddd7385f0bc5987c8ecafb3ee43e9` |
| `supa-tree-trace-1.log`            | `5bd2a5bc7833be52562f7c72779640af7c53724d7aa394d853dbacc7837b4242` |
| `supa-tree-trace-2.log`            | `304cc093f4eed5c7f21a24841743aacc11773416d33af72730f0cecf887b9e0b` |
| `supa-tree-trace-3.log`            | `ffb6f308ff0b3089a48362928f8d20d0d33ab3642f94295e5b633cb079152942` |
| `supa-tree-trace-4.log`            | `a2613a624a57e24dba339383f409b8e690a1109c47e060112c95137a7e2f70f0` |
| `supa-tree-restored.log`           | `7b5efba692a9998d29ac1047f96bb55d8eeaa1f0d23c5411d3e4ec0eb177c1f0` |

Unavailable: original-failure stage timing, individual pipe EOF times, parent/descendant exit and handle state at failure, eventual completion from a failing run, runtime/OS load measurements, exact effective test-thread count, and a per-run source patch snapshot. No inference fills these gaps.

## Required diagnostics for the next failing run

Keep production behavior, deadline values, and existing assertions unchanged while gathering evidence. Capture:

1. **Repro identity:** commit plus working-tree patch/hash, build profile, test command, effective test concurrency, Rust/toolchain and Windows versions, and unique run/process IDs. Record any environment overrides without exposing credentials.
2. **One monotonic timeline:** outer watchdog start; spawn start/end; child PID; execution deadline creation, target time, and actual firing; cancellation/timeout branch selection; outer expiry and last completed stage.
3. **Separate termination stages:** Job Object assignment/termination result, kill request/result, parent wait/reap result, known descendant PIDs and exit state. Preserve exact OS error codes rather than classifying all failures as pipe stalls.
4. **Separate pipe stages:** stdout and stderr read start, EOF/error, reader-task completion/join, and whether any known descendant still owns inherited handles. Do not record media contents or unrelated process command lines.
5. **Independent descendant evidence:** ready-marker and survivor-marker state with timestamps, including whether their assertions ran. Capture partial failure paths without treating a skipped assertion as a pass.
6. **Bounded post-failure observation:** if test-only instrumentation retains the same future after the original watchdog, record whether it eventually completes, how long it takes, and marker/process/pipe state. Preserve the original failed result and Cargo exit; do not retry cancellation or confuse teardown-induced termination with natural completion.
7. **Load and durable output:** relevant CPU/disk pressure and scheduling observations, full stdout/stderr in a non-temporary local evidence location after checking for sensitive output, and Cargo's actual exit code. With a `tee` pipeline, capture `${PIPESTATUS[0]}` immediately, append that code, and return it; a successful `tee` is not a passing test.

A subsequent fix requires evidence identifying the failed stage and agreement on the intended contract. Until then, this issue remains **unresolved**.
