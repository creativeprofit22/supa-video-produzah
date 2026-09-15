# Step 10 — actual Windows Tauri/WebView2 media probe

2026-09-14 18:42–18:49 UTC. **Actual native WebView2 playback-rate and decoded-audio pitch checks passed at 50/100/150/200%. Overall clock/parity gate remains open: 50% program-frame elapsed observation failed.** This is not a standalone Chromium substitute. No existing production, configuration, or browser-test files edited; no dependencies added or commits made.

## Runtime and isolation

- Compiled the actual `apps/desktop/src-tauri` application, default `desktop-runtime`, using `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline` (exit 0, 3m03s; linker informational warning). Process-scoped `TAURI_CONFIG` was `{"identifier":"com.supavideo.speed-webview-probe-20260914","build":{"devUrl":"http://localhost:1420/browser-tests/program-monitor-speed.html?speed=50"}}`. Only identifier/dev URL changed; security/CSP/capabilities untouched. This creates isolated app job state, avoiding recovery of existing user jobs. Native sources unchanged.
- **Build artifact caveat:** the ignored `target/debug/supa-video-desktop.exe` now contains that probe identifier/dev URL. Normal future build without `TAURI_CONFIG` must regenerate the ordinary application artifact. No tracked config changed.
- Started Vite via `pnpm --filter @supa-video/desktop dev --host 127.0.0.1 --port 1420 --strictPort`; observed readiness and HTML HTTP 200 / MP4 byte-range HTTP 206. Original config uses localhost:1420; fixture retained that origin.
- Launched compiled EXE with process-scoped `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223'` and `WEBVIEW2_USER_DATA_FOLDER='C:\Users\SPARTAN PC\AppData\Local\Temp\supa-speed-webview-20260914-1846'`. No additional autoplay or security switches supplied. WebView's existing default switches remain as supplied by the runtime/Tauri.
- Native PID **20140** spawned WebView2 PID **24184**, actual executable `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\152.0.4191.66\msedgewebview2.exe`, with `--embedded-browser-webview=1 --webview-exe-name=supa-video-desktop.exe`. Evidence: `webview-processes.json`. CDP reports Edg/**152.0.4191.66**, JS 15.2.23.10; native `window.__TAURI_INTERNALS__` present on every fixture load. Browser product string alone is not the runtime proof; native parent chain is retained.
- `webview-ports.json` confirms **127.0.0.1 only** for 9223 (WebView PID 24184) and 1420 (our Vite PID 17824). Initial inspection found no listener on 1420/4175/9223; unrelated WebViews were left alone.

## Measurements

Executed `node evidence/2026-09-14-p2-speed/webview-probe.cjs` once (exit 0, 10.7s). The script connects installed Playwright over CDP to the **existing native WebView**, never calls browser launch. Exit status covers media/pitch checks; clock observations are separately recorded and are **not all passing**.

Uses the existing real ProgramMonitor fixture and fixed H264/AAC 10s, 1000Hz asset from `step-10-browser-media.md`. Clicks production Play after seeking program 1s. Real AudioContext resumed after gesture; MediaElementSource → FFT32768 analyser → destination. Excludes 350ms onset; samples currentTime/performance.now for about 1s. No mock clock/media/oscillator. All audio contexts running and userActivation=true, sample rate 48000Hz; preservesPitch=true at all speeds. This is a spectral observation of actual decoded output, not hardware-loopback or saved PCM.

| Speed | Actual rate | Source seek s | Media/wall ratio | Peak Hz / dB | Decoded callbacks | Program elapsed error s | Media/pitch |
|---|---:|---:|---:|---|---:|---:|---|
| 50% | 0.5 | 1.5 | 0.500108146 | 1000.488281 / −46.0724 | 20 | **−0.107900** | pass |
| 100% | 1 | 2 | 0.998302885 | 1000.488281 / −46.0952 | 42 | −0.001700 | pass |
| 150% | 1.5 | 2.5 | 1.500261738 | 1000.488281 / −46.1144 | 55 | −0.001000 | pass |
| 200% | 2 | 3 | 1.998686838 | 1000.488281 / −46.1120 | 77 | −0.001400 | pass |

Criteria preserved from browser handoff: absolute media multiplier error <0.08; pitch relative error <1%; signal >−60dB; >10 decoded callbacks; actual seek within 0.01s. Program elapsed observation threshold <2/30s: **50% fails**, others pass. 50% DOM program frame changed 40→67 during 1.0079 wall seconds; source time changed 1.656045→2.160104. No retries or tolerance changes. Diagnosis belongs to parent clock investigation; this does not establish that DOM snapshots are synchronous displayed pixel identity.

Raw start/end data, runtime version and booleans: `webview-measurements.json`. Actual native WebView viewport screenshots after pausing each measurement: `webview-50.png`, `webview-100.png`, `webview-150.png`, `webview-200.png` (not OS window-chrome captures). Reproduction measurement script: `webview-probe.cjs`.

Source SHA256 checked after measurement: ProgramMonitor.tsx `3916cd9909cbd613b92a21cb4f8da3ff44a7b9fc49502cbdafecf5e681d69113`; fixture `1f68b438121c567ec3d3c7f8bc98f6a0743121e38b9405ea3341ec67301ace5b`; MP4 `c1be4a1cbb02ca3849db198dd647189fa186681c1e10f6fea3d931216ec86e48`.

## Cleanup and remaining scope

Closed only our native PID 20140 using CloseMainWindow (true; app exited 0). Stopped only our identified Vite PID 17824; wrapper exited after intentional termination. Final process/listener inspection found no probe WebViews, those native/server PIDs, or listeners on 1420/9223. Temporary WebView profile and isolated `%LOCALAPPDATA%/com.supavideo.speed-webview-probe-20260914/media-state-v1.sqlite3` remain local disposable artifacts; no existing projects opened.

This closes the **actual Windows WebView media rate/pitch availability** subgate for these four speeds only, not the whole approved plan. No native Final/raw control, near-end endpoint/pause-stability assertions, fractional rates, multilayer clock switching, one-frame A/V flash/transient alignment, numbered-pixel identity, hardware audio capture, full clip PCM duration, export parity, assistive technology, or canonical reopen verification in this probe. Parent handles broader parity/reopen and the unresolved clock observation. No broad test suite or production changes performed here.
