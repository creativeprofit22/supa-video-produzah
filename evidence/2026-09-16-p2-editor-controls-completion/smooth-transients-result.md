# Slower-than-1x smooth-transient diagnostic and guarded implementation

## Outcome

The single authorized parameter experiment passed, then the matching production change passed the affected native speed, onset, gain/fade and exact-validation checks. This is not full application/completion acceptance.

`rubberband=tempo=…:window=short:transients=smooth` is used only below 1x; >=1x remains on the existing atempo path. No pitch gate replacement, extra cropping, tolerance relaxation, latency subtraction, dependency updates, recordings or audio playback were performed.

## Offline experiment BEFORE source edits

Run: `node evidence/2026-09-16-p2-editor-controls-completion/diagnose-smooth-transients.mjs`

Execution: `8aeb0e2f-bb80-4ba2-9974-b4931c709138` (exit 0).

All 16 outputs retained in `capture-smooth-Wkxhsy/`, with argv, PCM, source/output SHA256, filter help and `results.json`. These are explicitly filter probes, not production-compiled acceptance. Eight smooth cases (50/75%, 30/1 and 30000/1001, continuous and silent-tone sources) pass the original native gates. Default candidates are retained alongside them, including the fractional-50 continuous pitch failure. Sources are the unchanged retained native test sources in `.tmpFok7YA` and `slow-audio-onset-1oRIhg` under the Windows temp directory.

Fractional-50 continuous zero-crossing pitch changes from 1010.121997 Hz to 1003.383358 Hz. The observation supports the proposed transient-handling hypothesis; this does not independently prove the library's internal phase-reset mechanism. No spectral measurement replaces the gate.

## Implementation

- `packages/video-render/src/compile-render-plan.ts`: append smooth option to below-1x branch.
- `packages/video-contracts/src/render-plan.ts`: identical exact reconstruction.
- `apps/desktop/src-tauri/src/video/render.rs`: identical exact reconstruction.
- `packages/video-render/src/compile-render-plan.test.ts` and native `tests.rs`: matching expectations and rejection of omitted/crisp transient option.
- Prior manifest rubberband requirement and exact native capability list remain unchanged in this turn.

Earlier working-tree changes and all failed artifacts were preserved. Parent-owned step8 helpers were not modified.

## Production-compiled verification AFTER source edits

Execution `a7f9f9e5-d2cf-455e-b050-c334ce945479`, exit 0:

- Contracts and render TypeScript builds.
- Render and contracts Vitest suites.
- Native `render_speed`: 3 passed, including original continuous-tone zero-crossing gate and negative control, now also 75%.
- Native `render_silent_onset_production_compiler_actual_parity`: passed all ten cases (50/75/100/150/200%, both rates).
- Native `render_audio_gain_and_fades_actual_compiler_output`: passed all nine gain/fade cases, including 50/75%.

Execution `83999160-2685-4476-afe8-bed153f5f1d8`, exit 0:

- Native `render_fades`: 1 passed.
- Native `render_volume`: 1 passed.
- Native `video::toolchain::tests`: 15 passed.

Commands used `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml FILTER -- --nocapture`.

Retained production outputs under `C:/Users/SPARTA~1/AppData/Local/Temp/`:

- Continuous compiler parity: `.tmpIFEX5Q`
- Silent-tone compiler parity: `slow-audio-onset-I08Om2`
- Gain/fade compiler parity: `.tmpjOZduZ`

Final 50% silent onset errors: -31.625 ms (30fps), -31.425 ms (fractional), inside one frame but with modest margin. Pitch: 999.948049 / 1002.493766 Hz. Fractional-50 continuous pitch: 1003.383358 Hz. Original assertions remain unchanged.

Existing linker warning was emitted, not suppressed.

## Toolchain/fallback inspection

`video/derived.rs:1099-1107` exposes bundled tools in production; explicit alternatives are cfg(test). `verified_ffmpeg` delegates to bundled verification (`derived.rs:1157-1168`); no production PATH fallback is added. Manifest/capability tests pass. No dependency version, hash or download changed. Bootstrap scripts were not revalidated in this turn.

## Next regeneration / remaining acceptance

Already run builds regenerate compiler dist. To regenerate them again and rerun the scoped media checks:

```sh
pnpm --filter @supa-video/contracts build
pnpm --filter @supa-video/render build
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_speed -- --nocapture
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_silent_onset_production_compiler_actual_parity -- --nocapture
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_audio_gain_and_fades_actual_compiler_output -- --nocapture
```

Frontend regeneration command (not run here): `pnpm --filter @supa-video/desktop build`.

Full native suite, packaged desktop regeneration, browser/WebView and parent step8 final decoded acceptance remain the parent's follow-up; no claim those passed. No commits made.
