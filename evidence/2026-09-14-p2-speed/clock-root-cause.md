# ProgramMonitor clock root cause — 2026-09-14

## Outcome and preserved red proof

Implemented a media-currentTime display-cadence clock, independent of decoded frame arrival. Production changes are confined to ProgramMonitor.tsx; tests to ProgramMonitor.test.tsx. No browser gates, tolerances, dependencies or native code changed.

Original browser failure remains in step-10-browser-media.md: 100% elapsed error 78.867ms against 66.667ms. Original native WebView failure remains in step-10-webview.md: 50% elapsed error 107.9ms. Neither artifact overwritten.

Before production changes, added deterministic regression and ran `pnpm --filter @supa-video/desktop exec vitest run src/video/ProgramMonitor.test.tsx -t "advances the program clock"`: exit 1. `clock-unit-red.log:48-65` records expected frame 11 versus no callback despite advancing currentTime and pumping display ticks. This isolates a production clock starvation mechanism without React commit delays, buffering, or real decoder scheduling.

Previously, cancellable rVFC support disabled timeupdate and rVFC metadata.mediaTime alone advanced program time. At 50%, 30fps source decoding yields approximately 15 callbacks/sec: already a 66.7ms quantum before asynchronous React/DOM observation. The deterministic failure establishes this architectural defect, not the precise attribution of every millisecond in the historical real-runtime failures. React sampling latency remains a residual source of observation jitter; historical data do not independently prove or exclude transient buffering.

## Implementation

ProgramMonitor.tsx schedules requestAnimationFrame alongside existing cancellable decoded-frame observation, sharing generation/context/master-video guards and cancellation. Both paths sample currentTime, never metadata.mediaTime, preventing alternating clock-domain rewinds. Rational continuous source/sequence mapping remains unchanged. Seeking defers sampling while retaining observers; pause, errors, mode/source changes and unmount cancel both loops. Master boundary stops the display loop, leaving existing React master selection/gap handoff intact. This is media-clock sampling, not wall-clock extrapolation: stalled currentTime cannot invent progress.

Existing tests remain, with decoded-callback simulator now advancing the associated media element clock as real playback does; an explicit delayed-metadata case leaves currentTime ahead and proves no rewind. Existing trim-end, split/master selection, hidden-layer, stale-generation and lifecycle assertions pass. No claim of exhaustive real-media multilayer/gap parity.

## Fresh verification (all attempts retained)

- Focused ProgramMonitor suite after clock change: exit 0, 40 tests (`clock-unit-green.log`).
- Full desktop unit project after final seek-observation maintenance and formatting: `pnpm --filter @supa-video/desktop exec vitest run --project unit`, exit 0, **25 files / 292 tests** (`clock-unit-suite.log:110-113`). Prettier formatted both permitted source files.
- First real-media browser run: `pnpm --filter @supa-video/desktop exec playwright test --config playwright.speed-media.config.ts --output ../../evidence/2026-09-14-p2-speed/clock-browser-results`, exit 0, **6 passed**. Signed program-minus-wall errors: 50% +27.333ms; 100% -2.400ms; 150% +27.933ms; 200% -2.500ms. All four measured 1000.48828125Hz; decoded callback counts 21/41/43/78. Existing seek, pause, endpoint, pitch, final/raw and negative controls passed unchanged. Traces/screenshots and extracted measurements.json retained in clock-browser-results.
- Following small seek-observer maintenance (reschedule decoded observation while seeking rather than discard it), final-code browser verification used the same command with `clock-browser-final-results`: **exit 1, 5 passed / 1 failed**. The 50% test timed out in initial page.goto waiting for load, **before playback or any clock measurement** (`clock-browser-final.log:7-21`). Other clock errors: 100% -6.400ms; 150% +28.333ms; 200% -36.933ms, all within unchanged gate. Final/raw and measurement controls passed. Traces and extracted successful measurements retained. No retry after this failure; this is not an all-green final browser suite.

The final navigation timeout is a load/readiness failure, not evidence of recurring clock jitter. Its underlying server/browser scheduling cause is unconfirmed within this bounded task. No tolerance changes or measurement-defect claims. First browser pass predates only the seek-observation maintenance; do not represent it as complete final-code verification at 50%.

No fresh native WebView run, full typecheck, hardware A/V alignment, numbered-frame identity or export parity performed. Parent owns native/shared-media integration. Actual WebView clock closure and final 50% browser readiness remain open.
