# Supervisor under increased parallel load — incomplete fix investigation

The user explicitly chose to preserve the existing three-second total watchdog, including startup, and all assertions. This run changed only test parallelism and added temporary test-only stage timing. No causal production fix was established. The historical outer-watchdog failure remains unresolved.

## Scope

HEAD remains `b21a303c51c258d3aa63fa51217bcbb4508fef0f`, with existing dirty work including the verified cancellation-clock regression. Temporary instrumentation in previously clean `video/process.rs` and `video/tests.rs` recorded spawn, reader setup, execution timeout, termination/reaping, pipe joins, and the outer result. In test compilation only, the timeout cleanup sequence was inlined unchanged to observe stages. Logging may perturb scheduling. No instrumented full-tree fingerprint was archived for this run.

Instrumentation was removed afterward. Inspection `99e6a221-cfa1-44bc-8a71-610a8e93284f` independently exited 0, showed no diff in either temporary source file, and confirmed the entire tracked tree matches the pre-investigation cancellation-fix fingerprint:

`d94a188695dc9c5f4dd2feab28dacbd422723b49c6b8ef1843830900f2010f75`

Fingerprint method is documented in `2026-09-13-cancellation-clock-regression.md`; it excludes ignored artifacts and untracked evidence. This report is the only retained addition from this investigation. No source deadlines, assertions or Roadmap statuses changed.

## Executions

All commands ran directly in foreground with a 600000ms command budget. The budget is external to the unchanged three-second test watchdog and 1500ms process execution timeout.

Full stress command:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=64
```

Execution `109969f8-d609-4928-b282-57ed29e7113c`, independent exit **101**: 294 library tests passed, 11 failed, 20 pre-existing ignored; duration 110.46s. Integration tests were not reached. This is an increased-concurrency run, not default-parallel verification.

The supervisor timeout test failed at **grandchild readiness**, not at the original outer timeout:

| Stage                        | Elapsed                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| Spawn return                 | 372.574ms                                                           |
| Reader setup complete        | 372.6374ms                                                          |
| Execution timeout selected   | 1.8789635s                                                          |
| Termination/reaping complete | 1.9336351s                                                          |
| Stdout join complete         | 1.9390672s                                                          |
| Stderr join complete         | 1.9391207s                                                          |
| Outer return                 | 1.9393226s; `Ok(Err(Timeout { operation: "helper_tree_timeout" }))` |

Preserved failure: `grandchild must start before timeout termination`. The cancellation supervisor test also failed readiness: `grandchild must start before cancellation`. Neither supplies evidence that descendant pipes remained open, that a descendant survived termination, or that the original three-second watchdog failure was reproduced. The readiness assertions correctly prevent counting these as successful descendant-termination verification.

Other stress failures (not fixed or attributed to a shared cause):

- cache `database_contention_is_bounded_and_does_not_reserve_a_candidate`
- cache `failed_eviction_reconciles_after_both_database_waits`
- scheduler `cancellation_interrupts_each_automatic_retry_delay_without_requeue`
- scheduler `permit_release_between_failed_acquisition_and_wait_is_not_lost`
- scheduler `priority_fifo_aging_and_bounded_ffmpeg_concurrency_are_deterministic`
- scheduler `queued_and_running_cancellation_settle_once`
- scheduler `transient_failure_retries_at_injected_delay_and_completes_once`
- scheduler `transient_start_transition_failures_requeue_and_complete_once`
- jobs `owner_and_shutdown_timeouts_retain_leases_and_join_handle_for_retry`

The number of failing tests is evidence that this broad load change is not an isolated supervisor reproduction; it is not permission to dismiss or weaken those tests.

## Narrowing and restoration verification

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml supervisor -- --nocapture --test-threads=64
```

- Instrumented narrowed run `dd74a2ae-e9b2-41c5-aff4-a9d668f92094`, independent exit **0**: four supervisor tests passed, 321 library tests filtered out, 0 ignored. Outer timeout scenario returned its expected result at 1.6644537s; readiness and descendant assertions passed. With only four selected tests, specifying 64 threads does not reproduce the full-suite load.
- After restoring the original source, same narrowed command `021d297b-8150-4284-b390-d70ff01115a6`, independent exit **0**: four tests passed, 321 filtered out, 0 ignored; test duration 5.94s. Existing non-failing linker-output warning remained.

Complete sanitized logs remain in host `.gg/foreground/<execution-ID>.log`. No full-suite pass is claimed after this failing stress run, and the focused passes do not resolve its failures.

## Conclusion

The narrowed run loses the failure. The broad stress run reached a different failed assertion and has not isolated its responsible competing workload. There is still no demonstrated causal fix for the historical outer timeout while preserving the selected total bound. The next diagnostic must isolate the interfering workload/readiness stages rather than count additional broad passing reruns as proof. Prior cancellation-clock fixes remain intact; they are not asserted to explain this supervisor behavior.
