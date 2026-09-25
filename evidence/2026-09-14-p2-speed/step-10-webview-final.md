# Step 10 — final actual native WebView recheck

2026-09-14 19:38–19:43 UTC. **Actual native WebView2 media/pitch and program elapsed-clock gates PASS at 50/100/150/200%. Ordinary debug executable restored successfully afterward.** No production/browser/configuration files changed by this task; no dependencies or commits. Only evidence script modification is an optional output-directory argument plus directory creation; previous raw measurements/screenshots remain untouched.

## Runtime and execution

Launched the same previously compiled isolated `apps/desktop/src-tauri/target/debug/supa-video-desktop.exe` without rebuilding first, serving latest dev frontend (RAF-independent media clock and directed microsecond seeks). Original isolated compiled identifier/devUrl documented in `step-10-webview.md`; initial URL recorded by CDP was the speed fixture. Source hashes for this run are in `webview-final/source-hashes.json`.

- Vite task **209beab9-a90f-4fcc-9636-3fbd6bf594c7**, wrapper PID 17752, actual server PID **11172**: `pnpm --filter @supa-video/desktop dev --host 127.0.0.1 --port 1420 --strictPort`. Readiness observed; HTML HTTP 200.
- Native launch execution **a6ef41c4-e4ee-422e-ac71-7633a0814bb4**, native PID **14384**, WebView parent PID **17632**. Scoped environment only: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223`; `WEBVIEW2_USER_DATA_FOLDER=C:\Users\SPARTA~1\AppData\Local\Temp\supa-speed-webview-final-20260914-1938`. No extra autoplay/security switches supplied.
- Actual installed `msedgewebview2.exe` **152.0.4191.66**, embedded-browser/native parent chain saved in `webview-final/webview-processes.json`; native Tauri internals true on every measured page. `webview-final/webview-ports.json` proves both listeners were **127.0.0.1 only**.
- First connection attempt **5efae13f-0c6b-471f-85e5-52c417d32a7d** failed ECONNREFUSED before WebView CDP was ready: no page navigation or measurement occurred. Inspection **a4ec2758-0e4d-44c0-8cb9-f46593e3497d** then confirmed listener readiness. This startup failure is retained explicitly, not hidden as a passing test.
- One completed measurement run **3c2762f8-58f7-438b-abf3-24586679429b**, exit 0, 9.654s: `node evidence/2026-09-14-p2-speed/webview-probe.cjs evidence/2026-09-14-p2-speed/webview-final`. No measured gate rerun, tolerance change, or retry-to-green.

## Unchanged gates and actual results

Same seek assertion, Play gesture, 350ms onset exclusion, approximately 1s sample, actual decoded audio through AudioContext FFT32768, and requestVideoFrameCallback count as prior run. Criteria unchanged: exact playbackRate; preservesPitch; absolute media multiplier error <0.08; pitch error <1%; signal >−60dB; >10 decoded callbacks; seek assertion at two decimal places (prior documented 0.01s). Separate program elapsed error threshold remains strictly <2/30s. Script exit code checks media gates; the clock booleans below were also explicitly inspected.

| Speed | Source seek s |  Media/wall |    Pitch Hz |   Peak dB | Callbacks | Program elapsed error s | Media/pitch | Clock |
| ----- | ------------: | ----------: | ----------: | --------: | --------: | ----------------------: | ----------- | ----- |
| 50%   |      1.500001 | 0.500040857 | 1000.488281 | −46.07214 |        19 |            +0.029833333 | PASS        | PASS  |
| 100%  |      2.000001 | 1.003977840 | 1000.488281 | −46.09525 |        40 |            −0.001800000 | PASS        | PASS  |
| 150%  |      2.500001 | 1.500919712 | 1000.488281 | −46.11284 |        42 |            −0.001400000 | PASS        | PASS  |
| 200%  |      3.000001 | 1.998600979 | 1000.488281 | −46.11264 |        78 |            −0.000700000 | PASS        | PASS  |

All audio contexts running, sample rate 48000Hz, user activation true, preservesPitch true. Full raw start/end/runtime records: `webview-final/webview-measurements.json`. Actual WebView viewport screenshots after pressing Pause: `webview-final/webview-{50,100,150,200}.png`. These are not OS window-chrome screenshots, PCM recordings, or synchronous decoded-pixel identity assertions.

## Cleanup and ordinary binary restoration

Cleanup execution **8bb4174b-a0f6-4805-95b5-fbc5553f82c1**: CloseMainWindow returned true for **14384**, WaitForExit completed (exit code unavailable in this PowerShell process object). Stopped only our Vite **11172**; managed wrapper subsequently exited following intentional server termination. No unrelated processes stopped. Disposable profile and prior isolated job-state directory remain local.

Ran **`unset TAURI_CONFIG; cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline`**, foreground without timeout, execution **0f5d938f-002c-4fee-b0dd-c57e125080ff**, **exit 0**, 139.291s (Cargo reported 2m18s). Desktop crate recompiled; only informational linker-output warning. Ordinary debug EXE and DLL regenerated without isolated TAURI_CONFIG.

Final verification **c5d5898b-716a-4a3a-9048-94ba526baf99**, exit 0: no listeners on 1420/9223, no own native/WebView/Vite processes remaining; rebuilt EXE timestamp/size saved in `webview-final/cleanup-build.json`. Direct byte inspection of both EXE and DLL found no isolated identifier `com.supavideo.speed-webview-probe-20260914`. Restored ordinary application was deliberately not launched against existing user state.

## Explicit gaps / boundary of conclusion

This closes the previously failing native 50% elapsed-clock observation under the unchanged gate, alongside the four native media/pitch gates. It does not establish broader live A/V one-frame synchronization or synchronized pixel identity. Near-end endpoint assertions, pause-stability assertions, raw audition and Final controls were not measured in this recheck; Pause was exercised only for screenshots. No fractional/multilayer/hardware-loopback/full-PCM/export/reopen/accessibility tests here. Prior parent-reported eight compiler→native parity outputs and eight browser decoded-seek passes were not rerun or independently verified by this task. Parent's live A/V measurement remains a separate instrumentation issue; no claim that these elapsed-clock/FFT results resolve it.
