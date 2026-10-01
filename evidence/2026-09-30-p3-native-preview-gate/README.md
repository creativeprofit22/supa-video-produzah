# P3 · Native preview compositor: measurement gate re-checked at HEAD (2026-09-30)

Roadmap phase `d665936f-3966-41ef-96f4-deed6148c537`. This re-measures the gate that `evidence/p2-native-performance/closeout-2026-09-27.md` §11 recorded at `2a356b0b`, now at current HEAD, and adds one first-cut-shaped project.

**Decision: still defer, with measured justification.** No revisit trigger is hit. The WebView/`<video>` preview meets every written target at HEAD, including on an automatically produced first cut. No compositor was designed or built.

## 1. Identity

- HEAD `5584cb4823a481c2f68465a07d3bb82c65bd7f69`. Snapshot `evidence/p2-native-performance/runs/snapshot-hAD0pH/identity.json` (sha256 `58a7255d754abcd228277bcd3751bc797a254049c3b124aa1822ecb7b76c3f9c`).
- The application-only digest uses the §1 method (source inventory with `evidence/` excluded): `c9c5bdbf9b4c6fa7ff156a1d52e2a54f6c0c54ed553cd59f31bc2b5ff81f88a0` over 656 files. The same method applied to the old snapshot `runs/snapshot-qUm2Jq` reproduces `d4b73062…532f` over 465 files, so the two are comparable. The app changed between the runs; that is why the gate is re-measured.
- Preview-relevant changes since `2a356b0b`:
  - The monitor stage now takes the sequence's aspect ratio, and the caption overlay moved into its own component.
  - Preview now reads generated captions from the active caption artifact.
  - `@supa-video/produce` now builds first-cut timelines automatically.
- Launcher receipt `runs/launcher-6bddff38882644cfb9a5ee567098e082/receipt.json` and media receipt `runs/media-9f3WSn/receipt.json` were both present and reused. Nothing was rebuilt.
- Releases were assembled at HEAD:
  - `native-uninstrumented`: `runs/release-vVkbEW`, executable sha256 `9b98d18945337ac9a34c188969eb8203eae7b2a9fd0a1ef492d0138e87dcf854`.
  - `native-profile`: `runs/release-mX3WJY`, executable sha256 `1f64547643b7abcb60eff6de54d1d6f55b459ae5af9b900c9ab7974431ed7b85`.
- WebView2 154.0.4258.37.
- Tracked tree: no content changes. `git status` lists `apps/desktop/src-tauri/Cargo.toml` as `M`, but its working-tree blob equals HEAD's (`6a09f7115830312bff205795398688f4ff305b0a`). The release build only touched its timestamp.

## 2. Harness suite

The run used `node --test evidence/p2-native-performance/*.test.mjs` with both receipts.

| Run                             | Result                                                                                                                                                                                                                                   | Log (git-ignored `runs/`)      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Parallel (default concurrency)  | 43 tests, 42 pass, 1 fail: `native-harness.test.mjs` "owned native tree is sampled and fully reaped on explicit teardown" (the `processCount >= 2` sampling assertion, under parallel load)                                           | `p3-harness-suite-2.log`       |
| Serial (`--test-concurrency=1`) | **43 tests, 43 pass**                                                                                                                                                                                                                     | `p3-harness-suite-serial.log`  |

The failure only appears under parallel load: a process-count sample taken while other suites compete for the CPU. The serial run passes every test, so it is load-sensitive rather than a regression. The previously known same-frame re-seek failure on headless Chromium (`seek-attribution.test.mjs`) **passed** in both runs at HEAD. An earlier attempt (`p3-harness-suite.log`) passed the receipts with the wrong relative paths and is void.

## 3. Host load: one voided run

The first `native-uninstrumented` attempt (`runs/workloads-native-uninstrumented-Gcz40O`, stopped after 2 of 6 cells) ran while another project's Python tuning job (`diffusion-studio-2`, 6 processes) held the 12-thread CPU at about 100 % (`p3-cpu-uninstrumented.jsonl`, p50 99 %). It recorded 62.9 % visible drops on the first export-reference 30/1 Preview repeat, and 21.3 % on the first Final repeat. That was contention, not the preview. Following the user's choice, I waited until the job had finished and the host had been under 30 % load for 5 minutes, then re-ran everything below. The voided run is not used for any number here.

CPU during the valid runs (`cpu-log.ps1`):

- Uninstrumented: `p3-cpu-uninstrumented-2.jsonl`, p50 13 %, p95 32 %.
- Profile: `p3-cpu-profile.jsonl`, p50 10 %, p95 96 %. Every sample above 60 % has the harness's own export encode (`ffmpeg`) on top, during the export-reference cells, with no outside process.

## 4. Matrices at HEAD

Index files:

- `native-uninstrumented`: `runs/workloads-native-uninstrumented-XzYN9G/index.json` (sha256 `0d142c6e0d98d3080a678c538ee0bfd543d070ef69659e901d3e06db79c14933`)
- `native-profile`: `runs/workloads-native-profile-WxNk1l/index.json` (sha256 `09c779d2ecb359704e5dba31eb60b6131652fdfc73c7306a212e74c4f4d4507c`)

Both have status `passed`, and every session closed with `empty: true`.

Visible-layer drops are shown as dropped/visible frames for each of 3 repeats. Unattributed intervals were 0 in every repeat. Seek p95 is the presented-frame latency over 100 seeded seeks.

| Workload         | Rate       | Mode    | Visible drops (uninstr.) | Visible drops (profile) | Seek p95 uninstr. / profile | Seek p95 at `2a356b0b` (§11) |
| ---------------- | ---------- | ------- | ------------------------ | ----------------------- | --------------------------- | ---------------------------- |
| export-reference | 30/1       | Preview | 0/1800 ×3                | 0/1800 ×3               | 142 / 142 ms                | 142 ms                       |
| export-reference | 30/1       | Final   | 0/1800, 0/1801, 0/1800   | 0/1801, 0/1800, 0/1800  | 58 / 59 ms                  | 59.5 ms (after `f2dec06`)    |
| export-reference | 30000/1001 | Preview | 0/1799 ×3                | 0/1798, 0/1799, 0/1800  | 141 / 142 ms                | 143 ms                       |
| export-reference | 30000/1001 | Final   | 0/1799 ×3                | 0/1799, 0/1798, 0/1798  | 58 / 59 ms                  | 59.5 ms (after `f2dec06`)    |
| timeline-1000    | 30/1       | Preview | 0/396 ×3                 | 0/396 ×3                | 54 / 53 ms (24 ok)          | 51 ms (ok seeks)             |
| timeline-1000    | 30000/1001 | Preview | 0/397, 0/395, 0/396      | 0/397, 0/396, 0/396     | 51 / 52 ms (24 ok)          | 51 ms (ok seeks)             |
| two-layer        | 30/1       | Preview | 0/1814, 0/1814, 0/1813   | 0/1814 ×3               | 356 / 344 ms                | 361 ms                       |
| two-layer        | 30000/1001 | Preview | 0/1813, 0/1813, 0/1812   | 0/1813, 0/1813, 0/1812  | 375 / 342 ms                | 341 ms                       |

Notes on the table:

- **Final seeks.** Final seeks had 0 failures in both runs. The 2-second keyframe export (`f2dec06`) keeps Final seek p95 well under the 250 ms measurement-plan target.
- **timeline-1000 seeks.** Its 76 non-`ok` seeks per run are all `gap-no-video-frame`: seeds that land between clips, where no frame should be presented. This is the same workload shape as at `2a356b0b`, not a failure.
- **Observer-free control.** In the uninstrumented run, the observer-free control advanced every frame on the single-layer workloads (1798–1801 per 60 s).

**React commits during playback** (profile, 3 repeats each):

| Workload         | Workspace commits              | Timeline commits | At `2a356b0b` (§11)          |
| ---------------- | ------------------------------ | ---------------- | ---------------------------- |
| export-reference | 0/s                            | 0/s              | n/a                          |
| timeline-1000    | 3.0/s, p95 2.8–2.9 ms          | 0/s              | 3.0/s, p95 4.0–4.1 ms; 0/s   |
| two-layer        | 0.3/s, p95 1.5–2.2 ms          | 0/s              | 0.3/s, p95 1.1–1.5 ms        |

## 5. First-cut-shaped project (the "real project" trigger)

Script: `first-cut-preview.mjs` (sha256 `afe44e584cf887a45e4655011bb951c00e0bc12c3a5bdd0b7caa6159639dc9cf`). Output: `first-cut-native-profile.json` (sha256 `377ce771b31dd575ff079f05d2fa3db318ff9cbcb1f548a2dd53a91ee64bf1b2`). Raw artifacts: `runs/p3-first-cut-native-profile-2fsi0v/`. Run 2026-09-30T18:26Z after 5 min under 30 % CPU; CPU during the run p50 22 %, max 34 % (`runs/p3-first-cut-rerun.log`). WebView2 had auto-updated to 154.0.4258.48 by then.

This replaces an earlier run (`runs/p3-first-cut-native-profile-Rd2d3F/`, output sha256 `d88562b5…7436`) that played the single 27.8 s first cut inside the 60 s window. Playback stopped about 22.8 s in, so its commit rates were divided by 60 s of mostly idle time (published as workspace 0.3/s, timeline 0/s; really about 0.8/s and 0.04/s while playing) and its 0/443 visible-drop count covered only those ~23 s.

How it works:

- The script applies the committed explainer first-cut command group (`../2026-09-30-p3-first-cut/explainer-proposal.json`, the `packages/video-produce` explainer fixture's output) to a new native project, in one `video_execute_project_group` call.
- It then prepares assets, closes the project, and reopens it through the real Open-project path.
- It measures Preview with the P2 harness: `playbackSamples` (60 s × 3 with the visible-drop observer and the profiler), then 100 seeded seeks through the harness seek entry (`seekSamples`).
- The fixture's synthetic asset IDs are bound, alternating, to the two pinned 30/1 P2 sources. Clip timing, caption track, markers and IDs are applied verbatim.
- So the measured window sees continuous playback, the clip and caption layout is repeated back to back until the timeline covers ≥ 66 s (5 s warm-up + 60 s window + margin). Copy 0 is verbatim; copies 1–2 are offset by 834 and 1668 frames with derived IDs. Markers are not repeated. `summary.timeline.repeatCount` records the 3 copies.
- Seeks use only the first copy (frames 0–833), so they sample the verbatim first cut.

The first cut has 834 frames (27.8 s): a video track with 5 clips (frames 90–354, 444–540, 726–834) and a caption track with 4 title cards covering the gaps between them. There are 2 markers. Repeated 3×, the measured timeline is 2502 frames (83.4 s) with 15 clips and 12 title cards.

| Measure                          | Result                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Visible-layer drops              | **0/1086, 0/1091, 0/1091 (0 %)** over 60 s of continuous playback (`stillPlayingAtEnd: true` in all 3), 0 unattributed intervals, meets the 1 % target in every repeat |
| Hidden-layer frames              | 643/642/641 decoded, 0 dropped (preloaded next clips)                                                                    |
| React commits                    | workspace 1.0/s (60 per 60 s in each repeat, p95 1.8–1.9 ms), timeline 0/s                                               |
| Seeks (100)                      | 62 `ok`, 2 `same-frame-no-new-frame` (correct), 36 `gap-no-video-frame`                                                  |
| Seek presented p95 (ok seeks)    | **79.4 ms** (p50 37.6, p99/max 101.8)                                                                                    |
| Cleanup                          | `empty: true`                                                                                                            |

All 36 gap seeks land in the title-card ranges (0–89, 354–443, 540–725), which have no video by design. Workspace commits at 1.0/s stay well below timeline-1000's 3.0/s, so the gate decision is unchanged.

## 6. Revisit triggers (§11)

| Trigger                                                                  | Status at HEAD                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A product target is written for multi-layer seek latency                 | **Not hit.** No such target exists in the repo. Two-layer Preview seek p95 is 342–375 ms, unchanged from 341–361 ms. It stays an open note, and this deferral depends on it staying untargeted.                                                                         |
| Visible drop rate above 1 % on a real project                            | **Not hit.** 0 % in every matrix cell in both builds, and 0 % on the auto-produced first cut. The only non-zero readings (62.9 %, 21.3 %) came from the voided contended run (§3).                                                                                              |
| A profile attributes seek/presentation cost to WebView composition       | **Not hit.** Unattributed intervals are 0 everywhere. Commit load is unchanged or lower. Seek latency still tracks decode: Final dropped with the export GOP, and two-layer still includes the covered layer's decode. No evidence points at composition.            |

## 7. Phase criteria

- **Current profiling shows whether preview fails a product target a compositor would fix:** it does not (§4–6). The deferral stands at HEAD, with measured justification.
- **Conditional compositor criterion** (build a native compositor only if the gate requires it): **not triggered.** No compositor code, crate, or GPU dependency was added.
- **License:** **no third-party compositor code was adopted.** The repositories below were consulted only as architecture references for a possible later plan. No code, shaders, or assets were copied, and no license obligation is taken on. Where a project's license is custom or unverified (for example Smelter, formerly live-compositor, which uses a custom license and is not indexed in the corpus), no permission is inferred.
  - jub0t/Concat (wgpu preview host): <https://github.com/jub0t/Concat/blob/64b48290d908519f046518ff58e7e1d7e2d5c368/engine/crates/concat-host/src/preview.rs#L68>
  - ffplayout (GPU output with device-loss flag): <https://github.com/ffplayout/ffplayout/blob/5c71df5c4c28f2127f1ad517a1e5c5ff31057fe9/backend/engine/src/output/desktop/gpu.rs#L31>
  - CyberTimon/RapidRAW (wgpu inside Tauri): <https://github.com/CyberTimon/RapidRAW/blob/f00145c11fd57043476574a384be7409a0a18e76/src-tauri/src/gpu_processing.rs#L64>
  - gausian-AI/Gausian_native_editor (native editor GPU context): <https://github.com/gausian-AI/Gausian_native_editor/blob/2e173a0d9ad60ad662a7b858e2141a8540567d70/apps/desktop/src/gpu/context.rs#L8>
  - CapSoftware/Cap (GPU pipeline in a Tauri app): <https://github.com/CapSoftware/Cap/blob/cb8286808fd4021eaf6d7084c4c43f31515ccc90/apps/desktop-gpui/src/camera_blur.rs#L177>
  - getopenscreen/openscreen (compositor crate): <https://github.com/getopenscreen/openscreen/blob/0c749073decb588961953e34be3579c84b0c77c5/crates/compositor/src/d3d_linux.rs#L60>

## 8. Open notes (not triggers)

- **Two-layer Preview seek p95 of 342–375 ms has no product target.** If one is written below that, the first trigger is hit and this gate must be re-run.
- **Long sessions are still not proven leak-free.** The last 60-minute soak (2026-09-20, `native-window-Ka5qIA`) was not repeated at HEAD.
- **The Final path's unexplained ~2× per-second decode cost** (§11) was not re-investigated. At a 2 s keyframe interval it is minor next to the 250 ms target (Final p95 58–59 ms).
- **Measurements are only valid on an idle host** (§3). Future re-runs should log CPU and discard contended cells.
