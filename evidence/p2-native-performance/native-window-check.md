# Bounded native preview-window check — playback collected, unloading assertion failed

## Outcome (RUNTIME, 2026-09-20 UTC)

The fixed source was rebuilt as a fresh isolated Windows release and exercised once with the real native 1,000-item / 30-fps fixture. Native picker/import, preparation, project reopen and a 60.0194-second playback sample completed. The first return-to-start video seek reached the media-readiness predicate, then the unloading assertion failed. The remaining distant video/audio seeks were not executed. This is **not a passed native-window acceptance check**, and P2 remains incomplete.

No application source was changed in this continuation. A new bounded evidence driver, `verify-native-window.mjs`, reuses the existing native session, real picker/project, playback, seek and resource helpers. Existing dirty work and earlier artifacts remain unchanged. No downloads, installs, exports, further optimizations, commits, full matrix or soak were performed.

## Fresh build and source identity

- Build execution `2b2697db-fe7d-4149-a08c-48f33f90de6d`, exit 0: `node evidence/p2-native-performance/assemble-release.mjs native-uninstrumented`.
- Build receipt: `runs/release-x7bGX5/receipt.json`, SHA-256 `4847c342bfbe16b7d8148ea85fc12b80110b1cc5b3e7ea481ece2d6f2152d162`.
- Executable SHA-256: `00a63c0fbe42e3bf8caeda7e929cbec170ee7af8c29f232bda20dc90f177cdee`; verified before launch and after teardown by the native session helper.
- HEAD `809e1102963370c6461f8ad50f7ce28f7f0209bd` **plus dirty source**, not HEAD-only verification. Build source inventory digest `af04a95a7e9d956c80f4b31290a033c1d3364e526854f027632a9dd522b4a48d`.
- Run inventory digest `a4c7ede8c210f9f2c1447d1310f73b70f65c5e64812442dae186eac03547040d` matched before/after. Comparison against build inventory found only the newly added evidence driver; no application input drift. Detailed inventories are linked by `inputs.json`, `source-after.json` and the build receipt.
- Offline/locked, no-bundle assembly with new identifier, frontend and target directories; all seven bundled resources matched pinned source bytes. No IPC/CSP/asset policy was relaxed.
- WebView version: `153.0.4234.48`. Host/power/display metadata is retained in `runs/native-window-zEgu4z/host.json`.
- Ordinary production React, with the existing build-only real-seek entry and a temporary browser media observer. This is not a React profiling run and not an observer-free control.

## Execution and measurements

Execution `7d34b105-f86d-4219-a239-23bb96fafc7c`, **exit 1**, approximately 142 seconds including setup, preparation and cleanup. Artifacts: `runs/native-window-zEgu4z/`.

The observer measured 60.0194 seconds after five seconds of warmup. The transport still reported playing at the endpoint; the snapshot returned and the normal pause action completed. There were 676 recorded frame callbacks; frame-gap p50 33.3 ms, p95 50.1 ms, p99 2,050.1 ms, max 2,050.2 ms. The existing **32-video lifetime tracking cap was reached**. These partial observations, including intentional fixture gaps, do not establish whole-session dropped-frame totals, smoothness, physical presentation timing or A/V synchronization. React commit metrics are unavailable in this nonprofiling build. No audible-output proof was attempted; only this application's monitor was muted.

Resource sampling ran externally every five seconds and retained per-owned-process CPU time, private bytes, working set, handles and process counts. Twenty-eight samples cover setup through cleanup; twelve fall within the measured playback interval.

| Sampled metric                                                        |                              Value |
| --------------------------------------------------------------------- | ---------------------------------: |
| Largest single WebView private memory during playback                 | 238,698,496 bytes / **227.64 MiB** |
| Peak summed app + WebView + media-tool private memory during playback | 550,322,176 bytes / **524.83 MiB** |
| Peak same native process sum across setup/preparation/playback        |     808,796,160 bytes / 771.33 MiB |
| Peak summed native working set during playback                        |                  738,467,840 bytes |
| Peak summed native handles during playback                            |                              4,019 |
| Peak native process count during playback                             |                                  8 |

Native sums exclude the Node controller and diagnostic launchers. Summed working sets may count shared pages more than once. CPU counters are retained per PID/creation identity; no whole-machine CPU-utilization or GPU-utilization claim is made. These are sampled high-water values, not absolute maxima, memory slopes or leak-free proof. The earlier 11.87-GiB/114-MiB figures were **browser idle** measurements, not a comparable native-playback before/after baseline.

## Failure and unfinished seek checks

At `02:14:57.584Z`, the first post-playback return-to-start video seek satisfied the existing real-media readiness/currentTime predicate. At `02:14:57.587Z`, an old detached media element was observed with:

- `paused: true`
- `src` attribute absent (`null`)
- `readyState: 0`
- `currentSrc` still containing the previous isolated native asset URL

The new driver's strict immediate `currentSrc === ""` assertion failed. This establishes a mismatch with that assertion, **not proof of retained decoder/buffer memory or an application leak**. The snapshot does not distinguish WebView property behavior, asynchronous reset timing and actual resource retention. The assertion was not weakened and no app change or retry was made.

Last completed measured operation: `unload.inspect`. No await remained pending: the assertion threw, `session.close` completed, and `worker.finished` recorded failure. The eight-check seek suite did not complete even its first full recorded check because unloading inspection occurs before the per-seek endpoint record. Distant middle/end video seeks and all audio seeks remain unverified natively in this fresh build. Browser seek evidence remains separately valid, not a substitute.

Recommended next authorized work: resolve the native unloading observation with a bounded, event-aware diagnostic and then complete the distant video/audio seek checks on this identified build. Do not infer that a native compositor or another optimization is needed from this assertion alone.

## Ownership, bounds and cleanup

- Read-only process preflight `bb859b2e-9771-4e78-91de-e1562bb948d9` found no existing diagnostic/native process. The driver repeated duplicate-run refusal before starting.
- Existing hash-verified launcher `runs/launcher-6bddff38882644cfb9a5ee567098e082/receipt.json` owned the Node worker and inherited descendants in a Windows Job Object with an external **420-second watchdog**; the nested native job had a 390-second lease. Existing cleanup drain/fallback bounds were retained. Operation timestamps were persisted before/after each driver await and around playback/seek operations.
- Before CDP attachment, the native helper proved OS executable/PID/creation identity and loopback port ownership. After attachment, it validated the expected Tauri page URL. Evidence: `native-identity.json` and `ownership.json`.
- Native app PID 3448, creation `134343439655317529`: nested job reported `empty: true`. The application was still running before owned teardown (`rootExitBeforeCleanup: 259`); this is **owned forced cleanup**, not an ordinary window-close/persistence proof.
- Worker PID 7832, creation `134343439640041913`: outer job reported worker failure exit 1 and `empty: true`; launcher itself exited 0. A successful launcher cleanup does not convert the failed measurement into a pass.
- Independent final resource sample at `02:14:59.9438342Z`: `rootAlive: false`, `processCount: 0`. Post-run process inventory contained only the still-running evidence controller, not the native app or its children. No unrelated processes were terminated; neither watchdog expired.

## Affected checks

- Generic harness suite: 9 tests passed in `297fb0f1-5c21-4177-8718-673bc14edc65`. The combined invocation exited 1 because the separate native harness lacked its required launcher-receipt environment variable; lint was not reached.
- Initial native-only invocation `63cf1bf6-df0a-4e97-ae98-d243f26b41a4` passed 5 tests but failed the fixture test because the media-receipt variable was also required; lint was not reached. These were invocation setup failures, not relabeled passing runs.
- Correctly configured native harness: **6/6 passed**, including actual owned-process cleanup and lease expiry. New driver's targeted ESLint passed. Combined execution `9ab927ff-580d-4afb-8d0e-46d011288543`, exit 0.
- No app behavior was edited, so prior 87-test/typecheck evidence remains historical; it was not claimed as a fresh test run. The new native measurement is the actual runtime verification of this driver, and it failed as recorded above.

## Artifact hashes

All following files are under `runs/native-window-zEgu4z/`:

| Artifact                  | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `report.json`             | `70138b8209d288604d819db8b37c79f2a034c1b47288f6d995bcd72db7577013` |
| `result.json`             | `690e0bdc1c62f2ab6871cd164170854016681a14d4b27264efb52e47b8743c16` |
| `playback.json`           | `821436f8b5ad7e4a45089797436db120cfe157608daa8fdb98ea4b9976123697` |
| `Preview-playback-0.json` | `321191af6af1b58cf52cc8e3ad291925f564be3f35394e0be1559b7977c158f2` |
| `unloading.jsonl`         | `2f41559d75766aa536d512d8c32915d63016f38020a4350dc374405a6f576139` |
| `resources.jsonl`         | `ef0e2b7b2dd117168fdc7957120661a710fd122074bf5dd461f2371a78e2f072` |
| `cleanup.json`            | `fc17f1dc4eb1719e3c1272269424e94dcb0bc8e027fe7bc882ef85a139f15c77` |
| `native-identity.json`    | `98b54cb4cb57c231df337d6cb59ab447f4d46a98a31bc08ac8d09212d18ad5fd` |

P2 remains in progress. The full matrix, observer-overhead comparisons, 60-minute session, final criterion reconciliation and other previously recorded gaps are not satisfied by this bounded check.
