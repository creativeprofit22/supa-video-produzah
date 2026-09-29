# Step 9: native baseline, unchanged journal code (10 full runs, --show-output)
durable command acknowledgement p95 (ms): 24.52, 46.01, 29.67, 66.33, 41.94, 99.49, 63.93, 35.23, 81.40, 37.63
sorted: 24.52 29.67 35.23 37.63 41.94 46.01 63.93 66.33 81.40 99.49
min 24.52 / median 43.98 / max 99.49. p95 test passed 10/10 (budget 300 ms debug).
Suite: 7/10 fully green. Failures are unrelated to the journal and outside this plan's scope:
- video::tests::race_actual_prepared_publication_and_completed_reuse (runs 1, 3, 10): cache.rs:1628 "publisher did not acknowledge upsert"
- video::jobs::tests::owner_and_shutdown_timeouts_retain_leases_and_join_handle_for_retry (run 1): jobs/mod.rs:1084 CancellationPending

# Steps 10-11: journal append handle repair
Change: session keeps one append handle (journal.rs open_append/append_to; service.rs append_record). Dropped before every checkpoint, on close, and after any append error. Debug assertion added at recovery. Durability unchanged: sync_all still runs on every append.
New tests (journal_handle_tests.rs): 4/4 pass. Mutation (keep handle after append error) is caught by test 4.
clippy -D warnings clean; cargo fmt clean.

# Step 12: after, 10 full runs (same command)
p95 (ms): 236.13, 671.21, 722.43, 40.27, 35.31, 55.61, 62.07, 119.84, 42.61, 41.61
sorted: 35.31 40.27 41.61 42.61 55.61 62.07 119.84 236.13 671.21 722.43
min 35.31 / median 58.84 / max 722.43. FAILS the success criterion: 8/10 under the 300 ms budget (runs 2 and 3 over).
Before: min 24.52 / median 43.98 / max 99.49, 10/10 under budget.
Fisher exact 0/10 vs 2/10: p ~ 0.47, so this can't say whether the change is better or worse.

# Re-diagnosis: same stage-attribution method, 6 extra full runs, temporary probe (probe1-6.log)
Probe p95 (ms): 767.67 (FAIL), 81.69, 109.26, 72.73, 49.67, 84.19
Slow commands (0.1-3.6 s) come in bursts of consecutive records (e.g. 45-50, 84-89, 24-29), and each stage stalls in turn:
- pre_append (request validation + transition, pure CPU/memory, no journal I/O): up to 3633 ms
- metadata on the open handle: up to 650 ms
- sync_all: up to 759 ms
- tail (checkpoint snapshot at 25/50): up to 2706 ms
- open_if_needed (the removed per-append open): 0.001-0.098 ms
In probe2, 11 unrelated render tests failed at once: "Bundled media tools are unavailable" (not_found), though ffmpeg.exe is on disk.
Conclusion: the tails come from contention across the whole machine during the parallel suite. They hit CPU-only stages too, and at one point the bundled ffmpeg was briefly inaccessible, so the journal isn't the cause. The handle repair removed per-append open/close as intended, but it can't remove these stalls.
Probe removed; journal.rs/service.rs/mod.rs/tests.rs are sha256-identical to the pre-probe state; ack_probe.rs deleted.
