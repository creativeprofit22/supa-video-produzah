# P2 cancellation and supervision: controlled comparisons, no retained fix

## Outcome

**Unresolved. No causal correction was demonstrated or retained.** The approved plan's restoration fallback was used. Synthetic failures establish budget sensitivity, not the cause of a historical failure. Passing controls and the optional parallel diagnostic do not turn previous failures into repairs.

Execution was sequential, without delegation or concurrent test commands, on Windows at HEAD `b21a303c51c258d3aa63fa51217bcbb4508fef0f` plus the existing dirty baseline. The approved plan was `.gg/plans/approved/af0c0c24-e0da-4263-a1c2-c3b8e95062f1.md`. Host logs date this execution September 14, 2026.

Only this evidence file remains from this investigation. No dependency, timeout, production time semantics, process-tree protection, polling policy, runtime placement, or production database behavior was permanently changed. Pre-existing work was preserved; no commit was made.

## Baseline and snapshots

Baseline inspection found 12 modified tracked files and 13 untracked evidence files. Candidate source hashes matched the preceding diagnostic's recorded baseline. The complete original candidate diffs and hashes are in foreground execution `3a8f5398-d316-4884-8cd2-d7be369d88fd`. The files under `video/jobs/` already contained user-authorized edits; `video/process.rs` and `video/tests.rs` were clean relative to HEAD.

All source paths below are relative to `apps/desktop/src-tauri/src/video/`:

| File                | B: original and restored SHA-256                                   |
| ------------------- | ------------------------------------------------------------------ |
| `jobs/scheduler.rs` | `644a36463da82746864bff1a3276b98a3168898b96723b9f3f68388515bb9e79` |
| `jobs/store.rs`     | `0895b06f663bfb4273f98d34ea17f5739b618ee23a2bc1cd588735c4f2f8a353` |
| `jobs/mod.rs`       | `0583e10de2ae215976e69d27669619065d4f958dbbbe05d17dbec074aac1b2fd` |
| `process.rs`        | `f8f8c76dc3cd7ac455bb2c8e315a041aeddc7f4c62672fe63dc23d1ed849f38b` |
| `tests.rs`          | `d6bcb71236d71466a787a84e5c6c3c65824783c86a186479a83801f97154af1e` |

Snapshot I, used for compilation and all five focused executions:

| File                | I: instrumented SHA-256                                            |
| ------------------- | ------------------------------------------------------------------ |
| `jobs/scheduler.rs` | `5c985095abceada22993151ac0fff0aebb3ff011f664c210725ca1dd69ce5daa` |
| `jobs/store.rs`     | `4bf3f4aa4ea7fa82190dd89e80438f12c6ead4d8f3847a31130aa5685c27242e` |
| `jobs/mod.rs`       | Same as B; never edited                                            |
| `process.rs`        | `12a2e978eeffcdc509a43bc85111e169cbde509c21a18512f7a14252b70438a8` |
| `tests.rs`          | `2b4995016a01ad0a2f344f39e01bde8821e8417c57e0c356be2ffe9931f7722b` |

Snapshot F, used for the optional full diagnostic: same as I except `jobs/scheduler.rs` = `fab3b8f097390901f39c27683a86fe410105631be35d6b91cd5386d90d458568` and `tests.rs` = its B hash. The three added diagnostic test cases were removed before that run, rather than ignoring tests or filtering existing failures. Untriggered gate/delay branches remained temporarily in the diagnostic implementation; the original retry test selected ungated mode.

## Instrumentation and controlled cases

### Retry readiness

A test-only per-store trace assigned IDs to individual read and transition operations. It distinguished scheduler start, blocking submission/entry, connection open/configuration, read-query return, connection drop, write-transaction acquisition, committed transition return, event-return boundary, and the paused fixture clock's actual sleep registration. No production clock was changed.

Three modes used the same existing automatic-retry fixture, persisted-state checks, original two-second readiness watchdog, one-second idle watchdog, single Cancelled/Queued event assertions, worker-count/queue checks and scheduler loop join:

1. **Ungated control:** existing three retry numbers and 1/5/30-second recorded sleeps.
2. **Synthetic retry gate:** a one-shot gate before submitting the Retrying transition held the real transition until the original readiness timeout expired. The gate was then released, readiness awaited for recovery, and normal cancellation/assertions/joins completed before the final intentionally red readiness assertion. This recovery wait did not count as meeting the original watchdog.
3. **Held completed-read connection:** a real `get_private` read was held after its query returned but before its connection dropped. The scheduler and original polling helper ran while that connection remained open. The one-shot gate was released after readiness was observed; its read task was joined before normal cleanup. The blocking gate had a 30-second safety limit and was actually released at about 34–50 ms.

The third case deliberately models an open connection after a completed query, **not** an active read transaction, writer lock, arbitrary blocking-pool saturation, or antivirus/filesystem delay. It does not rule out every connection-contention scenario.

The bounded trace retained at most 4,096 records per fixture and counted overflow. The synthetic retry red overflowed by **463 records**, so its later stage timestamps were not retained. Its final readiness assertion failed only after cleanup/assertions completed, but this is not a complete red-stage timing trace. The ungated, held-read, and parallel retry traces had zero overflow. No extra run was spent repairing diagnostic capacity.

### Windows supervision

The installed pinned `process-wrap 9.1.0` implementation was read at `E:/DevCaches/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/process-wrap-9.1.0/src/generic_wrap.rs`: `spawn()` delegates to `spawn_with`, whose closure is enclosed by wrapper `pre_spawn` and `post_spawn` handling. Test-only `spawn_with` tracing kept the existing Job Object/suspended-start lifecycle. No registry source was edited.

Each invocation had one process-trace ID, capped at 64 stages, covering native-spawn entry/return, wrapper return, execution timer creation, timeout, kill/wait and pipe joins. Logs contained fixed stage names/timings, not command arguments or job payloads. The target timeout fixture used a fixed trace label so it could be identified among parallel invocations.

A separate synthetic fixture added 1,600 ms immediately before the real native `command.spawn()`. It retained the 1,500 ms execution timeout and original three-second outer watchdog. After outer expiration, it awaited the same supervisor future under a separate cleanup safety watchdog, checked Timeout, actual grandchild readiness, and actual descendant termination, then intentionally failed the original-watchdog assertion. It did not convert late cleanup into success or replace the original supervision test. This fixture establishes only startup-budget sensitivity.

## Execution ledger and budget

All Cargo test invocations used:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Focused invocations appended the exact test name below and `-- --exact --nocapture --test-threads=1`. Each selected and executed **one library test**, with 329 filtered out. Passing focused commands also reached the zero-selected main and integration binaries (five integration tests filtered out); failed library commands did not reach those binaries.

Foreground logs are local under `C:/Users/SPARTAN PC/.gg/foreground/<execution-id>.log`.

| Run                        | Snapshot | Suffix / exact test name                                                                            | Executed result                                                                                                                    | Exit | Execution ID                           |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------- |
| Compile-only 1             | I        | `--no-run`                                                                                          | All test binaries built; no tests executed                                                                                         | 0    | `dd1a663d-28b1-48b2-a593-d7cd43001a91` |
| Focused 1                  | I        | `video::jobs::scheduler::tests::p2_retry_gate_budget_sensitivity`                                   | 0 passed, 1 deliberately failed; 2.19 s                                                                                            | 101  | `cf8af13a-488e-4810-b6b3-c8958119a08c` |
| Focused 2                  | I        | `video::jobs::scheduler::tests::cancellation_interrupts_each_automatic_retry_delay_without_requeue` | 1 passed; all three retries                                                                                                        | 0    | `35c59536-1814-40e4-a74f-f1637eae9775` |
| Focused 3                  | I        | `video::jobs::scheduler::tests::p2_retry_held_read_connection_comparison`                           | 1 passed; all three retries                                                                                                        | 0    | `5337ac24-fa29-452a-974a-6d28cbbca231` |
| Focused 4                  | I        | `video::tests::p2_supervisor_startup_budget_sensitivity`                                            | 0 passed, 1 deliberately failed after real cleanup; 7.41 s                                                                         | 101  | `8991e839-0e14-4732-b362-36450b734f2a` |
| Focused 5                  | I        | `video::tests::supervisor_timeout_terminates_grandchild_and_releases_inherited_pipes`               | 1 passed; 5.80 s                                                                                                                   | 0    | `e1e99d43-f418-4575-897d-07bfa8802f87` |
| Optional instrumented full | F        | `-- --nocapture --test-threads=32`                                                                  | 327 library entries selected: 307 executed, **306 passed, 1 failed, 20 pre-existing ignored**, none filtered; 70.91 s library time | 101  | `4662d3c9-5159-4dbf-b158-23af16012908` |

The full library failure prevented main/integration/doc-test execution; this is **not** a 307+5 passing suite. The nonfailing linker-message warning remained visible.

Budget used: **1/2 compilation-only checks, 5/8 focused invocations, 1/1 optional instrumented full run, zero correction attempts.** An offline Cargo metadata lookup failed because an uncached Android-target crate would have required HTTP; it executed no tests and changed no dependencies. Installed source was then read directly.

There was no justified correction, so the plan's conditional final uninstrumented full run, separate corrected-code regression run, formatting check and strict Clippy were **not run**. No claim of final corrected-snapshot verification is made. The stop decision is insufficient causal evidence, not exhaustion of the focused allowance; the one optional full diagnostic was not repeated.

## Observations and limits

### Controlled retry results — RUNTIME

- Synthetic red: Retrying dispatch and gate reach at 12.227 ms; readiness wait began at 12.256 ms. The final original-readiness assertion failed after recovery/cleanup. Later trace records were lost to the explicit cap; do not infer their exact times.
- Held completed-read control: readiness elapsed approximately **30.983, 47.456 and 33.626 ms** for the three retry numbers. In each trace, the write transaction was acquired, the durable transition returned and the sleep registered **before** the held read was released. Mere overlap of a completed-read connection is therefore not sufficient to reproduce this failure in the controlled schedule.
- Parallel diagnostic: readiness elapsed **121.321, 113.285 and 232.435 ms**; sleep registration at 84.715, 89.775 and 171.622 ms from each trace origin. All original retry assertions passed. No historical failed stage was captured.

### Controlled supervisor results — RUNTIME

| Boundary                   |                             Synthetic startup red | Original focused control | Parallel target, process ID 24 |
| -------------------------- | ------------------------------------------------: | -----------------------: | -----------------------------: |
| Native spawn entry         |                                          0.170 ms |                 0.106 ms |                       0.046 ms |
| Native spawn return        | 1,605.356 ms, includes intentional 1,600 ms delay |                 4.738 ms |                       2.976 ms |
| Wrapper return             |                                      1,629.520 ms |                31.401 ms |                     134.047 ms |
| Execution timeout observed |                                      3,136.408 ms |             1,535.002 ms |                   1,643.083 ms |
| Kill/wait returned         |                                      3,138.145 ms |             1,536.789 ms |                   1,648.574 ms |
| Both pipe joins completed  |                                      3,138.169 ms |             1,536.805 ms |                   1,648.608 ms |

Synthetic outer expiration was observed at approximately 3,012.362 ms from its own start. Its Timeout, grandchild-readiness and descendant-termination assertions passed before the deliberate watchdog assertion failed. The original focused and parallel timeout fixtures passed, including inherited-pipe release and descendant checks. This is a useful differential, not evidence that historical Windows cleanup failures were caused by slow native spawn or wrapper startup.

### Unrelated full-suite failure — RUNTIME, left untouched

`video::project::tests::durable_command_acknowledgement_p95_meets_budget` measured **582.4357 ms p95 against 300 ms** and failed. No filter, assertion relaxation, retry, or performance repair was applied. That separate performance investigation is not an added P2 completion criterion. The other full-run panic message in the project IPC fault-injection path is not listed as a failed test; the final failure list contains only the acknowledgement test.

## Restoration and final diff review

Temporary changes were removed using targeted edits, not a checkout/reset of user work. Execution `ccf757a1-f156-4541-a279-6803b0350fbe` confirmed that all five candidate hashes equal B, `process.rs` has no Git diff, and the original dirty status/stat remains. `tests.rs` was already restored before F.

Execution `90ebe9ee-e092-4c23-bf7b-ac236192776e` compared the captured original candidate diff with the current diff after removing host log stream labels and normalizing newlines: **exact match**. Both normalized diff SHA-256 values are `8e0ff9d452e1e050ace69428aa7d3e95aa690583c13970e56bc9fc1df453baff`. A source search found no `DBG-p2-c74e`, trace structs, or added diagnostic test/helper names. No formatter ran or mutated source.

The restored source is baseline-identical, not a newly repaired snapshot. Historical evidence files were read and left unchanged, especially `p2-checkpoint-cancellation.md`, `2026-09-13-cancellation-clock-regression.md`, `2026-09-13-supervisor-native-spawn.md`, and `2026-09-14-native-retry-bounded-diagnostic.md`.

## P2 criteria reassessment

1. **Checkpoint replay, explicit-close retryability and visible reporting:** preserved historical fault-injection evidence remains relevant. This diagnostic also passed `checkpoint_failpoints_preserve_a_complete_old_or_new_snapshot`, `automatic_checkpoint_failure_warns_recovers_and_retries`, and `checkpoint_failure_is_reported_without_skipping_grant_cleanup`, plus project journal/recovery coverage. No new checkpoint repair was needed or claimed.
2. **Bounded acknowledgement/escalation without premature terminal cancellation:** the existing `nonsettling_worker_bounds_acknowledgement_without_terminal_cancellation` and pending-cleanup message tests passed in F. Prior nonsettling/lease/partial-cleanup evidence is preserved. Nothing here equates bounded acknowledgement with bounded durable cleanup, abandons a worker join, or reports cancellation terminal before cleanup.
3. **Normal supervision/cancellation and project recovery remain passing:** the target timeout, process-tree cancellation, automatic-retry cancellation, retry shutdown and project recovery tests passed in F. **Reliability remains unresolved:** no defensible historical cause or permanent deterministic red/green repair was established for the recorded readiness and Windows supervision regressions. Passing reruns are not repairs.

No additional ignored-tool, performance, packaging or other-platform criterion was imported into P2.

Initial host binding inspection reported this session unbound; no takeover/rebind was attempted. After reassessment, a bounded in-progress update was submitted through the normal host tool, subject to its checks. The host **accepted** update `p2-controlled-comparisons-20260914-c74e` for phase `9d04ff00-8a71-4802-91f4-6e39db8ac0c7`, revision **147 -> 148**, outcome `same-status`. P2 remains **in progress**. No passing-verification label or Done transition was requested.

Next work requires a defensible failing schedule for a historical defect, or an explicitly approved product-contract decision about startup/total-watchdog semantics. This report does not authorize another parallel diagnostic run or a speculative polling/runtime change.
