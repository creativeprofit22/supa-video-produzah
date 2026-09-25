# P2 — playback commit isolation (2026-09-24/25)

**Result:** during ordinary playback, the editor (`VideoWorkspace`) now commits 0–3 times per second and the timeline (`MultitrackTimeline`) 0 times. Before, they committed about 60 and about 30 times per second on every workload. The commit cadence (≤10/s) and the 1,000-item workspace p95 (≤8 ms) and timeline p95 (≤2 ms) targets are met on native and browser. The Final seek p95 still misses 250 ms, and decoder drop attribution is still pending, so **P2 remains in progress**.

## What changed (application)

- **Playback clock** (`apps/desktop/src/video/playback-clock.ts`): a per-workspace store holding the live `{ playing, timelineFrame, previewSourceFrame }`. Subscribers select primitives through `useSyncExternalStore`.
- **Structure key** (`playback-structure.ts`): identifies what the editor renders at a frame (clock layer, active layers, loaded media window, active captions). It is built from the same functions the render uses (`clockLayerAtTimelineFrame`, `layerIsActiveAtTimelineFrame`, now in `layer-clock.ts` and re-exported by the monitor; `previewMediaWindow`; `activeCaptionCuesForTimelineFrame`, moved here and re-exported by the workspace).
- **Workspace commit policy:** every monitor report is published to the clock. React state commits on every report while paused, only when the structure key changes while playing, and once with the exact live frame on stop.
- **Monitor:**
  - New optional `onPlayingChange` prop.
  - Prop-to-ref adoption now happens only when the prop value changes, so an unrelated re-render with a lagging prop can no longer rewind the live clock.
  - The frame readout is written to the DOM on every report, with unchanged text, class and `aria-live="off"`.
  - The paused seek sync reads the live ref.
- **Timeline:**
  - Rendered through `memo(MultitrackTimeline)`, with stable callbacks and a memoized `orderedMediaIds`. The export name is unchanged for the profiler transform.
  - Its playhead props freeze while playing.
  - With a `playbackClock`, Split enablement subscribes to one boolean, and split and both snap contexts read the live frame. Without the clock, behavior is unchanged.

## Harness changes (explicitly approved 2026-09-24)

- `measure-page.mjs` / `metrics.mjs`: zero in-window commits are a valid result (p95 reported as none). This holds only when each profiled component recorded commits **before** the window (the profiler-liveness proof); otherwise the sample fails as "Profiler not live". The commit buffer is cleared after each window so the pre-window count cannot reuse the previous window.
- **New hard check:** summed `totalVideoFrames` must advance during the 60-s window, or the sample fails as "Playback stalled". The sum covers video elements present at window end; elements created during the window count from zero.
- **3 new harness tests:**
  - Zero commits with advancing playback pass.
  - Zero commits with stuck frames fail as a stall.
  - No pre-window commits fail as a dead profiler.
- `run-workloads.mjs`: optional `P2_WORKLOADS` subset. A subset run is recorded as `partial`, so a browser comparison cannot consume it as a full native matrix.
- `summarize-commit-isolation.mjs`: a read-only table generator used for every table below. It reproduces the 2026-09-20 report's commit figures exactly.

## Why the first rerun failed

The first rerun (`bounded-comparison-lEV8ZT`, reference 30/1 Preview) aborted with `No profiling callbacks during playback: VideoWorkspace`. The old harness treated zero commits as a broken profiler. With the fix, zero is the expected result, which is what prompted the harness change above.

## Runs

| Purpose                        | Comparison                  | Workload index                           | Build                                                                                                                                                                                           |
| ------------------------------ | --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference spot check (partial) | `bounded-comparison-1tTTq6` | `workloads-native-profile-mVvkuU`        | `release-cHLBpM` (native-profile)                                                                                                                                                               |
| Native profile                 | `bounded-comparison-xdrlxE` | `workloads-native-profile-nGxCeb`        | `release-cHLBpM`                                                                                                                                                                                |
| Native uninstrumented          | `bounded-comparison-3hENZQ` | `workloads-native-uninstrumented-hLx1TB` | `release-u8aJWS`                                                                                                                                                                                |
| Browser profile                | `bounded-comparison-95VAfm` | `workloads-browser-profile-MfAfNj`       | frontend `runs/browser-profile-commit-isolation` (fresh `vite.evidence.config.mjs --mode browser-profile` build; the 2026-09-20 `runs/browser-profile` is untouched), native data from `nGxCeb` |

All four runs reported `cleanupConfirmed: true` and a successful resource sampler. A final process query found 0 remaining owned or run-directory processes. The run protocol is unchanged: 3 × 60-s samples per mode after a 5-s warm-up, 100 seeded seeks, and seed `0x5052`. No 60-minute soak was run. Before the runs, an unrelated dev server (another project) was stopped with the user's approval. Browser windows remained open.

## Before → after: commits during playback

Before is the 2026-09-20 set (`OgQYqs` native, `nB2a2Q` browser). The p95s are per-sample ranges; "none" means no commits in the window.

| Workload         | Rate  | Mode    | Native workspace/s  | Native timeline/s | Native workspace p95 ms | Native timeline p95 ms |
| ---------------- | ----- | ------- | ------------------- | ----------------- | ----------------------- | ---------------------- |
| export-reference | 30    | Preview | 59.6–60.0 → **0**   | 30.0 → **0**      | 1.7–4.7 → none          | 0.5–0.9 → none         |
| export-reference | 30    | Final   | 53.0–60.0 → **0**   | 30.0 → **0**      | 3.3–6.3 → none          | 0.6–1.1 → none         |
| export-reference | 29.97 | Preview | 59.4–59.6 → **0**   | 29.9–30.0 → **0** | 2.8–4.9 → none          | 0.7–1.1 → none         |
| export-reference | 29.97 | Final   | 59.2–59.6 → **0**   | 30.0 → **0**      | 1.8–5.3 → none          | 0.4–1.0 → none         |
| timeline-1000    | 30    | Preview | 55.2–57.0 → **3.0** | 28.9–29.1 → **0** | 9.5–13.7 → **6.1–7.7**  | 5.4–7.7 → none         |
| timeline-1000    | 29.97 | Preview | 56.0–56.8 → **3.0** | 29.0 → **0**      | 10.7–13.2 → **5.8–6.4** | 6.2–8.9 → none         |
| two-layer        | 30    | Preview | 59.5–60.0 → **0.3** | 29.9 → **0**      | 2.5–4.6 → 2.1–3.4       | 1.2–2.0 → none         |
| two-layer        | 29.97 | Preview | 59.0–59.3 → **0.3** | 29.9 → **0**      | 1.9–6.2 → 2.4–2.8       | 0.7–2.3 → none         |

| Workload         | Rate  | Mode    | Browser workspace/s | Browser timeline/s | Browser workspace p95 ms |
| ---------------- | ----- | ------- | ------------------- | ------------------ | ------------------------ |
| export-reference | both  | both    | 56.9–60.0 → **0**   | 30.0 → **0**       | → none                   |
| timeline-1000    | 30    | Preview | 57.4–58.0 → **3.0** | 29.1 → **0**       | 5.0–7.2 → 5.0–5.6        |
| timeline-1000    | 29.97 | Preview | 57.5–57.8 → **3.0** | 29.1 → **0**       | 4.9–7.3 → 5.0–6.2        |
| two-layer        | both  | Preview | 59.1–59.9 → **0.3** | 29.8–29.9 → **0**  | → 1.9–2.5                |

The remaining workspace commits are the intended structural commits:

- **1,000-item timeline:** 180 per 60 s, one per clip change as the playhead crosses short clips.
- **Two-layer:** 20 per 60 s, at layer or window changes.

The timeline did not commit in any playback window on any target.

**Liveness and playback proof, per sample:**

- Every profiled sample recorded pre-window commits for both components: 9–31 for the workspace and 5–8 for the timeline, and up to 1,397 / 717 in the first Final sample, which follows the paused seek batch.
- Video frames advanced in every sample. The reference workload advanced about 1,800 frames per 60 s (full 30 fps) with 0 dropped frames, and frame-gap p95 stayed at 33.4–33.5 ms.
- **Limitation of the stall check:** on the 1,000-item timeline, video elements are created and removed as the loaded window moves. The frame-advance sum therefore counts only 4–7 frames from elements alive at window end, while the decoder segments show about 1,810–1,845 frames decoded across 40 elements. The check passes there but is weak on that workload.

Frame-gap p95 on the 1,000-item timeline changed from 50.2–66.7 ms to 50.0–50.1 ms (native profile). This is shown for context, not as a target.

## Seek statistics, re-derived with the fixed observer

The 2026-09-24 observer fix is in place for these runs. Every timeout recorded before is gone. The gap classifications are unchanged.

| Workload         | Before ok/gap/timeout (native & browser) | After ok/gap/timeout |
| ---------------- | ---------------------------------------- | -------------------- |
| export-reference | 100/0/0                                  | 100/0/0              |
| timeline-1000    | 20/76/4                                  | 24/76/0              |
| two-layer        | 87/0/13                                  | 100/0/0              |

This matches the attribution report: all 102 recorded timeouts were observer artifacts, and this rerun records no genuine seek failure.

Presented-frame p95 for successful seeks, in ms, after the fix:

| Workload         | Mode      | Native profile | Native uninstrumented | Browser |
| ---------------- | --------- | -------------- | --------------------- | ------- |
| export-reference | Preview   | 140–155        | 142                   | 311–327 |
| export-reference | **Final** | **290–291**    | **288–289**           | 494–512 |
| timeline-1000    | Preview   | 60–64          | 54–55                 | 96–101  |
| two-layer        | Preview   | 365–394        | 339–356               | 517–551 |

- **Final seek p95 still misses 250 ms** on native (288–291 ms, previously 275–289 ms). This change did not target it.
- The two-layer p95s now include the 13 formerly-timed-out seeks, so they are not directly comparable to the old values.
- The browser reference seeks are slower than on 2026-09-20 (Preview 272–278 → 311–327 ms; Final 428–444 → 494–512 ms), while the native reference seeks are unchanged. The cause has not been diagnosed. Browser windows from other apps were open during these runs.

## Verification

- Application:
  - `pnpm test`: 899 tests pass, with the unrelated dev server stopped. Earlier timeouts under heavy CPU load did not reproduce.
  - `pnpm check`: passes.
  - Explicit ESLint and Prettier: clean on `apps/desktop/src/video`.
  - New or updated suites:
    - `playback-clock.test.ts`
    - `playback-structure.test.ts`: exact boundary frames at both rates, fractional speed, gaps, captions, legacy mode.
    - `ProgramMonitor.test.tsx`: live readout, no rewind on a stale prop, `onPlayingChange`.
    - `VideoWorkspace.test.tsx`: 0 commits inside a clip, 1 commit at a caption boundary with the exact caption, exact frame on stop.
    - `MultitrackTimeline.test.tsx`: split at the live frame with frozen props.
- Harness: `node --test harness.test.mjs` passes 12/12. Explicit ESLint and Prettier are clean on the changed harness files.
- **Repository-wide `pnpm lint` / `pnpm format:check` still fail, only on untracked evidence files.** See the incident below.

## Incident: evidence files reformatted

During verification, `pnpm format` (Prettier write mode) was run once. It rewrote 883 untracked evidence files: 870 in this folder and 13 in `2026-09-16-p2-editor-controls-completion`. Git holds no copy of them. No backup was found: File History is off, OneDrive is not configured, and the `E:\Backups` and `E:\Archive` folders do not contain the project. Shadow copies could not be queried without admin rights.

- **265 hash-bound files were restored byte-for-byte.** Each file was re-serialized from its own parsed content and accepted only when the SHA-256 matched a hash recorded elsewhere in the evidence.
- 618 files remain reformatted. None of their hashes appears anywhere in the evidence. Content and meaning are unchanged; only whitespace, quotes and line breaks differ. Most are build output under `runs/`.
- File lists and the recovery scripts: `.gg/incidents/2026-09-24-prettier-evidence/`.

## P2 criteria status

| Criterion                                                         | Status                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| Playback updates must not re-render the full timeline             | **Met.** 0 timeline commits in every playback window, all targets |
| ≤10 commits/s for workspace and timeline during ordinary playback | **Met.** Maximum 3.0/s                                            |
| 1,000-item workspace p95 ≤8 ms / timeline p95 ≤2 ms               | **Met.** Workspace 5.0–7.7 ms; timeline has no commits            |
| Final seek p95 ≤250 ms                                            | **Not met.** 288–291 ms native                                    |
| Frame-drop target with visible-layer decoder attribution          | **Pending.** Out of scope for this change                         |

P2 remains in progress. Nothing was committed.

## Follow-up: did this change slow browser seeks? (2026-09-25)

**Answer: no evidence that it did.** Most of the browser seek rise is environmental. The old build reproduces it today.

Method: back-to-back, reference-only (`P2_WORKLOADS=export-reference`) browser-profile runs with identical inputs, first the old build and then the new one. A 10-s CPU logger ran alongside, and no other project's build or test process was running during either run.

| Run     | Frontend                                  | Comparison / index                                               | Mean machine CPU |
| ------- | ----------------------------------------- | ---------------------------------------------------------------- | ---------------- |
| A (old) | `runs/browser-profile` (2026-09-20 build) | `bounded-comparison-cPFFuY` / `workloads-browser-profile-qdMqUj` | 20.4%            |
| B (new) | `runs/browser-profile-commit-isolation`   | `bounded-comparison-Uzaeel` / `workloads-browser-profile-8ikoWz` | 31.4%            |

Both runs passed with `cleanupConfirmed: true` and 100/100 successful seeks per mode.

| Rate / mode   | Presented p95 old → new (ms) | New − old p95, 95% bootstrap CI | New − old p50, 95% CI |
| ------------- | ---------------------------- | ------------------------------- | --------------------- |
| 30 Preview    | 311 → 292                    | −19 [−52, 52]                   | −8 [−85, 98]          |
| 30 Final      | 442 → 510                    | +68 [0, 171]                    | +34 [−99, 182]        |
| 29.97 Preview | 294 → 312                    | +18 [−20, 66]                   | +14 [−81, 99]         |
| 29.97 Final   | 509 → 543                    | +33 [−89, 194]                  | +4 [−117, 154]        |

- **The old build is slower today than on 2026-09-20.** Its Final p95 is 442/509 ms now against 428/444 ms then, and Preview is 311/294 ms against 278/272 ms. The rise reported for the full run (Final 494–512 ms) therefore mostly reflects the machine and session, not the code.
- **Three of four rows show no difference.** Their confidence intervals comfortably include zero.
- **30/1 Final is borderline** (+68 ms, CI lower bound 0). It is confounded: the new build ran under about 11 points more background CPU, from this editor's own web view. One pair with a fixed order cannot separate order or load from code.
- **No mechanism found.** Paused seeks commit on every report exactly as before. The added per-report work is one structure-key computation, which is O(layers) and trivial on a one-clip reference, plus one text write and one clock publish.
- **No fix made.**

### Swapped-order repeat (new build first, then old)

This pair ran new first (`bounded-comparison-mbEg3a` / `workloads-browser-profile-a9mZSY`), then old (`bounded-comparison-ftnhbv` / `workloads-browser-profile-QNObhX`). Machine load was equal this time: mean CPU 29.7% vs 29.6%, with no other project processes. Both runs passed with `cleanupConfirmed: true` and 100/100 successful seeks per mode.

| Rate / mode   | p95 old₁ / new₁ / new₂ / old₂ (ms) | Pair 2 new − old p95, 95% CI | Both pairs pooled, new − old p95 | Pooled p50     |
| ------------- | ---------------------------------- | ---------------------------- | -------------------------------- | -------------- |
| 30 Preview    | 311 / 292 / 292 / 310              | −18 [−65, 39]                | −19 [−41, 33]                    | +6 [−67, 65]   |
| 30 Final      | 442 / 510 / 526 / 479              | +48 [−68, 165]               | +76 [−2, 111]                    | +20 [−66, 134] |
| 29.97 Preview | 294 / 312 / 295 / 294              | 0 [−82, 50]                  | +15 [−32, 49]                    | +13 [−51, 66]  |
| 29.97 Final   | 509 / 543 / 509 / 511              | −2 [−107, 88]                | +13 [−82, 98]                    | +2 [−90, 116]  |

**Conclusion: no measurable regression. The 30 fps Final row is not fully settled.**

- **Three rows show no difference in either order.** 30 Preview, 29.97 Preview and 29.97 Final all have intervals centered near zero.
- **30 Final is higher on the new build in both pairs,** but no interval excludes zero. The pooled p95 interval [−2, 111] only barely includes it, and the median shows no shift (+20 [−66, 134]).
- **The same Final code path shows nothing at 29.97.** Final mode drives the same code at both rates, and the 29.97 Final row is flat (−2 ms in the load-matched pair). That argues against a code cause.
- **No fix made.** Settling the 30 fps Final tail for certain would need more repeated pairs. The Final seek latency work, a separate P2 item, would measure this path directly anyway.
