# Queued/running cancellation readiness: test-scoped timing

## Requested single run

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=32
```

Execution `fb83ed64-f903-40e4-95cb-df919873d5eb`, independent exit **101**. Library: **306 passed, 1 failed, 20 pre-existing ignored**, 71.79s test execution; whole command 137.842s. Integration tests were not reached. No overlapping agent-run tests/builds or additional suite runs.

The instrumented `queued_and_running_cancellation_settle_once` **passed**. Readiness completed at 133.2417ms, within the unchanged one-second deadline. Its later one-second idle deadline and final Cancelled state/single-event assertions also passed. The separate, sole suite failure was `durable_command_acknowledgement_p95_meets_budget`: measured p95 **354.6072ms**, unchanged budget **300ms**, assertion at `project/tests.rs:4304:5`. That failure was not modified or retried away.

Complete sanitized log:
`C:/Users/SPARTAN PC/.gg/foreground/fb83ed64-f903-40e4-95cb-df919873d5eb.log`

## Instrumentation scope

Temporary cfg(test) diagnostics were keyed to this fixture's running job ID. They traced dispatch selection, execute entry, scheduler reads, Running transition submission/database work/caller observation, actual first poll inside CancellationWorker's future, and the test's polling reads. Read sequence IDs linked submitted work to its blocking execution; they were process-wide counters, not timings or job contents.

The original one-second readiness and idle deadlines and all assertions stayed unchanged. If readiness returned Err(Elapsed), a separate maximum-five-second observation would sample real persisted state and worker entry, then unwrap the original failed result. It would not request cancellation before that assertion or convert eventual progress to a pass. This branch was **not entered in this run**, so it supplies no post-timeout readiness evidence.

## Timeline

Origin is immediately before scheduler start, after the target job was submitted. Times below are milliseconds from that origin.

| Event                                |        Elapsed ms | Result                   |
| ------------------------------------ | ----------------: | ------------------------ |
| First readiness poll begins          |            0.0569 | read sequence 28         |
| First poll database operation        |    0.1566–21.4979 | Queued                   |
| Dispatch selected                    |            0.1616 | permit/work selected     |
| Execute entered                      |            0.8137 | scheduler begins work    |
| Scheduler's prerequisite read        |    0.8774–28.3196 | seq 29, Queued           |
| Scheduler observes prerequisite read |           28.9633 | Queued                   |
| Running transition submitted         |           28.9841 | real database transition |
| Running transition database work     |   29.1083–98.8618 | Ok(Running)              |
| Second readiness poll database work  |   29.0193–68.3738 | seq 34, Queued           |
| Third readiness poll database work   |  84.8736–132.6152 | seq 35, Running          |
| Scheduler observes transition result |           99.7939 | Ok(Running)              |
| Actual worker entry                  |           99.8421 | worker future polled     |
| Test observes persisted Running      |          133.2131 | readiness poll completes |
| Readiness result                     |          133.2417 | Ok(())                   |
| Final persisted-state check          | 384.3547–394.8302 | seq 48, Cancelled        |

These intervals overlap; they must not be summed as independent sequential costs. The Running transition spent approximately **69.754ms** inside its blocking database operation, with about **0.124ms** submission-to-start and **0.932ms** return-to-caller observation. Its prerequisite read spent **27.442ms** inside the database operation. Dispatch and task start were under one millisecond. The final polling read observed persisted Running about **34.351ms after worker entry**.

The polling reads spent approximately **21.341ms, 39.355ms and 47.742ms** inside their respective blocking database operations. Those include connection/SQL work and any scheduling delay within the operation; they are not measurements of SQLite locking alone. The trace has no failed database operations before readiness and no evidence that cancellation malfunctioned.

## Interpretation and limits

This passing trace locates time spent in this run; it does not explain the historical readiness timeout. It provides no evidence of eventual state/worker entry after an actual readiness timeout. Logging can perturb timing. No speculative production fix, shortened deadline, widened deadline or assertion weakening was applied. The historical supervisor timeout remains unresolved; P2 remains open and no Roadmap status changed.

## Preservation and restoration

Diagnostic diff, including existing dirty edits, retained by execution `483bab1c-2dea-4ed2-9c5b-82feb127264b`, exit 0. Complete foreground logs use the same host directory as above.

Temporary edits were removed after the run. Before-edit hash capture `c47189ff-f46b-45da-9fa3-0b765dd8ea51` and restoration verification `e3a4d8fa-d2e8-43c9-8c06-14b7c57ccd3f` both exited 0 and matched exact file bytes:

- jobs/store.rs: `0895b06f663bfb4273f98d34ea17f5739b618ee23a2bc1cd588735c4f2f8a353`
- jobs/scheduler.rs: `644a36463da82746864bff1a3276b98a3168898b96723b9f3f68388515bb9e79`

Other source files were not edited. Existing deterministic retry and cache-fixture changes remain intact. No post-restoration test or build was run or claimed. This report is the only retained addition from this diagnostic task.
