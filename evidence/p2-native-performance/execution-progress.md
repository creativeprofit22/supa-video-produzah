# Execution continuation — 2026-09-19 UTC

This is a running evidence ledger, not a phase completion claim. Historical files remain unchanged.

## Additional authorizations

The user approved (1) a build-time diagnostic entry into ProgramMonitor's existing `seekTo` function, preserving real quantization and ordinary builds; (2) retaining the observed multi-clip export failure, adding a supported single-clip export reference with longer media, and continuing larger Preview workloads without changing the export engine. Unsupported larger Final claims stay unverified.

## Step 3 completed

New owned C++ job launcher, native process/port identity checks, real picker adapter, fixture/native/browser drivers and sampler success/cleanup regressions are implemented. Current launcher receipt: `runs/launcher-5cd7b8bacb294e79b3724f2de19e269d/receipt.json`. Build succeeds with installed MSVC/SDK, no downloads. Thirteen harness regressions, desktop typechecks and evidence lint passed in `8c5b03bf-477a-4591-aad5-2ba993dd6f91` (exit 0). Subsequent measurement-driver corrections are recorded below and require final checks.

The seek observer preserves the original HTMLMediaElement setter, observes the real application seek entry and records request-to-seeked / matching frame callback timing. It never replaces app seeks with test-only time assignments. Source-reset counter segments, caps, lease cleanup and exact setter restoration are covered. Browser fixture uses mock IPC but actual native-produced proxy/Final files, with an owned loopback allowlisted streaming server; this is never native proof.

## Step 4 completed for supported scope

Initial assembly `release-rIHls5` compiled, but native target validation rejected its file URL. Installed tauri-utils 2.9.3 `FrontendDist` deserialization tries URL before Path; the generated config was corrected to a relative path into the owned frontend directory. The first launch failure and all subsequent failed setup runs are retained. No target check, CSP, asset scope or IPC permission was relaxed.

Corrected unprofiled release: `runs/release-b7LpD3/receipt.json`, SHA-256 `0ea2c478463895d20e3921e2c80d23774e55dd521e18270608acddf763d69226`. Build execution `59c57544-5e51-4a69-8bad-b53a91c2b3f8`, exit 0. Offline, locked, isolated identifier/output/frontend, no bundle installation. All seven assembled resources equal pinned source bytes. Authenticode reports NotSigned, not a legal/distribution conclusion.

The original multi-clip reference really imports/prepares/plays, but export is disabled with: **Final export requires exactly one clip per video track**. Failure: `runs/native-yPmN85/baseline.json`, SHA-256 `dc23c839d470e6bb1a0009b0d31745751e738707a9a7952e3e3cc7f31ad2e452`. It remains a limitation, not a passed scenario.

Approved longer synthetic inputs: `runs/media-9f3WSn/receipt.json`, SHA-256 `537f72016880ddd18b82edb708320e4c19cda48d36ec45d2075f8db014abc6cf`. Four 90-second sources, two variants at both cadences. The original 40-second inputs/receipts remain intact. `export-reference` is separately named; original `small` is not silently redefined.

Supported release baseline: `runs/native-Od0MbY/baseline.json`, SHA-256 `b21219e31a3ca8ae9a53fbe0e43880aa3faeb0ec9fe78b252448f5b1849fb766`. Execution `b089cc2e-f6de-4a68-8c27-154fc685d7dd`, exit 0. Real Windows picker/import, preparation, Preview playback, export, verified Final playback, cancellation (no destination/partial), normal close and reopen. Reopen does not restore source grants across process lifetimes: fresh processes must repick the source or use Restore source access; no bypass is made.

`4f8fccde-eb26-4ac5-8762-f53291c7a007`, exit 0: exported 2,415 video frames; decoded audio 3,864,576 samples versus timeline 3,864,000 (576 padding samples, within the existing one-frame duration assertion). Current native mock-IPC render/probe test passed using this release resource directory, preserving the distinction from real WebView proof. Signature read-only check reported NotSigned.

Production profiling release: `runs/release-M3ec0Y/receipt.json`, SHA-256 `9c3fe59f05b98ed103388752bdb082a706ab811b7223a3a46c2721bb7cdb9cc2`; execution `af98748d-6923-4977-b850-340e0ad1d2b7`, exit 0.

## Step 5 in progress

First full native profiling matrix: `runs/workloads-native-profile-MtMVq0/index.json`, SHA-256 `5666b2de8222a39578d3453d6f60691d15a49e141bfef5004cae659b8632477f`. Execution `0d8544e3-b9c5-4b7e-9b00-19d1c63404d9`, exit 0. Six workload/cadence combinations, eight modes (Preview for all, Final for export-reference), each with three independently rewound/warmed 60-second playback samples and 100 seeded seek requests. Index `passed` means the collector completed; it does not mean every seek succeeded or every workload met a performance gate.

Earlier attempts `workloads-native-profile-CM8ri7` and `-XS9SJn` stopped because the harness incorrectly read nonexistent transport attributes. Corrected by reading the actual Play/Pause button label, then exercising three restart cycles in the real browser fixture. Their raw samples/failures are not rewritten or merged into the final playback batch.

The completed batch revealed a separate Preview selector error: it matched no canonical video layer, so all original Preview seeks were `request-not-observed`. They are **not latency observations and not application seek failures**. Final seeks and playback captures remain valid. Corrected Preview-only rerun: `runs/preview-seek-correction-7VUyr1/index.json`, SHA-256 `6414aea29a27c2d6d8a8a193b485ea298e7e632781484fe0124044c0d4e04686`, execution `14dd05dc-f4a1-4623-beb1-aa43bb3d0643`, exit 0. It restores source access through actual pickers before reopening the same saved synthetic projects. Gaps, unmatched requests and timeouts are retained; large-workload seek completeness must be assessed, not assumed from exit 0.

Observed so far: reference playback counters report no dropped frames; the 1,000-item timeline has heavier commits/long gaps; two-layer runs report substantial decoder drops. None is yet attributed to GPU limits or React alone. Unprofiled/observer-free and browser comparisons, the 60-minute session, final regression checks and the final criterion matrix are still outstanding. Do not mark this phase Done from this file.

## 2026-09-20 — interrupted browser diagnosis and explicitly approved fix

The entries above are historical stage evidence. Subsequent bounded diagnostics isolated a launcher standard-handle startup defect and then excessive browser media loading. The replacement launcher receipt is `runs/launcher-6bddff38882644cfb9a5ee567098e082/receipt.json`; see `launcher-fix-report.md`. Old release/launcher receipts were preserved, not relabeled.

The user explicitly authorized a focused app-level preview-loading fix after the diagnostic-only media control reproduced 11.87 GiB of sampled single-Chrome private memory. Implementation and final checks are recorded in [preview-media-window-fix.md](preview-media-window-fix.md): the same idle fixture now mounts one rather than 667 media elements and samples 114.41 MiB for the largest Chrome process. A complete 60-second browser playback sample and eight distant video/audio media-readiness seeks now finish with confirmed cleanup. All 87 affected app tests, workspace type checks, and targeted lint passed.

This is browser/mock-IPC evidence with actual media, not a new native release or full phase acceptance. The observer's lifetime tracking cap limits whole-session frame claims. No full matrix, native soak, new native export, install, commit or Roadmap completion was performed during this authorized fix. The broader phase remains in progress.

## 2026-09-20 — fresh bounded native check, partial evidence / failed unloading assertion

Fresh offline/locked isolated native assembly `runs/release-x7bGX5/receipt.json` passed from the fixed source. One native 1,000-item check completed real preparation/reopen and 60.0194 seconds of playback; largest sampled single-WebView private memory was 227.64 MiB, and peak summed native private memory during playback was 524.83 MiB. These are native playback measurements, not a direct comparison with browser idle memory.

The check exited 1 on its first post-playback unloading inspection: the detached element was paused, had no `src` attribute and `readyState: 0`, but still reported its previous `currentSrc`. This does not alone establish retained buffers or a leak. The remaining distant video/audio seek checks were not executed. Native and outer Job Object cleanup both confirmed empty, with zero processes in the final independent resource sample. No retry, further app change or full-matrix/soak run was made.

Full source/build/run receipts, failure details, resource/counter limitations and verification outcomes: [native-window-check.md](native-window-check.md). P2 remains in progress; next work must distinguish WebView reset/property timing from actual media-resource retention before treating native unloading and the seek suite as verified.

## 2026-09-20 — authorized unloading follow-up and completed native seeks

The subsequent “go” authorized resolving the URL assertion and completing the native checks. One-element real-media reproduction established that the URL persists even with zero readiness/network/buffered/seekable state; a missing-`load()` negative control is correctly rejected. Only the evidence driver changed, adding bounded event and before/immediate/settled resource observations. No application change or rebuild was necessary.

New run `runs/native-window-IHiFW0/` passed: 60.0168 seconds of playback, all eight video/audio start/middle/end/return seeks, and ten observed detached-media resets with `emptied` events and empty exposed resource state. All ten still retained the old URL; it was an invalid unloading proxy. Largest sampled WebView private memory 256.10 MiB, summed native peak 565.24 MiB during playback. Observer lifetime cap still limits frame/drop claims. Both owned jobs and final zero-process resource sample confirmed cleanup.

Detailed causal evidence, controls, checks and receipts: [native-unload-followup.md](native-unload-followup.md). This closes the bounded native readiness/unloading check, not the whole P2 phase, smoothness acceptance, internal allocator retention or long-session memory verification. Remaining comparisons and soak were not started.

## 2026-09-20 — authorized comparison matrices and 60-minute active native soak completed

After explicit approval to proceed with the verification batch, the observer's lifetime-node cap was corrected to a live-reference cap, with a real-browser churn regression. A fresh isolated native profiling build, matching native production matrix and fresh browser control completed: 72 observed 60-second samples, 24 observer-free controls, and 2,400 seeded seek attempts including recorded gaps/timeouts. The observer no longer capped or omitted matrix samples. Collection status is not P2 performance acceptance.

Native 1,000-item workspace p95 remains 9.5–13.7 ms and timeline p95 5.4–8.9 ms, missing the approved 8/2-ms targets; timeline commits remain around 29–30/sec. Reference seeks all completed, but Final p95 misses 250 ms. Large-timeline/two-layer seek timeouts recur across native/browser targets. Aggregated decoder counters need visible-layer attribution before applying the frame-drop target.

One 60-minute active native soak completed 60 play/pause/seek cycles and six project close/reopens without losing responsiveness. Sampled native private memory peaked at 630.0 MiB; active slope +0.485 MiB/min; final idle median 371.1 MiB. Modest active memory/handle growth and the effect of project reloads are not dismissed as leak-free behavior. Independent final samples and owned-job receipts confirm cleanup for all runs.

Full results, actual command identities, source/build receipts, instrument overhead limitations, failures and remaining gaps: [comparison-and-soak-report.md](comparison-and-soak-report.md). Final 18 harness tests, 71 application regression tests, desktop type checks and explicit lint passed. No application change, install/download or commit. P2 remains in progress; these measurements do not authorize a native compositor or a Done status.

## 2026-09-24 — seek attribution (tooling only)

The Preview seek observer now latches only the connected element of the requested clip. Previously it could latch a departing layer's zero-time reset. A settled same-frame reseek with `seeked` but no new frame is now recorded as `same-frame-no-new-frame`, separate from failures. Five real-media regressions were added. After the fix, the bounded native-build reruns (`seek-attribution-mzxxDC` normal, `seek-attribution-g0LSBg` precise) completed all 6 reproduced seeks. Each run's one same-frame repeat was classified correctly, and owned-process cleanup was confirmed. All 102 recorded large-timeline/two-layer timeouts match the observer artifact: in 36, the latched write provably belonged to another element; the other 66 follow the same mechanism. No genuine seek failure was identified. The matrices were not rerun, so the recorded seek statistics are unchanged until an authorized rerun. Profiler data shows the editor root committing about 60 times per second and the timeline about 30 times per second on every workload, so playback updates reach the whole editor. Details: [seek-attribution-report.md](seek-attribution-report.md). Checks: 28/29 evidence tests pass (the native harness test needs a launcher receipt and was not run), and explicit lint passes. The pinned Playwright browser was reinstalled with user approval. No app change, rebuild or commit. P2 remains in progress.

## 2026-09-25 — playback commit isolation (app change + authorized matrix rerun)

Playback no longer re-renders the editor. A per-workspace playback clock carries the live frame, and the workspace commits only when the rendered structure changes (layers, media window, captions) and once on stop. The timeline is memoized, with frozen playhead props and a live Split/snap frame.

The harness now accepts zero in-window commits only with pre-window profiler liveness, and fails samples whose video frames do not advance (approved). Fresh native-profile (`nGxCeb`), native-uninstrumented (`hLx1TB`) and browser-profile (`MfAfNj`) matrices passed with confirmed cleanup.

Results:

- Workspace went from about 60/s to 0–3/s, and the timeline from about 30/s to 0/s.
- The 1,000-item workspace p95 went from 9.5–13.7 to 5.8–7.7 ms (native). The timeline had no commits.
- All 102 previous seek timeouts are gone under the fixed observer.
- Final seek p95 is still 288–291 ms, over 250 ms. Decoder drop attribution is still pending.

A `pnpm format` run rewrote 883 untracked evidence files. The 265 hash-bound files were restored byte-for-byte; the other 618 remain whitespace-reformatted.

Checks: 899 application tests, typecheck, and 12/12 harness tests pass. Details: [playback-commit-isolation-report.md](playback-commit-isolation-report.md). Nothing committed. P2 remains in progress.

## 2026-09-25 — browser seek regression check

The playback change did not measurably slow browser seeks. An old-vs-new, reference-only browser A/B (`qdMqUj` old, `8ikoWz` new; cleanup confirmed) shows the old build itself reproduces the higher seek times today (Final p95 442/509 ms against 428/444 ms on 2026-09-20). Three of four rows have no difference, and 30/1 Final is borderline (+68 ms, CI [0, 171]) while also confounded by higher background load during the new run. No fix made. Details: the follow-up section of [playback-commit-isolation-report.md](playback-commit-isolation-report.md).

Swapped-order repeat (new `a9mZSY` first, old `QNObhX` second, equal load 29.7%/29.6%, cleanup confirmed): three rows show no difference in either order. 30/1 Final is higher on the new build in both pairs (+48 ms p95, CI [−68, 165]; pooled +76, CI [−2, 111]), but it is not significant, and the same path at 29.97 is flat. Result: no measurable regression, and the 30/1 Final tail is not fully settled. No fix made.
