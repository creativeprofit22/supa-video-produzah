# Final-seek latency diagnosis (2026-09-27)

**Result:** the Final p95 miss (287–291 ms against the 250 ms measurement-plan target) comes from distance to the previous keyframe. Every seek decodes forward from the preceding keyframe. The Final file is a byte copy of the export, and the export uses libx264's default keyframe interval of 250 frames (about 8.3 s). This is a codec-level property of the delivered file, not of the preview architecture.

No app code was changed and no new measurement was taken. The analysis joins the latencies already recorded with the keyframe layout of the exact media each mode played.

## Inputs

- Script: `final-seek-diagnosis.mjs`. Output: `runs/final-seek-diagnosis-dKm4Tu/result.json` (sha256 `cc93cfcaf61c558121ee45227dba04366713e4259b9805c427175b8e3c15e46f`).
- Runs: `workloads-native-profile-nGxCeb` and `workloads-native-uninstrumented-hLx1TB`, workload `export-reference`, both cadences, 100 seeks per mode (the recorded `Final-seeks.json` / `Preview-seeks.json`). Each seek file is hashed in the output.
- Media, each hash-checked against the run's own records before use:
  - Final: `runs/native-Wfb6D9/comparison-final.mp4` (30/1, sha256 `86fdbed5476129f8b7d7243708c09890d423e8ba46c69cdce44f71762b5277dd`) and `runs/native-3t6l7O/comparison-final.mp4` (30000/1001, `6587c23640480bfb646a8696f68928312734407550ead452351f3682e87c6c86`). Both runs rendered byte-identical exports; the `native-TXfDvL`/`native-pnx8Kr` copies have the same hashes.
  - Control: Preview. It plays the source asset directly (`media-9f3WSn/source-30-1-0.mp4`, `source-30000-1001-0.mp4`); there is no separate proxy file for this workload. The clip starts at source frame 0 and timeline frame 0, so the requested media time equals the source time.
- Keyframes come from container packet flags read by the release's pinned `media-tools/ffprobe.exe` (its hash is checked against `release-b7LpD3/receipt.json`).

## Keyframe layout

| Media                            | Keyframes | Interval                                | Codec                                         |
| -------------------------------- | --------- | --------------------------------------- | --------------------------------------------- |
| Final (both cadences)            | 10        | 8.333 s / 8.342 s (250 frames), uniform | H.264 High, level 4.0, 2 B-frames, ~4.95 Mb/s |
| Source / Preview (both cadences) | 11        | same 250 frames                         | H.264 High, level 4.0, 2 B-frames, ~5.35 Mb/s |

The seek targets span keyframe distances from 0 to 8.1 s (median 3.77 s). 36 of the 100 targets fall within 1 s of a keyframe and 48 are 4 s or more away.

## Latency vs distance to previous keyframe (presented-frame ms)

| Run    | Rate       | Mode    | p95   | Pearson r | Spearman ρ | ms per s of distance | Intercept ms | p95, <1 s from key | p95, ≥4 s from key |
| ------ | ---------- | ------- | ----- | --------- | ---------- | -------------------- | ------------ | ------------------ | ------------------ |
| nGxCeb | 30/1       | Final   | 290.3 | 0.991     | 0.964      | 37.4                 | 9.3          | 40.6               | 302.8              |
| nGxCeb | 30000/1001 | Final   | 290.9 | 0.991     | 0.959      | 37.0                 | 11.4         | 41.0               | 302.0              |
| hLx1TB | 30/1       | Final   | 288.8 | 0.986     | 0.962      | 37.1                 | 10.5         | 37.4               | 309.0              |
| hLx1TB | 30000/1001 | Final   | 287.5 | 0.986     | 0.963      | 37.0                 | 9.9          | 35.7               | 307.7              |
| nGxCeb | 30/1       | Preview | 155.1 | 0.972     | 0.944      | 19.2                 | 9.0          | 43.9               | 168.4              |
| nGxCeb | 30000/1001 | Preview | 140.1 | 0.990     | 0.936      | 18.6                 | 5.9          | 18.9               | 153.9              |
| hLx1TB | 30/1       | Preview | 142.1 | 0.975     | 0.942      | 18.3                 | 7.2          | 23.1               | 158.7              |
| hLx1TB | 30000/1001 | Preview | 141.6 | 0.983     | 0.932      | 18.3                 | 7.6          | 25.2               | 156.7              |

All four p95 values the script recomputed match the recorded run summaries exactly.

## Reading

- **Distance to the keyframe explains the Final latency almost completely** (r ≈ 0.99). Seeks near a keyframe present in about 40 ms at p95; seeks 4 s or more away take about 300 ms. The fixed cost (intercept about 10 ms) is the same in both modes, so element setup, IPC and presentation are not the problem.
- **The control follows the same law.** Preview on the source media, which has the same 250-frame keyframe interval, shows the same linear dependence (r 0.97–0.99) and stays under 250 ms only because its per-second cost is lower.
- **A secondary, unexplained factor:** Final costs about 37 ms per second of distance, versus about 18.5 ms for Preview. The codec parameters are nearly identical (same profile, level and B-frames; Final has a slightly lower bitrate), so the encoding does not explain the 2×.
  - Background network loading was ruled out: about 15 % of Final seeks happened while the element was still loading (`networkState` 2), and fitting only the idle-network seeks gives the same slope (37.6–38.2 ms/s).
  - The remaining difference is between the single-`<video>` Final path and the composition-layer Preview path. The existing data cannot attribute it further; this is recorded as unexplained, not guessed.
- **A native compositor would not fix the dominant term,** because the delivered file would keep its 8.3 s keyframe interval and any decoder must still decode forward from the keyframe. At most, it could change the secondary per-second cost.
- **A shorter keyframe interval in the export would bound the dominant term.** This is a model extrapolation, not a measurement: with the fitted Final cost, a 2 s interval (keyint 60) would bound worst-case distance near 1.97 s, giving about 10 + 37 × 1.97 ≈ 83 ms. The cost is larger delivered files and a change to exported output, so it requires a user decision.
