# Step 10 — bounded actual native export measurement

2026-09-14. **PASS for the bounded four-case native export test; NOT completion of the approved media/parity matrix.**

## Execution

Added opt-in `video::tests::render_speed_bundled_actual_media` in `apps/desktop/src-tauri/src/video/tests.rs`. Executed:

`cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_speed_bundled_actual_media -- --ignored --nocapture`

First invocation hit the worker's 240-second tool bound during compilation/linking (no test result). Second invocation completed exit 0: 1 passed, 0 failed, 0 ignored, 360 filtered out; actual test 15.83 seconds. Raw output: `step-10-native-export.log`. Existing linker-message warning remains. Ran `rustfmt --edition 2021 apps/desktop/src-tauri/src/video/tests.rs` afterward (exit 0); the passing test preceded whitespace formatting.

## Actual path and fixture

Pinned binaries copied into temporary application resource layout, resolved with `MediaToolchain::resolve_from_resource_root`, verified through `MediaPrograms::bundled`. Generated six-second 30 fps testsrc2 video plus 1000 Hz / 48 kHz sine, encoded H.264/AAC. Source and destinations granted to owner `owner`. Every plan traverses `parse_and_validate_render_plan`, `registered_render_worker`, and `run_render_worker`; ordered worker events and terminal Completed are asserted. No validation or output verification bypass.

Existing V2 multilayer native test-plan builder supplies metadata/argv. Upper audible layer starts at source frame 30 (1 second), selecting 30/60/90/120 source frames respectively; each retimes to 60 output frames. Lower layer retains existing normal-speed, muted, zero-opacity settings. This is **not invocation of the production TypeScript compiler**; that integration remains unverified here.

Plan ID: `33333333-3333-4333-8333-333333333333`; revision ID: `44444444-4444-4444-8444-444444444444` (existing deterministic test IDs).

## Measurements and fixed gates

Bundled ffprobe `-count_frames`: all outputs exactly **60 frames, 30/1 fps, video duration 2.000000 s**, video/audio stream start 0.000000 s. Audio decoded from the actual encoded MP4 to mono float32 PCM at 48 kHz. Positive zero-crossing frequency measured after excluding 250 ms at each end. Pitch gate is ±1%; audio stream-duration gate is ±one output frame (33.333 ms), not sample-exact equality.

| Speed | Audio stream seconds | Decoded PCM samples | Measured Hz | Pitch/duration |
| ----- | -------------------: | ------------------: | ----------: | -------------- |
| 50%   |             1.980000 |               95232 |  999.340175 | pass/pass      |
| 100%  |             1.999000 |               96256 | 1000.456716 | pass/pass      |
| 150%  |             2.000000 |               96256 | 1000.456716 | pass/pass      |
| 200%  |             1.999000 |               96256 |  999.792402 | pass/pass      |

Decoded sample counts include AAC tail/frame padding and are recorded, not equated with container stream duration. No new alignment policy or production filter change made. The 50% output is 20 ms short but within the declared one-frame gate for this fixture. These results do not disprove the earlier synthetic-filter deficit evidence for other durations/content.

## Remaining gates / limitations

- No fractional frame-rate case (150% covers a fractional multiplier).
- Nonzero trim is passed through the real path, but visible source endpoint/cadence identity is not measured. Testsrc2 is not frame-numbered; no aligned flash/transient detector.
- Stream start timestamps were recorded; actual transient A/V alignment is not proven.
- No deliberately wrong-speed or pitch-shifted media control to validate detector sensitivity; no broad audio/content matrix.
- Muted lower layer participates, but independent hidden/mute-output parity assertions are not added.
- Temporary media is deleted; reproducible test and raw numerical log retained.
- Browser/WebView preview, accessibility, and production TS-compiler-to-native integration remain with parent. No full-suite/clippy/build claim.

## Snapshot

HEAD `b21a303c51c258d3aa63fa51217bcbb4508fef0f`, dirty working tree preserved. Only native tests plus new evidence edited by this unit; no render/compiler change or commit. Post-rustfmt SHA-256:

- tests.rs: `f723414829d00f395894e289c2665dc596501617489ae02ce1460575d002a1d3`
- render.rs: `15115512ea351cbb4d8a90937dcc79e53475589bfd1709714620fe736831719c`
- ffmpeg.exe: `1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e`
- ffprobe.exe: `b49ccc7c6547b141ad5a2f6ec69cc04323d7133d7704d70b331b904c63eecb07`
