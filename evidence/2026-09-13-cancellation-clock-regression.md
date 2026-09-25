# Cancellation fixture clock race: demonstrated and corrected

## Scope and outcome

The cancellation write-delay test mixed a controlled 80ms gate delay with real fixture/database/scheduler latency under one 500ms caller timeout. After observing the 80ms hold, the test stopped polling the cancellation future while inspecting the database and worker. That uncontrolled interval could consume the caller budget before the write gate was released. The test therefore asserted a wall-clock API bound that the acknowledgement contract does not promise.

A deterministic 600ms fixture-delay regression reproduced the same assertion failure before the fix. The corrected test explicitly advances its own Tokio clock while real SQLite and worker operations continue on Tauri's separate runtime. All 40/80/500/600ms values remain unchanged. Production cancellation code is unchanged. These are timer-ordering tests, not evidence of a 500ms whole-API wall-clock guarantee.

The historical Windows supervisor timeout is **still unresolved**. Neither this test race nor the passing supervisor reruns establish its cause. No Roadmap status was changed.

## Measured red regression

Command:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml cancellation_write_delay_survives_slow_fixture_inspection -- --nocapture
```

Execution `5e34e76e-ef13-47bd-8df1-5735a84d1991`, independent exit **101**, 0 passed / 1 failed / 0 ignored; test duration 0.75s.

| Stage                                                   | Wall elapsed |
| ------------------------------------------------------- | ------------ |
| Write gate reached                                      | 7.062ms      |
| 80ms controlled hold observed, API stopped being polled | 91.9253ms    |
| Fixture database read complete                          | 96.7812ms    |
| Gate released after injected fixture delay              | 698.229ms    |
| Caller returned `Err(Elapsed(()))`                      | 698.2873ms   |

Approximately 601.45ms was consumed between the completed fixture read and gate release. The expired caller returned approximately 0.058ms after release: this controlled failure happened before post-gate durable work or acknowledgement could account for the budget. It demonstrates the fixture scheduling defect without requiring an intermittent OS slowdown.

The earlier uninstrumented failure (`d179f8d3-7558-42d7-a582-cf9038852716`) only recorded 92.6713ms after the controlled hold and expiry at 505.2461ms. Its exact delay split between fixture inspection, scheduling and subsequent database work cannot be reconstructed. The deterministic regression proves the test's invalid timing assumption; it does not fabricate missing stage measurements for that historical run or rule out slow storage there.

## Fix and guarantees

Changed source:

- `apps/desktop/src-tauri/src/video/jobs/mod.rs`: factor the existing scenario into a helper and add `cancellation_write_delay_survives_slow_fixture_inspection`; manually advance only the controlled gate delay; assert fixture work leaves logical time unchanged.
- `apps/desktop/src-tauri/Cargo.toml`: enable `test-util` for the already pinned Tokio `=1.53.1` as a dev dependency. No package download/version upgrade or lockfile change was needed.

Because Tauri has a separate runtime, simply starting the test with paused time is insufficient: local time can auto-advance before external work completes. That intermediate attempt failed both tests at the worker-start watchdog, execution `7108268d-1cb5-441d-8efb-d51df4ef266c`, exit **101**. It was replaced, not retained.

The final fixture initializes and starts workers with real time. During its controlled timer section, a local blocking receive inhibits automatic advancement. The receive is bounded by the existing 30-second real-time hang watchdog and is released explicitly on success or by sender drop during panic. No busy-spin task is used. Time is resumed before teardown. This behavior was checked against the installed pinned Tokio blocking scheduler (`runtime/blocking/schedule.rs`) and exercised against real Tauri store calls.

Retained/strengthened assertions:

- At logical 80ms, cancellation is still blocked at the write gate despite the 40ms acknowledgement deadline.
- Opening the gate then returns `CancellationPending` rather than terminal success.
- At logical 600ms, the unchanged 500ms caller watchdog interrupts the still-gated API.
- Before cleanup: no terminal state/event, owned partial file still exists, cleaned count remains zero.
- Only the short-delay branch has a durable cancellation request; the timed-out long branch does not pretend its write completed.
- Explicit cleanup yields one cancelled event, no running ownership, no partial file and cleaned count exactly one.
- Separate real-time nonsettling-worker and cancellation watchdog tests remain unchanged.

Temporary diagnostic tags were removed before the final full-suite executions. Existing unrelated dirty changes were preserved, including pre-existing real-time watchdog values outside this test.

## Green verification

Initial focused green command:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml cancellation_write_delay -- --nocapture
```

Execution `764803cb-cf48-40ab-bc00-d53b6579cfbf`, independent exit **0**, 2 passed. This was before removal of temporary logging and addition of stronger pre-cleanup assertions; it is not the final-snapshot verification.

It measured the injected-delay short case releasing at 610.1627ms wall time and returning `CancellationPending` at 621.8985ms while preserving the logical caller budget. The 600ms logical branch still returned caller `Elapsed` before release. This explicitly does **not** claim sub-500ms wall time.

Final command, executed three times separately with default parallelism and no test filtering:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture
```

| Execution ID                           | Independent exit | Library result                                | Integration result | Library duration |
| -------------------------------------- | ---------------- | --------------------------------------------- | ------------------ | ---------------- |
| `4cfe0090-987b-4590-9016-16402da947de` | 0                | 305 passed, 0 failed, 20 pre-existing ignored | 5 passed           | 73.28s           |
| `522105cf-4090-4638-bc2c-4939469d0e40` | 0                | 305 passed, 0 failed, 20 pre-existing ignored | 5 passed           | 92.47s           |
| `df04499f-0ce5-4fc6-8844-86476629c76d` | 0                | 305 passed, 0 failed, 20 pre-existing ignored | 5 passed           | 81.82s           |

Each foreground command had a 600000ms external command budget. No test deadline was raised. `git diff --check` ran independently as `581c2193-26c3-4895-aef7-109b1f238e33`, exit **0**. Complete sanitized logs remain at host `.gg/foreground/<execution-ID>.log`.

## Revision and dirty-tree binding

HEAD: `b21a303c51c258d3aa63fa51217bcbb4508fef0f`, existing dirty tree plus the two source edits above.

Final source fingerprint, captured before all three full runs and confirmed unchanged afterward:

`d94a188695dc9c5f4dd2feab28dacbd422723b49c6b8ef1843830900f2010f75`

Method: SHA-256 of LF-joined sorted tracked paths and their individual SHA-256 contents. Excludes untracked evidence and ignored artifacts/runtime conditions. Pre-run inspection `1c3b04e1-88d0-410e-940b-e9bccad4512e` preserves the full current diff for both edited files, including earlier user changes. Post-run confirmation `76f18fd4-60a1-4323-bf60-e6bda91145db` independently exited 0 and matched the fingerprint. No source changes occurred between the three final runs.

This report establishes the demonstrated cancellation test-race fix and its regressions. It does not establish bounded durable I/O, general power-loss recovery, other platforms, or resolution of the separate supervisor timeout.
