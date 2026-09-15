# Cache contention fixture: scoped zero busy timeout

Changed only `apps/desktop/src-tauri/src/video/cache.rs` for this task. A cfg(test), instance-local opt-in probe enables zero busy timeout on only the eviction and reconciliation connections of `failed_eviction_reconciles_after_both_database_waits` and its clones. Other connection paths, fixtures and production timeouts are unchanged. No fault is injected: a real SQLite writer transaction still causes the failures.

Assertions now verify actual DatabaseBusy errors from both the initial eviction and immediate repair, a retained repair obligation and intact bytes, another DatabaseBusy during a separately blocked repair, retained obligation after that failure, successful reconciliation after release, and removal of the repaired obligation. Existing active-reservation, eviction-count and eventual cleanup assertions remain. The original receive deadlines and lock-release-before-join/assert ordering were not enlarged or changed.

## Verification

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml failed_eviction_reconciles_after_both_database_waits -- --nocapture
```

Execution `c0ccf421-9fd1-4511-927e-d088bf2973f0`: independent exit **0**, 1 passed / 0 failed / 0 ignored / 326 filtered; library test duration **0.12s**, whole command 48.593s including build. Existing non-failing linker-output warning remained.

Then, sequentially:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=32
```

Execution `e472c468-e585-4658-916c-e95d425bf5c1`: independent exit **101**, **306 passed, 1 failed, 20 pre-existing ignored**; library test duration **81.40s**, whole command 82.645s. Integration tests were not reached. The changed cache fixture passed (log line 79).

The unrelated failure was `video::jobs::scheduler::tests::queued_and_running_cancellation_settle_once`, at `scheduler.rs:1816:10`: the existing one-second wait to observe the running job's persisted Running state failed. It occurred before `scheduler.cancel(&running_id)`. No fix or cause is claimed for that failure, and it was not changed or erased with a passing rerun. The historical supervisor timeout also remains unresolved despite passing in this run.

```text
git diff --check
```

Execution `2c681277-c77a-4124-95c4-568d6da44d40`: independent exit **0**. Final cache diff retained in execution `d9aee821-4d67-4631-8294-89331eacfafe`, exit 0. No source edits occurred between the targeted and full runs or afterward.

Complete sanitized logs remain at `C:/Users/SPARTAN PC/.gg/foreground/<execution-ID>.log`. Existing unrelated dirty changes were preserved. No full current-suite pass is claimed. No Roadmap status changed; **P2 remains open**.
