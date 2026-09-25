# Bounded acknowledgement parallel-attribution experiment — 2026-09-14

## Outcome

**RUNTIME: the retained acknowledgement p95 failure did not reproduce. Attribution of that historical failure remains inconclusive; P2 stays open.** The single isolated debug invocation measured **14.1110 ms** p95; the single full 32-thread debug invocation measured **76.7411 ms** p95. Both satisfy the unchanged strict **<300 ms** debug budget. The parallel arm nevertheless contained three individual calls above 300 ms, including two above one second. The gate is p95, not maximum latency.

The full library suite failed independently on cancellation readiness: **306 passed, 1 failed, 20 ignored**, exit **101**. No fix, retry, deadline change, workload exclusion, release invocation, Roadmap update, or cancellation/supervisor reclassification was performed. The release **<100 ms** budget remains unchanged and was not measured in this experiment.

## Execution and retained evidence

Exactly these two commands were run, once each, sequentially:

```bash
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::project::tests::durable_command_acknowledgement_p95_meets_budget -- --exact --nocapture --test-threads=1
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture --test-threads=32
```

| Arm                | Profile                       | Cargo build/preparation duration | Library execution duration | Acknowledgement p95 | Independent exit | Library result                   |
| ------------------ | ----------------------------- | -------------------------------: | -------------------------: | ------------------: | ---------------: | -------------------------------- |
| Isolated, 1 thread | test, unoptimized + debuginfo |                          49.35 s |                     1.09 s |          14.1110 ms |                0 | 1 passed, 326 filtered out       |
| Full, 32 threads   | test, unoptimized + debuginfo |                           0.73 s |                    77.02 s |          76.7411 ms |              101 | 306 passed, 1 failed, 20 ignored |

Cargo's `Finished` duration includes build/preparation, not acknowledgement time. The isolated invocation also reached main (0 tests) and security integration (0 tests, 5 filtered out), both successful. The full invocation stopped after the failed library target; later integration/doc targets were not verified. The full command's foreground wall duration was 77.941 s.

Complete stdout/stderr, including all 100 JSON diagnostic records per arm, remain in the local foreground logs (not merely tool-output tails):

- Isolated: `C:/Users/SPARTAN PC/.gg/foreground/32420886-6309-4013-8f8c-f864db099eea.log`
  - SHA-256 `ced3d7a3da2ec32be6861e8b41a7dff07effa8a32dcccfac7ece4f899925e7b5`
  - Execution ID `32420886-6309-4013-8f8c-f864db099eea`, exit 0.
- Parallel: `C:/Users/SPARTAN PC/.gg/foreground/d2cdb569-c5f0-487b-9a51-86fbb6dbdf77.log`
  - SHA-256 `2329710c9cc4a6d13c1a9937c98863437c41b2ec7d670d215d4ec9d3da39beec`
  - Execution ID `d2cdb569-c5f0-487b-9a51-86fbb6dbdf77`, exit 101; started `2026-09-14T03:12:19.864Z`.
- Derived tables and integrity checks: `C:/Users/SPARTAN PC/.gg/foreground/7ad39359-ea05-434c-b40e-6c64d00e55ad.log`.
- Pre-run instrumentation diff and hashes: `C:/Users/SPARTAN PC/.gg/foreground/fd92c4f8-c09c-41eb-9b0c-298ecf12f334.log`.
- Post-pair instrumented hash check: `C:/Users/SPARTAN PC/.gg/foreground/b2dafa46-e52d-4014-b2d1-654e213cde5f.log` (all six match pre-run hashes).

These are local retained artifacts, not portable repository attachments. The foreground logger can insert `[stdout]`/`[stderr]` chunk labels mid-line. Analysis removed only those labels, split at `[DBG-ack-a71c] `, and decoded one JSON object per marker. Both arms have indices 0–99 in order, exactly 100 records, no overflow, and 17 exclusive intervals for ordinary calls / 29 for checkpoint calls. Both arms exercised CPU collection without unavailable samples.

## Measurement method and limitations

**CODE:** A test-only thread-local recorder was enabled only by the synchronous acknowledgement fixture. All 100 command slots and 64 stage slots per command were allocated before timing; other tests collected no records. The helper was excluded from production builds. No manifest or lockfile change was needed. The pinned Windows 0.62.2 API used initialized FILETIME outputs, treated errors as unavailable, combined kernel+user execution time, and did not close the current-thread pseudo-handle.

Original setup, request construction, timer boundaries, `timings[94]`, all 100 commands, assertions, and durability operations were retained. Diagnostics were buffered until after the measured loop and printed before the unchanged assertion. Command index is zero-based; the tables below use one-based journal record number. Checkpoint flags at 25/50/75/100 were derived from that fixture's known revision-zero schedule and confirmed by actual snapshot stages.

**Exclusive wall intervals:** Each boundary ended the preceding interval; its own measured CPU-query/recording work was separately accumulated as observer wall time, then the next interval began. Stages are not nested and are not double-counted. Repeated snapshot create/write/sync stages (new and previous snapshot) are summed in the tables. Outer wall is the original acknowledgement measurement. Residual = outer wall − sum(exclusive stage wall) − measured observer wall. It includes entry/return/drop work outside the first/last boundary and measurement bookkeeping not otherwise charged.

`append_return` is important: it begins after the sync boundary and ends in the service after append returns. It includes failpoint checking, local file/buffer destruction and return unwinding; **it is not another sync span and is not a direct measurement of file-close latency**. The recorded long waits cannot be assigned exclusively to close, allocator, scheduling, or a filesystem filter without another experiment, which this plan does not authorize.

**CPU caveat:** FILETIME's 100 ns unit is not accounting resolution. Observed increments are 15.625 ms (and multiples), producing zero values for real work and sometimes CPU greater than the short corresponding wall interval. CPU snapshots are taken within boundaries; their deltas include some observer work, and outer CPU collection brackets slightly more than the original wall timer. Aggregate stage CPU can also be distorted by systematic tick attribution (for example parallel journal hashing reports 593.75 ms CPU against 440.7767 ms wall). Do not subtract these counters per short stage to calculate precise waiting time, and do not interpret zero as proof of no computation. Outer aggregate CPU is more informative than any single short stage, but remains a coarse counter measurement.

The isolated arm calibrates directly measured observer cost, not total causal observer overhead: there was no matched uninstrumented current-tree arm. Boundary/TLS access outside the measured observer interval, cache effects, CPU accounting perturbation, printing after the loop, and disabled hooks in other tests are not fully isolated. This is one ordered pair, not a randomized or repeated causal experiment; host activity and cache state were uncontrolled.

## Aggregate counts, grouping, and observer cost

All time values below are milliseconds. Group p95 uses nearest rank `ceil(0.95*n)-1`; the all-command row remains the original sorted index 94. Four-sample checkpoint p95 equals maximum and should not be treated as a stable distribution estimate.

| Arm / group              |   n |   Median |      p95 |   Maximum | Calls >=300 ms | Calls >300 ms | Total wall | Total CPU |
| ------------------------ | --: | -------: | -------: | --------: | -------------: | ------------: | ---------: | --------: |
| Isolated / all           | 100 |  9.61535 |  14.1110 |   30.4634 |              0 |             0 |  1047.0966 |  921.8750 |
| Isolated / checkpoint    |   4 | 28.67790 |  30.4634 |   30.4634 |              0 |             0 |   109.4675 |  109.3750 |
| Isolated / noncheckpoint |  96 |  9.56905 |  12.9930 |   14.5543 |              0 |             0 |   937.6291 |  812.5000 |
| Parallel / all           | 100 | 17.73030 |  76.7411 | 1101.3994 |              3 |             3 |  4794.6703 | 1531.2500 |
| Parallel / checkpoint    |   4 | 46.03815 |  56.9249 |   56.9249 |              0 |             0 |   174.7868 |  125.0000 |
| Parallel / noncheckpoint |  96 | 17.52785 | 162.9112 | 1101.3994 |              3 |             3 |  4619.8835 | 1406.2500 |

| Arm      | Observer total | Observer median/call | Observer max/call | Residual total | Residual min/max per call | Sum stage CPU |
| -------- | -------------: | -------------------: | ----------------: | -------------: | ------------------------- | ------------: |
| Isolated |         1.8267 |              0.01645 |            0.0568 |         0.2646 | 0.0016 / 0.0126           |      921.8750 |
| Parallel |         4.2045 |              0.03150 |            0.8330 |         0.3829 | 0.0019 / 0.0088           |     1531.2500 |

Directly measured observer time is about 0.174% / 0.088% of aggregate outer wall, respectively. It is small relative to the observed tails; this does not prove total observer impact is negligible. No samples or stages had unavailable CPU, and stage CPU sums equal outer CPU sums in these captures.

## Slowest six — isolated

Each cell is **wall / CPU ms**, not wall-minus-CPU. `*` marks a checkpoint. Zero snapshot values in ordinary calls mean not executed. Each column is one command; outer wall/CPU is the total and must not be added to the stage rows.

| Stage                        |      Record 25* |     Record 100* |      Record 75* |      Record 50* |       Record 54 |       Record 77 |
| ---------------------------- | --------------: | --------------: | --------------: | --------------: | --------------: | --------------: |
| outer wall/CPU               | 30.4634/31.2500 | 30.2137/31.2500 | 27.1421/31.2500 | 21.6483/15.6250 | 14.5543/15.6250 | 14.1110/15.6250 |
| request_validation           |   0.3403/0.0000 |   0.1086/0.0000 |   0.1248/0.0000 |   0.0976/0.0000 |   0.2066/0.0000 |   0.1075/0.0000 |
| lookup_lock                  |   0.0161/0.0000 |   0.0065/0.0000 |   0.0114/0.0000 |   0.0056/0.0000 |   0.0152/0.0000 |   0.0059/0.0000 |
| payload_hash_paths           |   0.4126/0.0000 |  0.1073/15.6250 |   0.1081/0.0000 |   0.0947/0.0000 |   0.1833/0.0000 |   0.1129/0.0000 |
| transition                   |   4.8858/0.0000 |   2.9686/0.0000 |  2.5390/15.6250 |   2.1002/0.0000 |  3.4920/15.6250 |   3.4265/0.0000 |
| source_resolution_grants     |   0.5559/0.0000 |   0.2205/0.0000 |   0.2065/0.0000 |   0.2471/0.0000 |   0.2599/0.0000 |   0.2910/0.0000 |
| record_result_preparation    |  6.2991/15.6250 |   2.3508/0.0000 |   2.5560/0.0000 |   2.6380/0.0000 |   4.2103/0.0000 |  4.5452/15.6250 |
| append_entry                 |   0.0238/0.0000 |   0.0101/0.0000 |   0.0165/0.0000 |   0.0142/0.0000 |   0.0207/0.0000 |   0.0203/0.0000 |
| journal_hash_serialize       |   4.7593/0.0000 |   2.5712/0.0000 |   2.4457/0.0000 |   2.3873/0.0000 |   4.1243/0.0000 |   3.9177/0.0000 |
| journal_metadata_open        |   0.2417/0.0000 |   0.1017/0.0000 |   0.0826/0.0000 |   0.1032/0.0000 |   0.1083/0.0000 |   0.1200/0.0000 |
| journal_write_flush          |   0.1581/0.0000 |   0.0886/0.0000 |   0.0804/0.0000 |   0.0833/0.0000 |   0.1257/0.0000 |   0.0892/0.0000 |
| journal_sync_all             |   1.5969/0.0000 |   2.0833/0.0000 |   1.2220/0.0000 |   1.1962/0.0000 |   1.4130/0.0000 |   1.2684/0.0000 |
| append_return                |   0.1024/0.0000 |   0.0487/0.0000 |   0.0429/0.0000 |  0.0825/15.6250 |   0.0921/0.0000 |   0.0502/0.0000 |
| session_update               |   0.0725/0.0000 |   0.1119/0.0000 |   0.0871/0.0000 |   0.0632/0.0000 |   0.1711/0.0000 |   0.0911/0.0000 |
| checkpoint_return_or_skip    |   0.0185/0.0000 |   0.1341/0.0000 |   0.0445/0.0000 |   0.0407/0.0000 |   0.0002/0.0000 |   0.0001/0.0000 |
| projection_result            |   0.0002/0.0000 |   0.0007/0.0000 |   0.0003/0.0000 |   0.0002/0.0000 |   0.0005/0.0000 |   0.0002/0.0000 |
| finish_return                |   0.0580/0.0000 |   0.0885/0.0000 |   0.0355/0.0000 |   0.0363/0.0000 |   0.0587/0.0000 |   0.0198/0.0000 |
| idempotency_result           |   0.0243/0.0000 |   0.0567/0.0000 |   0.0190/0.0000 |   0.0204/0.0000 |   0.0385/0.0000 |   0.0200/0.0000 |
| checkpoint_entry             |   0.0244/0.0000 |   0.0027/0.0000 |   0.0025/0.0000 |   0.0024/0.0000 |   0.0000/0.0000 |   0.0000/0.0000 |
| snapshot_preparation         |  5.5814/15.6250 | 12.3120/15.6250 | 11.1747/15.6250 |   6.3922/0.0000 |   0.0000/0.0000 |   0.0000/0.0000 |
| snapshot_directory           |   0.2562/0.0000 |   0.3222/0.0000 |   0.2051/0.0000 |   0.2141/0.0000 |   0.0000/0.0000 |   0.0000/0.0000 |
| snapshot_create_temp         |   0.4706/0.0000 |   0.4450/0.0000 |   0.3558/0.0000 |   0.3483/0.0000 |   0.0000/0.0000 |   0.0000/0.0000 |
| snapshot_write_flush         |   0.1882/0.0000 |   0.2503/0.0000 |   0.1736/0.0000 |   0.1748/0.0000 |   0.0000/0.0000 |   0.0000/0.0000 |
| snapshot_sync_all            |   2.8514/0.0000 |   3.8630/0.0000 |   4.0625/0.0000 |   3.5860/0.0000 |   0.0000/0.0000 |   0.0000/0.0000 |
| snapshot_read_previous       |   0.1694/0.0000 |   0.2121/0.0000 |   0.1879/0.0000 |   0.1785/0.0000 |   0.0000/0.0000 |   0.0000/0.0000 |
| snapshot_promote_previous    |   0.6811/0.0000 |   0.7468/0.0000 |   0.6124/0.0000 |   0.8760/0.0000 |   0.0000/0.0000 |   0.0000/0.0000 |
| snapshot_promote_main_parent |   0.6158/0.0000 |   0.9599/0.0000 |   0.7083/0.0000 |   0.6179/0.0000 |   0.0000/0.0000 |   0.0000/0.0000 |
| observer wall only           |          0.0568 |          0.0367 |          0.0345 |          0.0447 |          0.0296 |          0.0231 |
| residual wall only           |          0.0026 |          0.0052 |          0.0025 |          0.0027 |          0.0043 |          0.0019 |

## Slowest six — parallel

Same exclusive wall/CPU units. All six are noncheckpoint commands; no checkpoint/snapshot stages executed in these columns, so those rows are omitted rather than represented as measured zero-duration operations.

| Stage                     |          Record 8 |         Record 11 |        Record 9 |       Record 10 |         Record 7 |       Record 20 |
| ------------------------- | ----------------: | ----------------: | --------------: | --------------: | ---------------: | --------------: |
| outer wall/CPU            | 1101.3994/15.6250 | 1048.0283/15.6250 | 339.6043/0.0000 | 175.2986/0.0000 | 162.9112/15.6250 | 76.7411/15.6250 |
| request_validation        |     0.1659/0.0000 |     0.1975/0.0000 |   0.1517/0.0000 |   0.1740/0.0000 |    0.1599/0.0000 |   0.1579/0.0000 |
| lookup_lock               |     0.0039/0.0000 |     0.0108/0.0000 |   0.0048/0.0000 |   0.0085/0.0000 |    0.0129/0.0000 |   0.0092/0.0000 |
| payload_hash_paths        |     0.1606/0.0000 |     0.1618/0.0000 |   0.1531/0.0000 |   0.1541/0.0000 |    0.1626/0.0000 |   0.1643/0.0000 |
| transition                |    1.5554/15.6250 |     1.8635/0.0000 |   1.3705/0.0000 |   1.7468/0.0000 |    1.5917/0.0000 |   4.1898/0.0000 |
| source_resolution_grants  |     0.2021/0.0000 |     0.2760/0.0000 |  40.0850/0.0000 |   0.4176/0.0000 |    0.2594/0.0000 |  10.3054/0.0000 |
| record_result_preparation |     3.9043/0.0000 |     4.0744/0.0000 |   4.1421/0.0000 |   4.2521/0.0000 |    4.5129/0.0000 |  5.1595/15.6250 |
| append_entry              |     0.0173/0.0000 |     0.0179/0.0000 |   0.0181/0.0000 |   0.0350/0.0000 |    0.0181/0.0000 |   0.0243/0.0000 |
| journal_hash_serialize    |     3.9256/0.0000 |    4.1620/15.6250 |   2.8612/0.0000 |   3.6164/0.0000 |   5.0964/15.6250 |   4.2406/0.0000 |
| journal_metadata_open     |   126.1480/0.0000 |     0.1349/0.0000 |  75.0071/0.0000 |  81.1349/0.0000 |   36.9817/0.0000 |  47.1204/0.0000 |
| journal_write_flush       |     0.0994/0.0000 |     0.0885/0.0000 |   1.6061/0.0000 |   0.1139/0.0000 |    0.0734/0.0000 |   0.1408/0.0000 |
| journal_sync_all          |   672.6444/0.0000 |   308.2177/0.0000 | 120.2943/0.0000 |  63.6970/0.0000 |   75.4640/0.0000 |   4.5952/0.0000 |
| append_return             |   292.4318/0.0000 |   728.6773/0.0000 |  93.7824/0.0000 |  19.7913/0.0000 |   38.4172/0.0000 |   0.4349/0.0000 |
| session_update            |     0.0320/0.0000 |     0.0385/0.0000 |   0.0326/0.0000 |   0.0393/0.0000 |    0.0308/0.0000 |   0.0818/0.0000 |
| checkpoint_return_or_skip |     0.0001/0.0000 |     0.0006/0.0000 |   0.0001/0.0000 |   0.0003/0.0000 |    0.0001/0.0000 |   0.0008/0.0000 |
| projection_result         |     0.0002/0.0000 |     0.0001/0.0000 |   0.0001/0.0000 |   0.0003/0.0000 |    0.0010/0.0000 |   0.0003/0.0000 |
| finish_return             |     0.0383/0.0000 |     0.0506/0.0000 |   0.0335/0.0000 |   0.0431/0.0000 |    0.0653/0.0000 |   0.0553/0.0000 |
| idempotency_result        |     0.0265/0.0000 |     0.0222/0.0000 |   0.0226/0.0000 |   0.0368/0.0000 |    0.0305/0.0000 |   0.0231/0.0000 |
| observer wall only        |            0.0409 |            0.0313 |          0.0363 |          0.0331 |           0.0304 |          0.0333 |
| residual wall only        |            0.0027 |            0.0027 |          0.0027 |          0.0041 |           0.0029 |          0.0042 |

## Aggregate stage wall / CPU ms — all 100 calls

Repeated checkpoint I/O stages are summed. Each stage row is exclusive; these totals exclude observer wall and residual wall.

| Stage                        |          Isolated |          Parallel |
| ---------------------------- | ----------------: | ----------------: |
| request_validation           |    12.0422/0.0000 |   24.4536/31.2500 |
| lookup_lock                  |     0.7848/0.0000 |     1.0969/0.0000 |
| payload_hash_paths           |   11.3940/31.2500 |    18.9062/0.0000 |
| transition                   | 211.7283/187.5000 | 400.6118/234.3750 |
| source_resolution_grants     |   22.8601/31.2500 |  152.6376/46.8750 |
| record_result_preparation    | 278.4431/312.5000 | 459.4918/437.5000 |
| append_entry                 |     1.4937/0.0000 |    2.1004/15.6250 |
| journal_hash_serialize       | 265.7026/250.0000 | 440.7767/593.7500 |
| journal_metadata_open        |   11.4117/15.6250 |  399.2719/15.6250 |
| journal_write_flush          |     9.5896/0.0000 |   23.8239/15.6250 |
| journal_sync_all             |  140.4436/15.6250 | 1521.4683/46.8750 |
| append_return                |    6.5889/15.6250 |  1214.4094/0.0000 |
| session_update               |    7.6572/15.6250 |   17.1262/15.6250 |
| checkpoint_return_or_skip    |     0.2482/0.0000 |     3.9438/0.0000 |
| projection_result            |     0.0441/0.0000 |     0.0392/0.0000 |
| finish_return                |     2.7020/0.0000 |    5.7162/15.6250 |
| idempotency_result           |     2.0457/0.0000 |     3.5281/0.0000 |
| checkpoint_entry             |     0.0320/0.0000 |     0.0169/0.0000 |
| snapshot_preparation         |   35.4603/46.8750 |   52.1206/46.8750 |
| snapshot_directory           |     0.9976/0.0000 |     1.4572/0.0000 |
| snapshot_create_temp         |     1.6197/0.0000 |    5.0314/15.6250 |
| snapshot_write_flush         |     0.7869/0.0000 |     1.5748/0.0000 |
| snapshot_sync_all            |    14.3629/0.0000 |    22.3876/0.0000 |
| snapshot_read_previous       |     0.7479/0.0000 |     1.6011/0.0000 |
| snapshot_promote_previous    |     2.9163/0.0000 |     5.3529/0.0000 |
| snapshot_promote_main_parent |     2.9019/0.0000 |    11.1384/0.0000 |

## Interpretation: supported observations, not a proven historical cause

1. **RUNTIME / DEDUCED — filesystem-related and post-append waits dominate the largest new tails.** In record 8, metadata/open, sync, and append-return wall times are 126.1480, 672.6444, and 292.4318 ms. In record 11, sync and append-return alone are 308.2177 and 728.6773 ms. Outer CPU is only 15.625 ms for each >1 s call. This supports the filesystem-wait hypothesis for these observed calls more strongly than pure computation. The measured sync interval identifies time around `sync_all`, not physical device latency alone. Scheduling, filesystem filters, and close/return-related waits remain alternatives. No particular competing test or device is identified.
2. **RUNTIME / DEDUCED — computation also expands, but does not explain the longest tails.** Transition total wall grows 211.7283 → 400.6118 ms; record/result preparation 278.4431 → 459.4918 ms; journal hashing 265.7026 → 440.7767 ms. Total outer CPU grows 921.875 → 1531.25 ms while outer wall grows 1047.0966 → 4794.6703 ms. This is mixed inflation, not filesystem-only behavior. The CPU granularity and lack of scheduler traces prevent a clean split between computational cost and descheduling.
3. **RUNTIME / DEDUCED — history growth appears in ordinary transition cost, not in the largest parallel outliers.** Median transition times by noncheckpoint ranges 1–24, 26–49, 51–74, 76–99 are isolated 1.17365 / 1.71705 / 2.32420 / 2.86140 ms and parallel 1.99325 / 3.00220 / 3.82380 / 4.91535 ms. Ordinary outer medians in those ranges are isolated 8.71815 / 9.03575 / 9.70815 / 10.37255 ms, versus parallel 23.07510 / 16.67135 / 15.09135 / 18.35470 ms. The worst parallel calls occur at records 7–11 and 20, before this fixture's first checkpoint. All four checkpoints are the isolated arm's four slowest calls; none are among the parallel arm's slowest six. This weakens this fixture's checkpoint/history growth as the explanation for these largest parallel tails, but does not exclude load from other tests' checkpoints.
4. **DEDUCED — three >=300 ms samples are insufficient to fail sorted index 94.** At least six such samples would be needed. The observed large individual delays do not reproduce the retained failing p95, and a passing p95 does not establish consistently low maximum latency.

**Overall: inconclusive attribution of the retained failure.** No deterministic failing acknowledgement reproduction was established. No busy-timeout, antivirus, cancellation, or shared SQLite-lock defect is inferred. This pair neither proves the historical root cause nor identifies the responsible workload.

### Comparison with historical evidence (not new runs)

The approved plan retains a historical full-suite p95 of 354.6072 ms against 300 ms, versus six isolated debug/release p95s of 15.8983 / 13.2523 / 17.4303 ms and 7.0216 / 8.0339 / 6.3449 ms. Those measurements are not a matched current-tree baseline; the historical full run had temporary cancellation tracing, and historical cache/environment equivalence is unavailable. The new isolated debug p95 lies within the historical isolated debug range, but that does not quantify causal tracing overhead.

The new full debug suite also logged SQLite enqueue-plus-durable-event p95 **461.6942 ms** and 10k journal scan **4.1654231 s**, compared with historical **368.7941 ms** and **4.9196675 s**. Both are release-budget tests; neither was another debug budget failure. These interleaved results do not establish exact test overlap or a common cause. There were no comprehensive test start/end timestamps, device queue measurements, process-wide CPU profiles, scheduler traces, or external-host-activity controls.

## Independent failures and coverage limits retained

The only failed test was `video::jobs::scheduler::tests::cancellation_interrupts_each_automatic_retry_delay_without_requeue`, at `src/video/jobs/scheduler.rs:1131:10`, with `called Result::unwrap() on an Err value: Elapsed(())`. It is recorded here solely as the full arm's actual failure. No extra cancellation observation, probe, retry, or code/evidence/status change was made. `evidence/2026-09-13-cancellation-readiness-timeline.md` remains independently unresolved and untouched.

The log's `intentional blocking worker panic` at project IPC line 484 was not a second failed test. Existing symlink assertions reported unsupported setup (Windows privilege error 1314); these branches were not verified, and no policy was changed. The supervisor timeout test happened to pass in this full arm, but that does not resolve or reclassify `evidence/supervisor-timeout-unresolved.md`, which remains untouched and independently unresolved.

## Baseline and restoration record

Initial working-tree inspection showed all five prospective existing project files clean and no Cargo/rustc process running. Existing user changes in Cargo/cache/job/scheduler and other files were left untouched. No other agent-run build or test was started during this experiment.

HEAD at baseline: `b21a303c51c258d3aa63fa51217bcbb4508fef0f`. Baseline bytes (base64), hashes, and HEAD were captured before source edits in `C:/Users/SPARTAN PC/.gg/identities/com.ggcoder.local-fork/tool-output/2026-09-14/bash-0a363fc2568c.txt`. Initial status and empty prospective-file diff are retained in foreground execution `50b54824-833e-4505-95bb-200fec07654e`. Paths below are relative to `apps/desktop/src-tauri/src/video/project/`.

| File        | Baseline SHA-256                                                 |
| ----------- | ---------------------------------------------------------------- |
| mod.rs      | 10b11131e4be39b9275db646e9b37698916975ca627b338dd2d8ba6fa3e64e1a |
| tests.rs    | 100aa507a72f43dcfe509e49575629e40b35150b1a4740f6ebbddc803f466b90 |
| service.rs  | 0d26a34d6c5cc757a55e6163a62cb106a299dd1d48195d7caa3a93ded37e5f42 |
| journal.rs  | 7aa2bac531ce4a10bd592c6dbc602f217653c86923aa70c786d5d0da3abe7edb |
| snapshot.rs | 9bea91bc9a73451123d934608c62269beec3113c41b200c7b8ffdf6fa6a22c80 |

Instrumented helper SHA-256: `c7b783c8c4830e5ab20e3279b5cd92262e37ad6ee88f7d09a9907eee4542e6f1`. Pre-run and post-pair hashes match for all five source files plus helper, establishing identical instrumentation across the pair.

**RUNTIME — restored:** All five existing files were compared byte-for-byte against their captured baseline bytes and independently matched every SHA-256 above. The unchanged temporary helper was hash-checked and removed. The project source diff is empty; final status contains the pre-existing user changes plus this new evidence report. `git diff --check` produced no diagnostics. Restoration evidence: `C:/Users/SPARTAN PC/.gg/foreground/f943d542-295c-4159-a875-552e2e7ce738.log`.

This verifies exact source restoration, **not a post-restoration test pass**. No third Cargo invocation was run. Only this report remains as the experiment's repository change; P2, cancellation readiness, and the historical supervisor failure remain open and independently classified.
