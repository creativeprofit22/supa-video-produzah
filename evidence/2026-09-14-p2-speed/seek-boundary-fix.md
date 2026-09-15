# Decoded seek boundary fix — 2026-09-14

## Result

Actual shared browser decoded-seek suite: **8 passed, 0 failed, 0 skipped, 0 flaky** (61.78 seconds). Both 50% cases now pass at 30/1 and 30000/1001. All existing browser assertions are unchanged, including the one-sequence-frame mapping/parity limits.

## Policy and scope

`apps/desktop/src/video/mediaSeek.ts:1` documents the media-write-only policy: for positive seeks, ceil seconds to integer microseconds and add one guard microsecond; preserve zero and clamp to the known media duration. Unknown duration permits seeking before metadata. The guard survives floating-point conversion followed by runtime truncation and lands inside the requested frame rather than the preceding frame.

All six ProgramMonitor currentTime assignment paths now share this boundary: transport composition/proxy/final seeks, paused composition synchronization, follower corrections, clock-layer handoff, and layer metadata initialization. Canonical integer helpers, continuous rational mappings, realtime clock calculations, pause/stale-callback logic, CSS, browser specs, mocks, native renderer, dependencies, and roadmap were not changed.

Regression tests were written and run FIRST; the initial run failed because the new boundary module did not yet exist. They assert exact fractional boundary outputs (1.001001 and 0.033368), decoded frame identity after microsecond truncation, frozen canonical input preservation, and endpoint behavior. Four existing speed unit expectations were updated from unquantized seconds to explicit exact quantized values, with an explicit unchanged canonical playhead assertion; no tolerance was widened.

## Verification actually run

- `pnpm --filter @supa-video/desktop test src/video/mediaSeek.test.ts src/video/ProgramMonitor.test.tsx`: **43 passed**, including continuous-clock, pause, stale callback, and transport coverage. Log: `seek-boundary-unit.log`.
- `pnpm --filter @supa-video/desktop check`: **passed**, exit 0. Log: `seek-boundary-check.log`.
- `pnpm --filter @supa-video/desktop exec playwright test --config playwright.shared-parity.config.ts --grep "decoded seeks" --output ../../evidence/2026-09-14-p2-speed/seek-boundary-browser-results --reporter=json`: **8 passed**. Raw report with embedded decoded-seek JSON attachments: `seek-boundary-browser.json`; traces: `seek-boundary-browser-results/`.

The browser suite seeks nine positions in each mode for each of eight speed/rate cases: 144 actual decoded-media observations. At 30000/1001, 50%:

- Sequence frame 0 source preview: currentTime **1.001001**, decoded source ID **30** (previous evidence had 1.000999 / ID 29).
- Sequence frame 30: source preview **1.501501 / ID 45**, final **1.001001 / ID 45**.

This is not a claim of pixel-identical parity everywhere: the existing 200% fractional native export remains offset by one source frame in sampled rows, within its unchanged one-sequence-frame assertion. The demonstrated previous-frame boundary failure is fixed.

Live A/V measurement remains parent-owned and was not run here. The native renderer parity test was not rerun; the browser exercised the existing native-produced media fixtures without modifying them.
