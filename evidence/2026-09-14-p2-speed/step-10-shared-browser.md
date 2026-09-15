# Step 10 — shared browser/native artifacts

## Implemented

- `apps/desktop/browser-tests/program-monitor-speed.fixture.tsx`: opt-in `?parity&speed=50|100|150|200`, plus `&fractional`, uses the native test's actual source and exported MP4s. Composition is sourceIn 30, sourceOut 30 + 60 * speed, duration 60 sequence frames; Final uses the corresponding rendered output at 1x. Existing non-parity parameters retain their previous values.
- `ProgramMonitorSharedParity.spec.ts`: 8 decoded seek comparisons (9 positions each) and 16 live PCM/presentation-clock tests covering both rates, all speeds, preview and final. Actual canvas stripe IDs, not currentTime alone, are checked against canonical source mapping and each other, with <=1 sequence-frame gates.
- `parity-audio-worklet.js`: separately served same-origin module, PCM capture/pass-through, no inline blob and no CSP changes. Audio block times map through AudioContext.getOutputTimestamp; visual observations use rVFC expectedDisplayTime and decoded stripe IDs. Stable decoded tone gate is 1%; transient gate is <=1 sequence frame. Missing observations fail, never skip.
- Dedicated `playwright.shared-parity.config.ts`, isolated port 4177, one worker, traces on.
- No production changes, dependency additions, commits, or rerun of native rendering.

## Executed results

From `apps/desktop`:

1. `pnpm exec playwright test --config playwright.shared-parity.config.ts --reporter=line`
   - 24 executed: 4 passed, 20 failed, 2.3 minutes.
   - All 16 live captures measured pitch within 1%: **998.368–1000.035 Hz**.
   - Actual aligned transient errors: **0.473–1.834 sequence frames**; 12/16 live cases failed the unchanged <=1-frame gate. All rate, preservesPitch, tone sample count, observed transient, frame count, end-paused and final-output URL assertions passed.
   - Eight initial seek failures included a harness issue: external playhead updates do not seek Final media. Corrected the helper to invoke the real ProgramMonitor single-frame transport command after setting an adjacent fixture playhead. No production seek behavior was changed.
2. `pnpm exec playwright test --config playwright.shared-parity.config.ts --grep 'decoded seeks' --reporter=line`
   - After that correction: **6 passed, 2 failed**, 48 seconds.
   - 100%, 150%, 200% pass at both rates.
   - 50% fails both rates at the unchanged one-sequence-frame threshold: integer frame 58 decodes source ID 58 in preview vs 59 in Final (2 sequence frames apart). Fractional preview frame 0 decodes ID 29 instead of 30; preview/Final frame 30 decode ID 44 instead of 45; frame 58 decode ID 58 instead of 59. Those single-source-frame errors equal two sequence frames at 0.5x.

## Saved evidence

- `shared-live-initial.json`: all 16 live measurements retained from first run before the seek-only run replaced Playwright output. Includes PCM onset timestamp, nearest output timestamp, pitch/sample count, decoded visual frame sequence with expectedDisplayTime, source URL, rate, and AV error.
- `shared-seeks.json`: all eight corrected seek result arrays, including source/output URLs, decoded IDs, currentTime, rate and output duration.
- `shared-browser-results/*/trace.zip`: latest seek-only run traces and error contexts.
- Initial full-run tool log ID: `84ab75d5-3171-4306-aaf4-78565bbc1db2`; corrected seek run ID: `6a4baf59-c522-4f6c-9f3b-1f08f4a48bad`.

## Concrete remaining checks / limits

- Suite intentionally remains red. No gates weakened or failures skipped. Determine whether the 0.5x boundary failures are Chromium timestamp/frame selection at exact boundaries, transport synchronization, or a production mapping issue; saved requested frame/currentTime/IDs allow that investigation without rerendering.
- Investigate the 12 live AV violations before claiming parity. The measurement is actual PCM/output-clock versus decoded visual presentation, but WebAudio rerouting and the headless output sink may themselves affect playback synchronization. No production defect attribution is made yet. PCM threshold timing has one worklet-block granularity (~2.7 ms at 48 kHz); decoded visual crossing is corrected for source-ID overshoot.
- Rerun all 24 tests with the corrected transport helper (only seeks were rerun after its change). Live initial frame 0 already worked in the original run; nevertheless the final helper version has not been re-executed for live cases.
- Legacy speed suite and a standalone TypeScript check were not run within this bounded task. Playwright transpilation and real Vite browser execution were run successfully; test assertions above are the remaining failures.
