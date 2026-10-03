# Music beat detection: Python Beat This! vs Rust sidecar

Measurements for the switch from the Python Beat This! runner to the `supa-beat-detect` Rust
sidecar (see `docs/adr/0004-music-beat-detection-sidecar.md`). All runs on the development
machine: NVIDIA GeForce GTX 1080 (compute capability 6.1), driver 561.17, Windows.

## 1. GPU feasibility (2026-10-03)

Setup: ONNX Runtime 1.28.0 `win-x64-gpu_cuda12` (commit `da9b5e36`), CUDA 12.8 redist
(`cudart` 12.8.90, `cuBLAS`/`cuBLASLt` 12.8.4.1), loaded by full path from a scratch folder.
Models: `mel_spectrogram.onnx` (beat-this-rs @ `1ae768e7`) and the FP32 `beat_this.onnx`
(final0, `model-large` release, SHA-256 `5f810deb…0f02`). Input: 180 s deterministic
synthetic click track, 22.05 kHz mono.

| Configuration          | Result                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CUDA, no cuDNN         | Sessions build, but the first run fails: `BatchNormalization` (`/model/frontend/stem/bn1d`) is placed on CUDA and needs cuDNN. **cuDNN 9 is required.** |
| CUDA + cuDNN 9.10.2.21 | Runs. Mel model: 17 nodes on CUDA, 3 on CPU. Beat model: 1239 nodes on CUDA, 510 on CPU (shape/index ops ORT deliberately keeps on CPU).                |

Timing (CUDA + cuDNN 9.10.2, 180 s input):

| Stage        | Rust CUDA (run 1) | Rust CUDA (run 2) | Rust CPU (rten) |
| ------------ | ----------------- | ----------------- | --------------- |
| Session load | 4.35 s            | —                 | —               |
| Mel          | 673 ms            | 524 ms            | 225 ms          |
| Beat model   | 1722 ms           | 1450 ms           | 16 356 ms       |
| Total        | 2.40 s            | 1.97 s            | 18.25 s         |

CUDA and CPU produced identical beat and downbeat lists (361 / 299); the largest beat-logit
difference was 2.2e-5. Loading the GPU pack libraries took 18 s on a cold file cache (about
1.8 GB of DLLs) and 71 ms when cached.

## 2. Parity with Python Beat This! (2026-10-03)

Reference: `beat_this_reference.py` (beat-this 1.1.0 @ `b95c8ab0`, torch 2.7.1+cu126, final0
checkpoint SHA-256 `8c328b45…8331`, `File2Beats(dbn=False)`, CUDA). Candidate: `supa-beat-detect`
with `--device cuda` (GPU pack above) and `--device cpu` (rten). Every input was converted with the
app's ffmpeg arguments (first audio stream, mono, 22.05 kHz, 16-bit PCM), so both sides read the
same samples. Metrics: mir_eval-style F-measure at ±70 ms, share of matched times within 1 ms,
largest matched deviation.

Command (from `apps/desktop/src-tauri/beat-detector`, with `SUPA_VIDEO_BEAT_RUNTIME_DIR`,
`SUPA_VIDEO_BEAT_REFERENCE_PYTHON`, `SUPA_VIDEO_BEAT_REFERENCE_CHECKPOINT` and
`SUPA_VIDEO_BEAT_PARITY_DIR` set): `cargo test --release --test parity -- --ignored --nocapture --test-threads=1`.
Result: 3 passed (293.6 s).

**Committed fixture** (`tests/fixtures/tempo-changes.wav`: 100 → 128 BPM in 4/4, then 90 BPM in 3/4):

| Comparison                             | Beats     | Beat F | Beats ≤ 1 ms | Beat max dev | Downbeats | Downbeat F | Downbeats ≤ 1 ms | Downbeat max dev |
| -------------------------------------- | --------- | ------ | ------------ | ------------ | --------- | ---------- | ---------------- | ---------------- |
| Committed golden vs live Python CUDA   | 139 / 139 | 1.0    | 100 %        | 0 ms         | 100 / 100 | 1.0        | 100 %            | 0 ms             |
| Python vs Rust CUDA                    | 139 / 139 | 1.0    | 100 %        | 0 ms         | 100 / 100 | 1.0        | 100 %            | 0 ms             |
| Python vs Rust CPU (normal test suite) | 139 / 139 | 1.0    | 100 %        | 0 ms         | 100 / 100 | 1.0        | 100 %            | 0 ms             |
| Rust CPU vs Rust CUDA                  | 139 / 139 | 1.0    | 100 %        | 0 ms         | 100 / 100 | 1.0        | 100 %            | 0 ms             |

**Real music** (10 local tracks, 64–234 s: pop, electronic, hip-hop, slowed, lo-fi, an isolated
drum stem; no audio is committed). For every track all three comparisons — Python CUDA vs Rust
CUDA, Python CUDA vs Rust CPU, Rust CPU vs Rust CUDA — produced identical lists:

| Track                                         | Beats | Downbeats | F (beats / downbeats) | Max deviation |
| --------------------------------------------- | ----- | --------- | --------------------- | ------------- |
| 10 (1)-drums.wav                              | 2     | 2         | 1.0 / 1.0             | 0 ms          |
| BLT - Kellin.wav                              | 367   | 91        | 1.0 / 1.0             | 0 ms          |
| Blinding Lights - MythicMicDrops Reworked.wav | 320   | 110       | 1.0 / 1.0             | 0 ms          |
| Limbo Slice - Self Destruction                | 324   | 96        | 1.0 / 1.0             | 0 ms          |
| Miyagi & Andy Panda - Minor                   | 289   | 73        | 1.0 / 1.0             | 0 ms          |
| RAIZHELL - PULL THE TRIGGER                   | 276   | 70        | 1.0 / 1.0             | 0 ms          |
| REVENGE (Super Slowed)                        | 234   | 60        | 1.0 / 1.0             | 0 ms          |
| Song-from-1512026-v1                          | 278   | 71        | 1.0 / 1.0             | 0 ms          |
| Soul Melancholy (lo-fi)                       | 295   | 76        | 1.0 / 1.0             | 0 ms          |
| Waimea - Kellin.wav                           | 327   | 98        | 1.0 / 1.0             | 0 ms          |

Every pass criterion holds (equal counts, F = 1.0, ≥ 99.5 % within 1 ms, max deviation ≤ 20 ms);
the observed deviation is exactly zero because both pipelines put peaks on the same 20 ms frame
grid and the sidecar reports the same `frame / 50` values as Python.

<!-- benchmark:start -->

## 3. Speed (2026-10-03)

Generated by `node scripts/benchmark-beat-detect.mjs`. Source looped to each length: `E:/DevCaches/beat-parity-music/BLT - Kellin.wav`.
Wall time is the whole process (start-up, model load, WAV read, analysis); the bracketed figure is
the analysis alone (Python: `File2Beats` construction + call; Rust: mel + model inference).

| Input  | Beats / downbeats | Python reference (CUDA) | Rust CUDA         | Rust CPU            | Same result |
| ------ | ----------------- | ----------------------- | ----------------- | ------------------- | ----------- |
| 3 min  | 344 / 85          | 9.70 s (2.25 s)         | 5.48 s (2.25 s)   | 17.49 s (17.30 s)   | yes         |
| 10 min | 1131 / 289        | 11.04 s (3.80 s)        | 8.99 s (6.33 s)   | 47.32 s (47.02 s)   | yes         |
| 60 min | 6700 / 1711       | 25.72 s (17.47 s)       | 45.09 s (41.01 s) | 307.86 s (306.22 s) | yes         |

<!-- benchmark:end -->

### Reading the speed results

- All three engines returned identical beats and downbeats at every length (the gate for removing
  the Python runtime).
- Rust CUDA is 3–7× faster than Rust CPU, and faster than the Python reference end to end for
  typical track lengths (3 and 10 minutes), because there is no Python/PyTorch start-up.
- The model itself runs about 2.3× slower per 30 s chunk on ONNX Runtime CUDA than on PyTorch CUDA
  on this GTX 1080 (≈ 0.31 s vs ≈ 0.13 s), so for an hour-long input the Python reference is
  faster (25.7 s vs 45.1 s). The likely cause is that PyTorch's attention and rotary-embedding
  kernels are fused, while the exported ONNX graph runs them as many small nodes, some kept on the
  CPU (510 of 1749). This was anticipated in the plan; `auto` stays correct either way, and
  tuning ONNX Runtime for this graph is possible later without affecting results (the parity
  tests guard it).
