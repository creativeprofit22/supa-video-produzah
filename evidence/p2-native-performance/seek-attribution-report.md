# P2 seek-attribution diagnostic (2026-09-24)

**Result: every recorded large-timeline/two-layer seek "timeout" is attributable to the measuring harness, not to the app's seek.** 102 of 102 matrix timeouts share the signature of the fixed observer bug, and all reproduced cases now complete. **P2 is still not Done**: the React commit targets and Final-seek p95 remain missed (below, and in [comparison-and-soak-report.md](comparison-and-soak-report.md)).

Scope: evidence tooling only. No application change, rebuild, matrix, soak or commit. The one download was the pinned Playwright headless browser (Chromium 151.0.7922.34, revision 1234, the same version as the recorded runs). It had been removed from this machine and was reinstalled with the user's approval.

## Harness defects fixed

1. **Wrong element observed.** The Preview selector matched any canonical video layer. On a clip switch or gap exit, the app resets the departing layer to `currentTime = 0` in the same update. That layer is then removed, and the observer latched onto it. It then waited for `seeked` or a frame from a detached element, which never arrives, so the sample became a 5-second "timeout". The observer now latches only a **connected** element whose `data-clip-id` equals the **requested clip**. It records `requestedClipId` and the pre-write element state (`beforeWrite`). Final mode stays unfiltered because it has a single element.
2. **Same-frame reseek.** Rewriting the frame that is already displayed can fire `seeked` without a new composited frame, so `requestVideoFrameCallback` legitimately never runs. That case is now `same-frame-no-new-frame` when all of the following hold at the deadline: `seeked` arrived, no frame was presented, and the element was already settled (`readyState ≥ 2` and not seeking) on the same frame index before the write. `seekSummary` counts it separately and excludes it from both failures and latency distributions. Every other missing presentation stays `timeout`.

Regressions (`seek-attribution.test.mjs`, real media in headless Chromium, 5 tests):

- A removed decoy's zero write, followed by the target's write, is attributed to the target. The result is `ok` with real latency.
- A decoy write alone is `request-not-observed`, never a timeout on the wrong element.
- A same-frame reseek that does present a frame stays `ok`; it is not reclassified.
- A same-frame reseek with `seeked` but no frame callback is `same-frame-no-new-frame`, and the summary counts it apart from failures. Only the callback is withheld: the media, write, seek and `seeked` are real. Chromium re-presents in an isolated page, whereas the full app did not (see the reruns below).
- A write to a different frame that never presents stays `timeout`.

## Bounded reruns: the first two recorded timeouts per workload and their predecessors, native build fixtures, 180-s watchdog, owned-process cleanup

| Run                                    | Mode                      | two-layer (4 seeks)                                               | timeline-1000 (3 seeks)                      | Cleanup                  |
| -------------------------------------- | ------------------------- | ----------------------------------------------------------------- | -------------------------------------------- | ------------------------ |
| `seek-attribution-VbrUFx` (before fix) | normal                    | 2 ok, **2 timeout** (observed removed clip `…1002`, disconnected) | **3 timeout** (2 on a removed or other clip) | confirmed                |
| `seek-attribution-NmfNPz` (before fix) | precise per-clip selector | 4 ok                                                              | 2 ok, **1 timeout** (same-frame repeat)      | confirmed                |
| `seek-attribution-mzxxDC` (after fix)  | normal                    | **4 ok**, seeked 104–562 ms                                       | 2 ok, **1 same-frame-no-new-frame**          | confirmed, worker exit 0 |
| `seek-attribution-g0LSBg` (after fix)  | precise                   | **4 ok**, seeked 117–505 ms                                       | 2 ok, **1 same-frame-no-new-frame**          | confirmed, worker exit 0 |

The fixed normal selector now matches the precise per-clip selector exactly. The one remaining non-ok sample is timeline-1000 frame 37531 repeated immediately. Before the write the element was already at 0.033335 s (`readyState` 4, not seeking); `seeked` arrived in 1–2 ms, and no new frame was composited. That is a correct outcome, not a seek failure. The input hashes for these runs are in each run's `inputs.json`, which now includes `metrics.mjs`.

## Split of the recorded matrix timeouts (OgQYqs native profile, 6FTCuT native uninstrumented, nB2a2Q browser)

| Workload (each × 2 rates × 3 matrices) | Timeouts per run | Prior sample                      | Latched write |
| -------------------------------------- | ---------------- | --------------------------------- | ------------- |
| two-layer                              | 13               | on a different clip (13/13)       | `0` in 13/13  |
| timeline-1000                          | 4                | a gap (3) or a different clip (1) | `0` in 4/4    |

Across all 102 timeouts, the observed write was `0` after a clip switch or gap exit. In **36 of them the target was not 0** (for example frames 901, 1 and 37531), so the latched write provably belonged to another element. **These 36 are harness artifacts.** The other 66 targeted source time 0, where the decoy and target writes look identical in the saved samples. They are counted as **harness artifacts by the same mechanism**, because every one of them that was replayed (frame 900 ×2, frame 7155) completes with the fixed observer. The counts are identical across the native, uninstrumented and browser runs and both frame rates, which fits a deterministic observer effect, not a load-dependent decoder stall. Counts of **genuine seek failures**: none identified. That is a claim about attribution, not a re-measured 2,400-seek latency: the matrices were not rerun (per scope), so recorded seek p95s still include these samples as failures until the next authorized matrix. `gap-no-video-frame` samples (76 per timeline-1000 workload) remain correct gap outcomes and are not seek failures.

## React evidence: playback updates reach the whole editor at display cadence

Profiler commits during 60-second Preview playback (three samples per row) were read from the recorded matrices:

| Target  | Workload         | `VideoWorkspace` commits/s | `MultitrackTimeline` commits/s | Workspace p95   | Timeline p95   |
| ------- | ---------------- | -------------------------- | ------------------------------ | --------------- | -------------- |
| native  | export-reference | 59.4–60.0                  | 29.9–30.0                      | 1.7–4.9 ms      | 0.5–1.1 ms     |
| native  | two-layer        | 59.0–60.0                  | 29.9                           | 1.9–6.2 ms      | 0.7–2.3 ms     |
| native  | timeline-1000    | 55.2–57.0                  | 28.9–29.1                      | **9.5–13.7 ms** | **5.4–8.9 ms** |
| browser | timeline-1000    | 57.4–58.0                  | 29.1                           | 4.9–7.3 ms      | 3.1–4.6 ms     |

The editor root commits about 60 times per second (display cadence), and the timeline about 30 times per second (media frame cadence), **on every workload including the trivial reference project**. The commit rate therefore does not depend on project size. The playback clock is propagating through the top-level editor on every animation frame, while the ordinary-playback target is ≤ 10 per second. Per-commit cost scales with the 1,000-item timeline and is higher on native, which is why only that workload misses the 8-ms and 2-ms p95 targets. This isolates _where_ updates enter the tree. It does not yet identify the specific state subscription, and no fix was attempted.

## Checks

- `seek-attribution.test.mjs`: 5/5 pass (real media, Chromium 151.0.7922.34).
- Full evidence suite: 28/29 pass. The one failure is `native-harness.test.mjs`, which refuses to start without `P2_LAUNCHER_RECEIPT` and launches the native app. It was unchanged and out of scope for this batch, so it was not run here.
- Explicit ESLint on the five changed files: 0 problems.

## Remaining (P2 in progress)

1. Scope playback-time updates so that the editor root and timeline do not commit per frame. This is an app change: plan it before starting.
2. Rerun the seek matrices with the fixed observer to replace the artifact-contaminated seek statistics, and recheck Final-mode p95 (still > 250 ms).
3. Attribute decoder drop counts to visible layers before applying the dropped-frame target.
