# Export keyframe interval: 2 s vs current 8.3 s (2026-09-28)

**Result:** a keyframe every 2 s cuts Final seek p95 from about 276 ms to **about 59 ms** (p50 from about 143 ms to **about 23 ms**). Exported files grow by **+1.8 %**. Export time is effectively unchanged. The change is uncommitted and awaits a keep/revert decision; the phase status is unchanged.

## Change under test (uncommitted)

- `packages/video-render/src/compile-render-plan.ts`: both export paths (single-clip v1 and multitrack v2) now pass `-g <frames>` right after `-pix_fmt yuv420p`. Frames = 2 s at the sequence rate, rounded half up: 60 at 30 and 29.97 fps, 48 at 24 and 23.976, 50 at 25, 120 at 60.
- `apps/desktop/src-tauri/src/video/render.rs`: the native argv validator mirrors the exact value (`keyframe_interval_frames`), so a plan without it or with a different value is still rejected.
- Tests: the exact-argv fixtures were updated (TS, and Rust `lib.rs` / `video/tests.rs`). A new table test covers 6 frame rates. The Rust fixture helper derives the expected value from an independent floating-point formula, not the production one.
- Checks: `packages/video-render` vitest 126/126 (63 tests, run from both the source and the rebuilt `dist` copy; re-run after formatting); `pnpm check` exit 0; desktop `pnpm test` 390/390; `cargo test --offline --locked` 344 pass, 12 ignored, 1 fail. The failure was the timing-budget test `durable_command_acknowledgement_p95_meets_budget` (project saving, unrelated to rendering), which passed 2/2 when re-run alone. `packages/video-render/dist` was rebuilt, because the compiler-backed Rust tests execute it.

## Method

Same release pattern and same harness as `FiGn9e`: native-profile, `P2_WORKLOADS=export-reference`, 100 seeded seeks per mode and cadence, launcher `6bddff38…`, media `9f3WSn`. The two builds ran back to back under the same machine conditions:

- **2 s:** release `release-eZc0cL` (receipt sha256 `fb5e9664f587fecaf2be01824b3fcd011f09225445655c9b53943bba8ef6946b`), run `workloads-native-profile-NcSL3Y` (index `632a101059ebed1f65ed271660c25b7982d9ffb386391ae7ea984d47dfd1ae6c`).
- **8.3 s control:** release `release-eIOB49` (the committed code), run `workloads-native-profile-YXXNtn` (index `1b0393004358d062cf33ca43d2ca81bba840d367f0ad86df114d0f1b0dfd5ed7`).
- Both runs: status `partial` by design (workload subset), both cadences `passed`, cleanup `empty:true`.
- Keyframe analysis: `final-seek-diagnosis.mjs`, output in `runs/gop-comparison-6OonFi/gop2s.json` (`fa155353…6545`) and `gop8s.json` (`ac5b1895…e549`).
- CPU (`runs/cpu-gop-VHmBQu`): the 2-s run averaged 17.9 % and the control 10.8 %. Every sample at or above 50 % in the 2-s run was the app's own `ffmpeg` export. Excluding those samples, the means are 5.7 % vs 6.4 %, so there was no outside load in either run.

## Numbers

| Rate       | Build           | Keyframes (interval) | Final seek p50 | Final seek p95 | Preview p95 (control) | File size (bytes)        | Video bitrate | Export time |
| ---------- | --------------- | -------------------- | -------------- | -------------- | --------------------- | ------------------------ | ------------- | ----------- |
| 30/1       | 8.3 s (current) | 10 (8.333 s)         | 143.0 ms       | 276.1 ms       | 142.9 ms              | 50,636,974               | 4,954 kb/s    | 42.5 s      |
| 30/1       | **2 s**         | 41 (2.000 s)         | **23.4 ms**    | **59.5 ms**    | 142.3 ms              | 51,539,510 (**+1.78 %**) | 5,044 kb/s    | 42.7 s      |
| 30000/1001 | 8.3 s (current) | 10 (8.342 s)         | 142.2 ms       | 276.2 ms       | 143.1 ms              | 50,523,498               | 4,938 kb/s    | 42.6 s      |
| 30000/1001 | **2 s**         | 41 (2.002 s)         | **22.7 ms**    | **59.4 ms**    | 142.5 ms              | 51,430,322 (**+1.79 %**) | 5,028 kb/s    | 43.7 s      |

- Every Final seek succeeded: 100/100 `ok` in all four cells. Both builds produced 2,415 frames with identical durations (80.500 / 80.580 s).
- The Preview control is unchanged between builds (p95 142–143 ms), which confirms the difference comes from the delivered file, not from the run conditions. The 8.3-s control reproduced the earlier Final p95 (276 ms, matching `FiGn9e`), and its exports are byte-identical to the earlier ones (`86fdbed5…`, `6587c236…`).
- The measured p95 of about 59 ms is better than the ~83 ms model estimate. With 2 s spacing, the longest distance to a keyframe is 1.9 s (it was 8.1 s).
- The Final path still decodes about 30 ms per second of distance, versus 18 for Preview. The unexplained ~2× per-second cost therefore persists, but at 2 s spacing it bounds seeks to under 70 ms.
- One Preview seek in the 8.3-s control run (30/1) was classified `same-frame-no-new-frame`. This is the known Chromium behaviour noted in the close-out and is unrelated to the change.
