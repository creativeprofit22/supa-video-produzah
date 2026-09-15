# Preview audio integration — 2026-09-14

## Implemented
- Workspace includes prepared asset clips from audio tracks, marks them `audioOnly`, and includes hidden/audio clips in composition seek bounds. Audio asset speed is no longer incorrectly rejected solely because its track is audio.
- ProgramMonitor retains visible-active clock preference, falling back to hidden/audio clocks; logical audio clips have no visible picture. Track mute, visibility and opacity remain independent. Parent's gesture/undefined-resume handling and all-source activeIn/out changes preserved.
- Source media receives `crossOrigin="anonymous"` before `src`; every layer reports media loading errors visibly, including followers. Installed Tauri source inspected at `C:/Users/SPARTAN PC/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.11.5/src/protocol/asset.rs`: lines 21 and 39 set Access-Control-Allow-Origin to window origin; ranged responses retain this builder (lines 91–147). This supports anonymous CORS, not a native-runtime signoff.
- Graph reconnects already-bound media even when effects become neutral after removal/readdition (previously silent). Scheduling uses output time adjusted for actual playbackRate; seeking suppresses future ramps; cleanup cancels ramps. Existing deferred StrictMode graph disposal retained.

## Actual verification
- `pnpm --filter @supa-video/desktop check`: PASS (frontend/node/browser TypeScript).
- `pnpm --filter @supa-video/desktop exec vitest run src/video/preview-audio.test.ts --pool=threads`: PASS, 4 tests.
- `pnpm --filter @supa-video/desktop exec vitest run src/video/ProgramMonitor.test.tsx --pool=threads --maxWorkers=1`: PASS, 41 tests on final ProgramMonitor changes.
- `pnpm --filter @supa-video/desktop exec playwright test --config playwright.preview-audio.config.ts`: PASS, 1 actual Chromium media test (13.5 seconds suite). Creates a 4-second PCM WAV with 440Hz/0.04-amplitude tone, decodes via HTMLMediaElement, observes production GainNode via analyser. Checks +6dB linear fade-in/plateau/fade-out RMS continuously, then pause/seek/remove/readd at neutral gain. Low input avoids clipping. Attaches preview-audio-rms.json to Playwright result. This verifies NEW audio effects, not old speed live A/V signoff.

## Remaining handoff / not claimed
- Workspace component suite: 8 passed, 2 failed due prior video-only positional expectations now including the actual audio layer. `VideoWorkspace.test.tsx:399` expects an exact video-only sourceLayers array; `:539` slices first two sourceLayers assuming second is video (now audio). Update these expectations and add dedicated audio-only/all-hidden Workspace integration tests. Did not edit parent's Workspace browser tests.
- Initial forks-based component invocation timed out starting workers; threads invocation completed.
- Native asset CORS/runtime RMS, exhaustive StrictMode/replaced-primary/source-final lifecycle browser coverage, and real Workspace audio-only playback remain for parent. Existing ProgramMonitor regression suite passes, but it is not equivalent to this coverage.
- No Rust build, dependencies, CSS/source-range/multi/layout edits, commits or roadmap changes. Audio-only export remains explicitly unsupported by inherited renderer constraint; no export claim.
