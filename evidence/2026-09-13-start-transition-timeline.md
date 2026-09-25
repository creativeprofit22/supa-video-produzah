# Start-transition retry checkpoint: failed run with bounded observation

## Execution

Exactly one full suite was run, in foreground without overlapping agent-run tests/builds:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=32
```

Execution `471a97e7-59f8-4f8c-830c-9df7c3e7d6e0`, independent exit **101**. Library: **304 passed, 1 failed, 20 pre-existing ignored**, 88.65s test execution; whole command 208.605s. Integration tests were not reached. The only failed test was `transient_start_transition_failures_requeue_and_complete_once`. The supervisor timeout test passed; its historical failure remains unresolved. P2 remains open; no Roadmap status changed.

Complete sanitized log:
`C:/Users/SPARTAN PC/.gg/foreground/471a97e7-59f8-4f8c-830c-9df7c3e7d6e0.log`

## Instrumentation and observation scope

Temporary diagnostics were keyed to only this test's random job ID using a cfg(test) logger. They recorded read/transition submission, blocking database operation start/end, caller observation of transition results, retry sleep start/end and monotonic elapsed time. No record contents or credentials were logged. Start/end of a blocking database operation includes connection opening and SQL, not just time executing one SQLite statement.

The original 10-second checkpoint and its pass condition (three registered retry delays) were unchanged. On timeout, its original Err(Elapsed) result was retained. A separate observation window of at most five seconds sampled progress every 250ms while keeping the deliberate BEGIN IMMEDIATE writer lock held. It ended early upon observing three sleeps. The blocker was then dropped, and unwrapping the original failed result still failed the test. Later progress was not substituted for a pass.

The instrumented two-file patch (including pre-existing dirty edits) is retained in foreground log `3fed72ca-e1f1-4a4d-99a7-a1c6f76c49b8.log`, from direct `git diff --binary -- apps/desktop/src-tauri/src/video/jobs/store.rs apps/desktop/src-tauri/src/video/jobs/scheduler.rs`, exit 0.

## Timeline

Times are elapsed since the fixture's writer lock was already held and just before scheduler start. Checkpoint start was 0.0000635s. Values come from the log, not assumed timer durations.

| Event                                      | Start       | End           | Observed interval / result                                |
| ------------------------------------------ | ----------- | ------------- | --------------------------------------------------------- |
| Database read 1                            | 0.0005967s  | 0.0684866s    | 67.890ms, success                                         |
| Transition attempt 1                       | 0.0686884s  | 2.6161852s    | 2.547497s, error                                          |
| Injected 10ms retry sleep                  | 2.6175452s  | 2.6175706s    | 25.4 microseconds                                         |
| Database read 2                            | 2.6550839s  | 2.6577127s    | 2.629ms, success                                          |
| Transition attempt 2                       | 2.6738830s  | 6.3581214s    | 3.684238s, error                                          |
| Injected 50ms retry sleep                  | 6.3592512s  | 6.3592735s    | 22.3 microseconds                                         |
| Database read 3                            | 6.3593364s  | 7.3615710s    | 1.002235s, success                                        |
| Transition attempt 3                       | 7.3617082s  | 12.4093675s   | 5.047659s, error                                          |
| Original checkpoint expires                | —           | 10.0002682s   | Err(Elapsed), sleeps=[10ms, 50ms]                         |
| Injected 100ms retry sleep                 | 12.4098682s | 12.4098891s   | 20.9 microseconds                                         |
| Next transition attempt starts             | 12.4134526s | —             | Already retrying again with writer still held             |
| Diagnostic observation sees third sleep    | —           | 12.5884840s   | sleeps=3, worker_starts=0                                 |
| Observation ends and writer release begins | —           | 12.6348331s   | Observation Ok; original checkpoint still Err             |
| Original failed result asserted            | —           | after release | Panic at instrumented scheduler.rs:1511:24: Err(Elapsed)  |
| Next transition's blocking work finishes   | —           | 12.6930857s   | success after lock release; not full job completion proof |

The third-attempt interval straddles the checkpoint expiry; table rows are grouped by operation, not strictly sorted by end timestamp. Observation samples from 10.276604s through 12.3186552s continued to report two sleeps and zero worker starts.

Transition submission-to-blocking-start delays were approximately 0.0654ms, 15.739ms and 0.0512ms for the first three attempts. Result-to-caller-observation delays were approximately 1.332ms, 1.093ms and 0.478ms. The large measured intervals in this run were therefore inside blocking database operations, not waiting for those three blocking tasks to start or waiting for their results to be observed.

## What is established, and what is not

- The original checkpoint failure reproduced with an actual progress trace.
- At ten seconds, the third database attempt was still in progress. Progress resumed while the writer remained held: the third attempt returned an error and the 100ms retry delay was registered at about 12.410s.
- The injected TestClock registers delays and returns an immediately-ready future. The nominal 10/50/100ms sleeps consumed only tens of microseconds here; they did not account for the missing seconds.
- The deliberate writer lock was held throughout all three failed attempts. The logs record success/error booleans, not SQLite error codes or internal SQL/connection phase timings. They do not prove which particular internal step consumed each interval.
- A two-second SQLite busy timeout is configured, but these measurements encompass the entire blocking operation and scheduling. The longer observed intervals are not proof that SQLite ignored a two-second wall-clock API guarantee.
- No claim of deadlock, full eventual job completion, a causal fix, or connection to the historical supervisor timeout is made.

## Restoration

All temporary diagnostics and the observation window were removed after preserving the log. No further test or build was run, preserving the user's one-suite limit.

The final complete tracked-tree fingerprint matches the pre-diagnostic working tree, including prior user changes and the cancellation-clock fix:

`d94a188695dc9c5f4dd2feab28dacbd422723b49c6b8ef1843830900f2010f75`

Restoration confirmation `6ba638a9-8eed-49ce-8335-6f24f98fa6dc`, independent exit 0. An earlier restoration comparison detected one extra blank line; it was removed before this matching confirmation. Fingerprint methodology is SHA-256 over sorted tracked paths plus individual content hashes, excluding untracked evidence and ignored artifacts. Base HEAD remains the previously inspected `b21a303c51c258d3aa63fa51217bcbb4508fef0f`; no instrumented whole-tree fingerprint was collected for this run. This report is the only retained file addition.
