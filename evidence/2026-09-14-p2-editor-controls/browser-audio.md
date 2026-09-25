# ProgramMonitorAudio — real Chromium PCM proof

PASS: 5 tests, zero failures/skips/retries, 36.8 seconds. Run started 2026-09-15T00:56:32Z (September 14 local evidence date). This is browser audio-effects evidence, NOT global A/V signoff.

## Reproduce

From repository root:

```sh
node apps/desktop/browser-tests/ProgramMonitorAudio.generate.mjs
cd apps/desktop
pnpm exec playwright test --config playwright.program-monitor-audio.config.ts
```

Both commands actually executed successfully. The isolated configuration targets only ProgramMonitorAudio.spec.ts and uses the existing Vite lifecycle on port 4181. No production modifications, dependencies, Rust builds, commits, or roadmap changes were made by this task.

## Signal and instrumentation

ProgramMonitorAudio.generate.mjs uses the bundled Windows FFmpeg to generate the gitignored ProgramMonitorAudio.mp4: 12 seconds, 160x90 black video, 48 kHz 1000 Hz sine attenuated by 0.04 from FFmpeg's default sine amplitude. Decoded unity RMS is approximately 0.003532 (about -49 dBFS); +6 dB remains quiet at approximately 0.007048 RMS. Same-origin Vite media, no microphone or uploads.

The real ProgramMonitor imports and owns PreviewAudioGraph. Fixture AudioContext subclass delegates constructors/source/gain creation to native Web Audio. Production constructs its context and resumes it from the actual Play-button gesture; the gain/fade test never calls resume. Input and gain-output analysers are parallel taps with unconnected outputs. Production source -> gain -> destination remains unchanged, with no second audible path. No currentTime, AudioParam processing, PCM, or metrics are mocked.

Settled 2048-sample PCM windows are read every approximately 20 ms after onset/change transients. Input/output RMS comparison uses the same actual decoded signal. Every settled sample must be running/non-silent. Gain mean-ratio relative tolerance is 3%.

## Numeric results (final run)

| Case                |  -6 dB ratio |  +6 dB ratio | Reset ratio | Fade-in early / late | Fade-out early / late | Maximum envelope error | Windows |
| ------------------- | -----------: | -----------: | ----------: | -------------------: | --------------------: | ---------------------: | ------: |
| Video 1x            | 0.5011872053 | 1.9952622657 |    1.000000 |  0.274698 / 0.760105 |   0.788112 / 0.302127 |             0.00139223 |     137 |
| Video 2x            | 0.5011872053 | 1.9953625232 |    1.000000 |  0.280447 / 0.770330 |   0.782704 / 0.298111 |             0.00650964 |     135 |
| Audio-only layer 1x | 0.5011872053 | 1.9952622658 |    1.000000 |  0.277667 / 0.767104 |   0.783208 / 0.301105 |             0.00263661 |     137 |

Targets: -6 dB = 0.5011872336; +6 dB = 1.9952623150. All comfortably within 3%. Reset is measured both after gain changes and after the fade pass.

Fades are two-second linear-amplitude ramps on a five-second output timeline, at 30 fps, tested at normal and 2x source speed. Each actual PCM window is compared with the actual media-clock position converted to output time, corrected to the analyser-window midpoint. Expected linear-window RMS is sqrt(midpointAmplitude² + windowSeconds²/48). Maximum allowed amplitude error is 0.0216667: one sequence frame at ramp slope 0.5/second plus 0.005 PCM/window allowance. All sampled interior ramp windows pass, not merely early/late averages. Actual AudioContext and media timestamps are retained.

| Reset then mode switch (initial speed metadata 2x) | Unity PCM ratio | Measured media/wall rate | Element playbackRate |
| -------------------------------------------------- | --------------: | -----------------------: | -------------------: |
| Raw audition                                       |    0.9997558105 |             0.9965742759 |                    1 |
| Final                                              |    0.9998232350 |             1.0012078346 |                    1 |

Raw/final have no production effects graph. For these separate checks a native source replaces direct element output with exactly one source -> destination connection plus an unconnected analyser tap. Their PCM is compared against the composition's actual pre-gain baseline. Unity PCM rules out residual/double processing after reset; measured clocks and playbackRate establish 1x playback.

## Machine evidence and limits

`browser-audio-results.json` is the Playwright JSON report: test outcomes, numeric stdout, and base64 JSON attachments containing individual PCM RMS observations, clocks, ramp predictions/errors, and post-fade reset observations. It is emitted automatically on future runs.

This verifies actual browser-decoded/Web-Audio PCM, not physical speaker output or OS loopback capture. The old OS capture blocker remains; no global A/V synchronization or device-output signoff is claimed. Final-mode media here is the quiet unity fixture, not a native rendered export; native actual-audio proof and final export checks remain the parent's separate responsibility. Audio-only coverage is one isolated 1x layer, not a multilayer mixing/crossfade matrix. Browser coverage is Chromium only. Fixture/spec execute under Playwright/Vite; no whole-repository typecheck was run.
