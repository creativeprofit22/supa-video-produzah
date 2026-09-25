# Playback failure diagnosis — 15 September 2026

Scope: diagnose the live playback failures observed after the native export checks. No saved projects, capture-session controls, dependencies, commits, or Roadmap status were changed. Native export cases were not rerun during this diagnosis; the immediately preceding run passed the eight speed-export cases and the separate gain/fade test.

## Confirmed fixes

- **Production end bound:** Final playback used `Number.MAX_SAFE_INTEGER` as its exclusive end and accepted `currentTime == duration` as frame 60 for a 60-frame clip. The ended handler only stopped observation. Final transport now derives its exclusive end from finite loaded media duration, clamps playback/seeks to the final frame, and settles the clock on `ended` even without a last `timeupdate`. Source/composition trim behavior is unchanged.
- **Capture completion race:** displaying frame 59 does not mean playback has stopped; that frame still occupies a frame interval. The browser test now waits for actual `paused` state before reading results and closing the capture context. The final paused assertion and all existing timing/pitch/seek thresholds remain enabled.
- Added two component regressions (30 fps and 30000/1001 fps) for end-time updates, `ended` without a final update, and stepping past the end. Both failed with frame 60 in the targeted Vitest run before the fix. The whole 45-test ProgramMonitor file passed after the fix.

## A/V failure is not attributable to ProgramMonitor on this evidence

The reduced reproduction is:

```sh
pnpm --dir apps/desktop exec playwright test --config playwright.shared-parity.config.ts --grep '30/1 100%.*live PCM' --output=../../.cache/<unique-output-directory>
```

The existing raw-video control removes React, ProgramMonitor, retiming, and seeks while playing the same freshly validated native 1x export. It still failed the unchanged one-frame gate:

| Raw browser control                    | Measured audio minus visual  | Reported base + output latency | Execution                              |
| -------------------------------------- | ---------------------------- | ------------------------------ | -------------------------------------- |
| Original default AudioContext          | +51.3627 ms (1.54088 frames) | 10 + 40 ms                     | `fbab3071-6cf9-460d-bba7-3d4675b21ae6` |
| Only change: `latencyHint: "playback"` | +64.1083 ms (1.92325 frames) | 20 + 48 ms                     | `84329b3b-b065-4f57-aa04-b3fb521066dc` |

The temporary latency hint was reverted; `RawMediaParity.spec.ts` is unchanged. Both observations used HeadlessChrome 151.0.7922.34. The second result supports capture-path latency as a contributor but is not a calibrated decomposition of all latency or a production output measurement.

The test creates a MediaElementAudioSourceNode and routes audio through a worklet to the context destination. This is **not a passive recording of the original media output**: [MDN documents that createMediaElementSource reroutes playback into the AudioContext graph](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaElementSource) (read during this investigation). The shared test now preserves base/output latency in each measurement attachment. No latency was subtracted, no audio was shifted, and no acceptance threshold was relaxed. A successful calibrated measurement of the unmodified browser/native output remains necessary before attributing or clearing the actual product A/V timing issue. Production clip-audio effects also use Web Audio; these controls do not certify that separate path.

## Final verification

- `pnpm check && pnpm lint && pnpm test`: exit 0; desktop suite 335 passed, all workspace package suites passed. Execution `0e79b55a-05d4-4d58-93d0-76650cba3ed2`.
- Full shared-parity matrix: **10 passed, 14 failed**; execution `6398bb6e-1047-43aa-aed9-8ba48921fcc6`. All eight decoded-seek tests passed. All 16 live cases reached the expected last frame and stopped; pitch/rate/observations checks passed. The only 14 failures were the unchanged one-frame A/V gate (1.18609–2.07793 sequence frames). The variable count of timing failures is not evidence that the endpoint fix regressed audio.
- Current matrix traces: `.cache/playback-fixed-matrix-AM7Ida/`. Raw default control: `.cache/playback-raw-control-aso52p/`. Latency intervention: `.cache/playback-latency-control-0K7a8X/`. Prior reproduction traces remain in separate local directories.

No actual Windows WebView output, hardware audio/display capture, calibrated shifted-output controls, or live saved-project workflow was verified. Existing disabled/blocked capture prototypes were not reactivated; foreign audio sessions were not muted or recorded. This is a verified endpoint fix and a narrowed A/V investigation, **not a fully passing playback acceptance gate**.
