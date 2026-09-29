# Cache publication race test under `pnpm test:native` (29 Sep 2026)

Test: `video::tests::race_actual_prepared_publication_and_completed_reuse`, which asserts at `cache.rs:1628`: "publisher did not acknowledge upsert".
Base commit `60407c1`. The only product-tree change is `scripts/test-native.mjs`. `cache.rs` and the test are byte-identical (sha256 `a4dd7b1e…4464` before and after).

## Verdict: a test timing assumption under load, not a publisher race

- **No lost wake-up.** `reached`/`resume` are buffered `sync_channel(1)`. The hook is installed before the publisher thread starts and fires exactly once (`publication.take()`).
- **A late publisher is still correct.** `worker.finish()` pre-sends `resume` and joins the publisher before the assert. A publisher that reaches the gate late buffers its send and completes normally. The only thing that fails is the test's deadline.
- **The publisher never crashed.** No failure log contains a publisher panic, even though the publisher is joined first.
- **The 10 s deadline measures setup.** It starts when the publisher thread is spawned and covers the whole `prepare_asset_durable` pipeline (job enqueue, SQLite transitions, fake `cmd.exe` probe/encode scripts, artifact registration). Alone, the test takes about 1.2 s per case. Under the parallel suite a fresh Proxy/ThumbnailTile case can take more than 10 s.
- **Nothing is shared with the durable-ack test.** That test uses its own tempdir and service, no runtime, no env and no media tools. The crate has no statics. The two tests share only the libtest thread pool and the machine.

## Process check
No orphaned test binaries, cargo, ffmpeg/ffprobe, findstr or chrome-headless-shell processes were running. None were stopped.
Background load came from long-running user apps (Edge WebView2, Diffusion Studio, Discord) on a 6-core/12-thread CPU.

## Attribution: wrapper (A) vs original direct command (C), ABBA order
Measured with a temporary diagnostic (since removed) that recorded each case's time from publisher spawn to the gate.
When the 10 s wait failed, an extra 60 s wait (diagnostic-only) showed whether the publisher arrived late or never.

| Run | Mode | Race | Late arrival (case, ms) | Max on-time gate ms | Parallel pass | Tests >60 s |
|---|---|---|---|---|---|---|
| 1 | A | FAIL | ThumbnailTile fresh, 12573 | 7043 | 127.97 s | 9 |
| 2 | C | FAIL | Proxy fresh, 12071 | 238 | 139.53 s | 10 |
| 3 | C | FAIL | Proxy fresh, 22120 | 81 | 150.39 s | 13 |
| 4 | A | FAIL | ThumbnailTile fresh, 21424 | 8981 | 128.81 s | 10 |
| 5 | A | FAIL | ThumbnailTile fresh, 27817 | 7758 | 152.96 s | 12 |
| 6 | C | FAIL | ThumbnailTile fresh, 15886 | 7201 | 115.28 s | 9 |
| 7 | C | pass | — | 5550 | 122.81 s | 9 |
| 8 | A | FAIL | ThumbnailTile fresh, 11554 | 3820 | 111.95 s | 8 |

A failed 4/4 and C failed 3/4. Every failure was a late arrival (11.6-27.8 s); no publisher ever failed to arrive.
The direct command fails at the same rate, so the wrapper is not implicated. The earlier 0/10 "after" set came from a quieter machine state.

## Fix
`scripts/test-native.mjs` now runs this test in the serial isolated pass together with the durable-ack test.
- The parallel pass skips both tests by exact name.
- The isolated pass runs both with `--exact --test-threads=1`.
- The guard requires `test <name> ... ok` for each test and `2 passed; 0 failed`.

No timeout, gate or assertion was changed.
Trade-off: this test no longer runs under parallel-suite load. Its purpose is a deterministic interleaving, not a load test.

## Proof: 10 sequential `pnpm --dir apps/desktop test:native` runs, no reruns

| Run | Exit | Parallel pass | Isolated pass | Race | Ack p95 | Other failures |
|---|---|---|---|---|---|---|
| 1 | 0 | 536 passed / 0 failed / 2 filtered out | 2 passed | ok | 14.80 ms | — |
| 2 | 0 | 536 / 0 / 2 filtered out | 2 passed | ok | 19.10 ms | — |
| 3 | 0 | 536 / 0 / 2 filtered out | 2 passed | ok | 14.71 ms | — |
| 4 | 0 | 536 / 0 / 2 filtered out | 2 passed | ok | 16.25 ms | — |
| 5 | 0 | 536 / 0 / 2 filtered out | 2 passed | ok | 16.46 ms | — |
| 6 | 101 | 535 / 1 / 2 filtered out | 2 passed | ok | 19.01 ms | scheduler cancellation timeout (below) |
| 7 | 101 | 525 / 11 / 2 filtered out | 2 passed | ok | 17.10 ms | 11 bundled-media tests (below) |
| 8 | 0 | 536 / 0 / 2 filtered out | 2 passed | ok | 18.17 ms | — |
| 9 | 0 | 536 / 0 / 2 filtered out | 2 passed | ok | 12.92 ms | — |
| 10 | 0 | 536 / 0 / 2 filtered out | 2 passed | ok | 17.02 ms | — |

- Race test: **10/10 pass** in the isolated pass. `ranExactly: true` in every run.
- Ack p95: 12.92-19.10 ms, all under the 300 ms budget.
- Whole command: 8/10 exit 0.

## Out-of-scope parallel-pass flakes (listed, not fixed, no reruns)
- `video::jobs::scheduler::tests::queued_and_running_cancellation_settle_once`: 1/10 (run 6). `scheduler.rs:1829`, `Elapsed(())`, which is a tokio timeout under load.
- Run 7 only: 11 bundled-ffmpeg tests failed together. The errors were `ToolUnavailable` ("Bundled media tools are unavailable", executable `bundled`/`ffmpeg`/`ffprobe`) and `NotFound` (os error 2):
  - `audio_export::render_audio_gain_and_fades_actual_compiler_output`
  - `bundled_resolver_only_bounded_batch`
  - `render_caption_boundary_bundled_{24000_1001_exact, 24000_1001_rounded, 30000_1001_rounded, 30_exact, ffmpeg}_v1_v2`
  - `render_speed_bundled_actual_media`
  - `speed_export_parity::{render_multilayer_production_compiler_independent_hidden_and_muted, render_speed_production_compiler_actual_parity}`
  - `slow_audio_onset::render_silent_onset_production_compiler_actual_parity`

  Runs 8-10 found the tools again. The same `ToolUnavailable` ffprobe failure also hit the direct command in attribution run 2. So it is transient tool resolution on this machine and unrelated to the wrapper. Not diagnosed further.
- The two jobs timeout tests listed in `durable-ack.md` did not fail in this set.
