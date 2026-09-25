# Native spawn versus process wrapper timing

Outcome: diagnostic evidence only; no supervisor fix established. The selected three-second total watchdog, the 1500ms process timeout and every assertion remain unchanged. No Roadmap status changed.

## Real code examined

- Indexed `watchexec/process-wrap` at `1d1cc53c`: `src/windows.rs` resumes suspended process threads using a system-wide ToolHelp thread snapshot; `src/tokio/job_object.rs` creates/assigns the Job Object before resumption. This mechanism also exists in installed pinned version 9.1.0.
- Installed `src/generic_wrap.rs:118-142`: `spawn()` delegates directly to `spawn_with(|command| command.spawn())`. This provided a measurement seam without patching or upgrading the dependency.
- No inspected upstream code established a repair for the historical timeout. Removing suspended assignment or Job Object protection was not considered an acceptable optimization.

Temporary test-only instrumentation used this exact spawn callback, printing elapsed time before and after native spawn, then after wrapper completion. The outer test printed its existing timeout result before retaining all assertions. Production compilation kept `wrapped.spawn()`. Logging can perturb scheduling; these traces do not isolate individual wrapper syscalls.

## Observed run

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=32
```

Execution `922341e3-6ebb-4c2f-a490-04100276ed88`, direct foreground exit **101**, 301 library tests passed / 4 failed / 20 pre-existing ignored; 162.46s library duration. Integration tests were not reached. The external command budget was 600000ms, not a changed test deadline.

Supervisor measurements, log lines 312–359:

| Stage                 | Elapsed                                                             |
| --------------------- | ------------------------------------------------------------------- |
| Native spawn entered  | 7 microseconds                                                      |
| Native spawn returned | 4.4712ms                                                            |
| Wrappers returned     | 184.853ms                                                           |
| Outer result          | 1.9195085s; `Ok(Err(Timeout { operation: "helper_tree_timeout" }))` |

The native spawn call took about 4.46ms; the interval after native spawn through wrapper return took about 180.38ms. This interval includes wrapper work, scheduling and logging, so it must not be attributed exclusively to the thread snapshot. The supervisor timeout test passed, including readiness and descendant assertions. This is not a failing-stage trace and does not explain the historical outer watchdog failure.

Actual failures in this run, preserved separately from the passing supervisor:

- `video::jobs::scheduler::tests::cancellation_interrupts_each_automatic_retry_delay_without_requeue`
- `video::jobs::scheduler::tests::transient_start_transition_failures_requeue_and_complete_once`
- `video::jobs::tests::owner_and_shutdown_timeouts_retain_leases_and_join_handle_for_retry`
- `video::tests::race_actual_prepared_publication_and_completed_reuse`

None was repaired or dismissed as harmless. This increased-concurrency run is not a default-parallel run and cannot be represented as a full-suite pass.

## Restoration verification

Temporary instrumentation was removed from both previously clean source files. Direct `git diff --exit-code -- apps/desktop/src-tauri/src/video/process.rs apps/desktop/src-tauri/src/video/tests.rs`, execution `1944e76c-fb4e-44d0-86dc-4d44e8651601`, exited **0**.

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml supervisor -- --nocapture
```

Restored-source execution `f6fdb0ee-830e-4b7d-b42f-ed5393c9469f`, direct exit **0**: four supervisor tests passed, 321 library tests filtered, zero ignored; 5.95s library duration. The existing non-failing linker warning remained. This focused pass is not a new full-suite pass and does not supersede the four stress failures.

Scope: existing working tree based on `b21a303c51c258d3aa63fa51217bcbb4508fef0f`, including earlier cancellation-clock changes. No new whole-tree fingerprint was collected during this attempt; do not claim exact full instrumented snapshot archival. Complete sanitized logs remain at host `.gg/foreground/<execution-ID>.log`. This evidence file is the only retained addition from this attempt.

The historical supervisor timeout remains unresolved. The new measurements identify a startup interval worth isolating, not a demonstrated causal defect or authorization to relax the user's total bound.
