# Step 8/10 — actual production ProgramMonitor browser media

2026-09-14, Windows host, Playwright Chromium. **Partial verification: first run 4 passed / 1 failed; separate final/control test passed. The clock failure remains open.** No production, inspector, controller or native files changed by this work. No dependencies, commits or Roadmap edits.

## Source and reproduction

- HEAD: `b21a303c51c258d3aa63fa51217bcbb4508fef0f`, dirty working tree retained. Production `apps/desktop/src/video/ProgramMonitor.tsx` SHA256 at measurement: `3916cd9909cbd613b92a21cb4f8da3ff44a7b9fc49502cbdafecf5e681d69113`.
- Fixture: `apps/desktop/browser-tests/program-monitor-speed.fixture.tsx`, imports the real ProgramMonitor and CommandProvider. Only canonical-style props and playhead state are supplied; currentTime, media events, playback and decoding are **not mocked**.
- Spec: `apps/desktop/browser-tests/ProgramMonitorSpeed.spec.ts`; isolated config `apps/desktop/playwright.speed-media.config.ts` inherits port 4175 conventions without changing the existing inspector config.
- Fixed local asset `apps/desktop/browser-tests/speed-media.mp4`, SHA256 `c1be4a1cbb02ca3849db198dd647189fa186681c1e10f6fea3d931216ec86e48`. 10 s, 300 frames, 320×180, H264 30 fps, AAC mono 48 kHz 1000 Hz tone. Generated successfully with bundled FFmpeg (exit 0):

```sh
apps/desktop/src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe -hide_banner -y -f lavfi -i "testsrc2=size=320x180:rate=30:duration=10" -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=10" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -movflags +faststart apps/desktop/browser-tests/speed-media.mp4
```

## Actual measurements

Source trim is [1,7) seconds; timeline starts at zero, lasts 12/6/4/3 seconds. Seek to program 1 s asserted actual source time 1.5/2/2.5/3 s within 0.01 s. Media runs through production Play/Pause buttons. Measured currentTime and performance.now over approximately 1 s after 350 ms onset exclusion. Live WebAudio MediaElementSource → AnalyserNode → destination captures the actual decoded rate-adjusted audio; no microphone or fake oscillator. FFT size 32768, peak search, signal > −60 dB, pitch tolerance **1%**. This is spectral output observation, not a saved PCM waveform or hardware-loopback recording.

| Speed | Media delta / wall delta | Program delta / wall seconds | Decoded callbacks | Peak Hz       | Result            |
| ----- | ------------------------ | ---------------------------- | ----------------- | ------------- | ----------------- |
| 50%   | 0.520000 / 1.047000      | 1.000000 / 1.047000          | 21                | 1000.48828125 | pass              |
| 100%  | 1.010667 / 1.012200      | 0.933333 / 1.012200          | 40                | 1000.48828125 | **clock failure** |
| 150%  | 1.500000 / 1.002500      | 1.033333 / 1.002500          | 48                | 1000.48828125 | pass              |
| 200%  | 2.021511 / 1.004500      | 1.000000 / 1.004500          | 80                | 1000.48828125 | pass              |

Every measurement recorded requested playbackRate and preservesPitch=true, and a real non-silent ~1000 Hz peak (about −46 dB). The 100% test stops before its pitch assertion but the captured value is retained; do not count downstream assertions as executed.

Tolerance for media/wall speed: absolute multiplier error <0.08. Program/wall elapsed error: <2 sequence frames (66.667 ms), a browser observation gate, **not** the plan's one-frame A/V alignment proof. 100% measured 78.867 ms and failed; no tolerance weakened and no rerun attempted to get green. Whether scheduling/React observation latency or production clock behavior caused it remains undiagnosed. Program frame snapshots in independently registered decoded-frame callbacks may precede React's commit; do not interpret them as synchronous pixel identity.

50/150/200 also passed pause stability (200 ms, 0.001 s), near-end seek/resume, final displayed frame duration−1, actual endpoint source seek 7−speed/30 within 0.01 s, media paused, and transition to Final resetting rate/pitch. These near-end tests do not measure full uninterrupted clip duration. Screenshots and all traces are retained.

Separate final-mode/control run: actual Final media/wall ratio **1.003359825**, pitch **1000.48828125 Hz**. Intentionally forcing the same real media element to playbackRate=2 and preservesPitch=false produced ratio **2.000527514**, pitch **1999.51171875 Hz**. Both wrong-speed and wrong-pitch values fail the normal 1×/1% acceptance metrics; control test passed. Final path uses the same fixed asset, proving no double application of canonical 200%, not actual exported-output parity. Raw audition actual playback passed 1× with 200% fixture request and no composition layers.

## Executed checks and artifacts

1. `pnpm --filter @supa-video/desktop exec playwright test --config playwright.speed-media.config.ts` — **exit 1**, 4 passed, 1 failed, 22.3 s. Original traces, screenshots and extracted JSON in `browser-media-results/`. The failing 100% artifact directory is `ProgramMonitorSpeed-real-P-6bf2e-d-frames-pitch-seek-and-end`.
2. After adding a distinct measurement-control test: `pnpm --filter @supa-video/desktop exec playwright test --config playwright.speed-media.config.ts --grep "final playback and wrong-speed" --output ../../evidence/2026-09-14-p2-speed/browser-media-controls` — **1 passed**, 7.8 s. Trace and extracted `controls.json` in `browser-media-controls/`. This is not a rerun of the failing clock test.
3. `pnpm exec prettier --check apps/desktop/browser-tests/ProgramMonitorSpeed.spec.ts apps/desktop/browser-tests/program-monitor-speed.fixture.tsx apps/desktop/browser-tests/program-monitor-speed.html apps/desktop/playwright.speed-media.config.ts` — **exit 0**. Files reread after formatting; final added Vite client type reference addresses the fixture's CSS module diagnostic. No full typecheck or broad suite run here.

## Remaining gates / Windows WebView handoff

**Not complete steps 8/10:** native Windows Tauri WebView actual playback/pitch, save/reopen, assistive technology, multilayer clock switching, muted/hidden layers, fractional rates, numbered pixel/frame endpoint identification, aligned flash/transient one-frame A/V offset, captured PCM duration, and shared-fixture export parity remain unverified. This synthetic asset has moving test patterns and steady tone, **not numbered frames or aligned flash/transients**, and is not the native counterpart's shared fixture. Native counterpart in `video/tests.rs` / `step-10-native-export` must be reported separately. No assertion of full approved parity or universal preview reliability.

Playwright started/stopped Vite automatically; **port 4175 is not promised running after tests**. For a manual Windows WebView session start (repository root):

```sh
pnpm --filter @supa-video/desktop dev --host 127.0.0.1 --port 4175 --strictPort
```

Wait for Vite's Local URL readiness line and verify HTTP 200 for the HTML and MP4 (range requests/media decoding required). Fixture URLs: `http://127.0.0.1:4175/browser-tests/program-monitor-speed.html?speed=50` (also 100,150,200); raw `?speed=200&raw`. Use Play for user-gesture audio activation, Seek program 1s, Pause/resume, Seek near end, Final. Load **inside WebView2/Tauri**, not Edge/Chromium, and record runtime/version plus real audio output. No capture permission flags were needed for same-origin WebAudio in Chromium; WebView's audio context must be resumed after a gesture if suspended. The fixture alone has no persistence service: native save/reopen requires the actual application/canonical project path and cannot be established by this page.
