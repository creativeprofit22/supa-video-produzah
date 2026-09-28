# Step 10 · Real NeMo/CUDA transcription through the production job path (2026-09-28)

**Result: PASS.** The user asked for this to run without manual clicks, so the test drives the same functions the
Tauri commands call, in order. The only step skipped is the webview button press.

Test: `video::transcription_job::gpu_proof::real_nemo_cuda_transcription_through_production_job_path`
(it is `#[ignore]` and runs only when explicitly enabled). Exact command, run from `apps/desktop/src-tauri`:

```
SUPA_VIDEO_REAL_ASR_PROOF=1 \
SUPA_VIDEO_REAL_ASR_RUNTIME='E:\nemo-runtime\runtime' \
SUPA_VIDEO_REAL_ASR_SOURCE='E:\nemo-runtime\proof\jfk-source.mp4' \
SUPA_VIDEO_REAL_ASR_FFMPEG_DIR='<WinGet Gyan.FFmpeg 8.1.2 bin>' \
SUPA_VIDEO_REAL_ASR_EVIDENCE='<this folder>\10-real-gpu-proof.json' \
cargo test --lib -- --ignored --exact \
  video::transcription_job::gpu_proof::real_nemo_cuda_transcription_through_production_job_path --nocapture
```

Output: `test result: ok. 1 passed; 0 failed ... finished in 35.84s`.

## What ran for real

1. With no consent record, starting a transcription failed closed (`require_ready_runtime` returned an error).
2. Consent was recorded, bound to manifest sha256 `6bef2d7d…0d90`.
3. The runtime folder `E:\nemo-runtime\runtime` was verified against the pinned manifest: 10 files, sizes
   and SHA-256 all matched, taking 11.3 s (about 1.4 GB hashed).
4. The source was granted, ingested and probed. The source is an H.264/AAC MP4 made from NVIDIA's `jfk.wav`
   test file and is 12.8 s long.
5. A durable `transcription` job ran on the `Gpu` scheduler slot and completed on its first attempt
   (attempt 1 of 2).
6. FFmpeg 8.1.2 extracted 16 kHz mono PCM, then NeMo-Speech.cpp `5be7bfb` ran with `--device cuda:0`.
   The runner rejects any run whose stderr lacks `Using GPU backend: CUDA0`, so a completed job means that
   check passed.
7. The artifact was published to the managed cache and read back through the owner-scoped result lookup
   and the exact-key transcript read.
8. A second start with the same source and configuration came back `complete` immediately (5.7 s,
   most of it re-verifying the runtime) with the same transcript key. The artifact identity deduplicates
   the work.

## Measurements

| Metric | Value | Threshold (spike `thresholds.json`) |
|---|---|---|
| Transcript | "And so my fellow Americans ask not what your country can do for you. Ask what you can do for your country." | — |
| JFK word error rate | **0.0** | ≤ 0.15 |
| Words with positive timing | 22 / 22 | coverage ≥ 0.99 |
| Job wall clock (ingest → complete) | 18.7 s | — |
| GPU | GeForce GTX 1080, driver 561.17 | — |
| VRAM during run (`gpu-during.csv`, 0.5 s samples) | 628 → **2,430 MiB** peak, util peak 51 % | increase ≥ 128 MiB |

Provenance recorded inside the transcript artifact identity: engine `5be7bfb104802131e61fe679b3f1401b27270216`,
model `nvidia/nemotron-3.5-asr-streaming-0.6b@1c8deaecc64b91f034d73e08dd8b64625eb3395d`, gguf sha256
`a5c435f2…29ae`, runtime sha256 `4b1434ee…2bf0`, manifest sha256 `6bef2d7d…0d90`, device `cuda:0`.

## Not covered by this run (stated, not implied)

- Only the JFK smoke fixture ran. The spike's long-form, "ugly dialogue", determinism and timestamp-boundary
  benchmarks did not run. The phase requires real GPU execution, not the full benchmark suite.
- The webview button click was not exercised in a launched app. The panel's UI flow is covered separately by
  Playwright against a fake backend (`TranscriptPanel.spec.ts`).
