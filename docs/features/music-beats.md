# Music beats

Supa Video finds **music beats** (the pulse of a music track) so that cuts and graphics keyframes can snap to them, and so QC can report how the edit sits on the music. Music beats are not **narrative beats**, which are the story units of a first-cut plan. The two never share names or types (see `CONTEXT.md`).

## Detecting music beats

In **Audio → Music beats**, every asset on a track marked **Music** has a **Detect music beats** button. Detection is a cancellable media job (`music_beat_detection`) and shows up in the job center.

1. ffmpeg decodes the first audio stream to 22.05 kHz mono 16-bit WAV. Audio past one hour is not analysed.
2. The detector runs:
   - **Beat This!**, when the music beat runtime is ready (see below). The bundled `supa-beat-detect` sidecar runs the final0 model as ONNX: on the GPU through CUDA when the runtime has a working GPU pack, otherwise on the CPU. Results are identical on both (see `docs/benchmarks/beat-detect.md`), and match Python Beat This! `File2Beats(final0, dbn=False)`.
   - Otherwise the **in-app tempo fallback**, written in Rust. It computes a spectral-flux onset envelope, estimates tempo by autocorrelation over 60–200 BPM with a prior centred on 120 BPM, and tracks music beats with Ellis-style dynamic programming. It handles percussive music well and non-percussive music poorly.
3. Onsets always come from the in-app envelope.
4. The result is stored as derived media: artifact kind `music_beats`, format `music-beats-v1`. It is keyed by the source content digest plus detector kind, version and checkpoint digest. Running detection again on the same file with the same detector reuses the stored analysis. For Beat This! the version is `rs-1.1.0` and the checkpoint digest is the SHA-256 of `beat_this.onnx`, so analyses from the earlier Python runner (`1.1.0`) are detected again once. The device is not part of the key.

```json
{
  "schemaVersion": 1,
  "detector": { "kind": "beat_this", "version": "rs-1.1.0", "checkpointSha256": "5f81…" },
  "durationUs": 184000000,
  "tempoBpm": 120.0,
  "beatsUs": [500000, 1000000],
  "downbeatsUs": [500000],
  "onsetsUs": [498000, 1001000]
}
```

All times are integer source-time microseconds, strictly increasing and capped (20 000 music beats and downbeats, 60 000 onsets). The analysis is validated both in Rust (`music_beats.rs`, `deny_unknown_fields`) and in TypeScript (`musicBeatAnalysisV1Schema` in `@supa-video/media`).

## Music beat runtime (Beat This!)

The app bundles the detector program (`beat-detector/supa-beat-detect.exe`, ADR 0004) but not the models or GPU libraries. The runtime is a folder you choose:

- `models/mel_spectrogram.onnx` and `models/beat_this.onnx` — required;
- `cuda/` — the optional GPU pack: ONNX Runtime 1.28.0 (CUDA 12 build), the CUDA 12.8 runtime, cuBLAS and cuDNN 9.10.2 libraries (about 1.8 GB). Without it, detection runs on the CPU.

`apps/desktop/src-tauri/src/video/beat-detect-runtime-manifest.json` (schema 2) pins every file by SHA-256 and size, with its source URL and licence:

| Item       | Value                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------- |
| Pipeline   | `beat-this` crate 1.1.0 (danigb/beat-this-rs @ `1ae768e7`), detector version `rs-1.1.0`       |
| Beat model | `beat_this.onnx` (final0 exported to ONNX, FP32), 83 162 650 bytes, SHA-256 `5f810deb…0f02`   |
| Mel model  | `mel_spectrogram.onnx`, 270 742 bytes                                                         |
| Reference  | Python Beat This! 1.1.0 (CPJKU/beat_this @ `b95c8ab0`), `final0.ckpt` SHA-256 `8c328b45…8331` |
| Licence    | MIT (Beat This! and beat-this-rs); NVIDIA libraries under the CUDA and cuDNN EULAs            |

When you choose the folder, the app hashes every file and asks the detector to load the models once (`probe`). **Audio → Music beats** then says whether Beat This! will run on the GPU or the CPU, and why it is on the CPU (no GPU pack, a GPU pack that does not match, or a GPU that could not be started). Before each run the app re-hashes the models. It also checks that the GPU pack files keep the size and modification time they had at verification; if they changed, that run uses the CPU. If the CUDA run fails, the job retries on the CPU. If the models are missing or do not match, detection uses the tempo fallback, and the analysis and QC messages say so.

To build the folder (the GPU pack downloads about 1.7 GB of archives once):

```powershell
scripts/bootstrap-beat-runtime-windows.ps1 -RuntimeFolder D:\supa-music-beats
scripts/bootstrap-beat-runtime-windows.ps1 -RuntimeFolder D:\supa-music-beats -SkipGpuPack   # CPU only
scripts/bootstrap-beat-runtime-windows.ps1 -RuntimeFolder D:\supa-music-beats -VerifyOnly
```

Build the detector with `scripts/build-beat-detector-windows.ps1`; the Windows media-tools bundle includes it.

## Snapping

Only clips on **unmuted** audio tracks whose role is **Music** contribute music beats to the timeline. `musicBeatTimelineFrames` and `musicBeatTimelineTargets` in `@supa-video/contracts` handle `sourceIn`/`sourceOut` trims and clip speed, and drop music beats outside the trimmed range.

- **Timeline moves:** music beats become `"music-beat"` snap targets next to clip edges and the playhead. A music clip never snaps to its own music beats. A drag still commits one `MoveClip`, so one undo reverts it.
- **Graphics keyframes:** `snapGraphicsClipToMusicBeats` moves each keyframe to the nearest music beat within one frame (at least 40 ms) and inside the clip. Keys never reorder or merge; if snapping would make two keys collide, the key stays where it is. The whole snap is one `SetGraphicsClipLayers` command, so one undo restores every keyframe.

## Pacing QC (`editorial-v3`)

Shots are the intervals between frame 0, every cut of visible video, and the picture end. Every pacing finding is `info`, so none of them changes pass/warn status.

| Kind                       | When                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shot_length_out_of_range` | A shot is shorter than 1 s or longer than 7 s (with half a frame of tolerance).                                                                                                                                           |
| `steady_shot_run`          | Four or more consecutive shots are the same length within ±1 frame.                                                                                                                                                       |
| `cut_off_music_beat`       | Music beats exist and a cut is more than one frame (at least 40 ms) from the nearest music beat.                                                                                                                          |
| `music_fit`                | Music beats exist. One summary reports the on-beat cut fraction (hits/total, percent, tolerance) and the median shot length ÷ median music beat period, snapped to the nearest musical ratio from 1/4 to 4 in log2 space. |

These rules are ported from diffusion-studio-2 `checker/music-fit.ts` (`cutsOnBeat`, `beatPacing`) and `checker/rules/timing-rules.ts` (`SHOT_MIN_S`, `SHOT_MAX_S`, `TICK_RUN`).

## Tests

- **Detector (`cargo test --locked` in `apps/desktop/src-tauri/beat-detector`):** WAV parsing, CLI contract and exit codes, device policy (forced CUDA failure falls back to the CPU), the F-measure helper, and parity with Python on the committed fixture on the CPU (goldens are committed, so no Python is needed). The models come from `.cache/beat-runtime` or `SUPA_VIDEO_BEAT_RUNTIME_DIR`.
- **Parity with Python, ignored by default:** `cargo test --release --test parity -- --ignored` needs `SUPA_VIDEO_BEAT_REFERENCE_PYTHON` (from `uv sync --project apps/desktop/src-tauri/beat-detector/reference`) and `SUPA_VIDEO_BEAT_REFERENCE_CHECKPOINT` (a local `final0.ckpt`); for real music also `SUPA_VIDEO_BEAT_PARITY_DIR`. A missing variable fails the test. The reference script `beat-detector/reference/beat_this_reference.py` is test-only and refuses to run unless the beat-this version, commit and checkpoint match the pins.
- **Benchmark:** `node scripts/benchmark-beat-detect.mjs` times Python, Rust CUDA and Rust CPU on 3/10/60-minute inputs and updates `docs/benchmarks/beat-detect.md`; without the reference variables it prints `SKIPPED:` and exits 77.
- **App (`cargo test`):**
  - fallback tempo within ±1 BPM and music beats within 20 ms on synthesized 100/120/128 BPM clicks;
  - analysis validation;
  - runtime status (ready on CUDA or CPU with each reason, missing or changed models, missing detector, probe failure);
  - job complete, cancel (kills the sidecar), fallback, changed models, changed GPU pack, CUDA crash retried on the CPU, and malformed sidecar output;
  - media-state v1/v2/v3 → v4 migration;
  - pacing QC kinds mirrored with golden finding ids.
- **End-to-end, ignored by default:** `cargo test --lib music_beat_ffmpeg_click_track_end_to_end -- --ignored` makes a 120 BPM click track with ffmpeg `aevalsrc`, then detects, publishes and reloads it.
- **Real detector proof:** set `SUPA_VIDEO_REAL_BEAT_DETECT_PROOF=1` and `SUPA_VIDEO_MUSIC_BEAT_RUNTIME=<folder>`, build the sidecar, and run `cargo test --lib music_beat_real_beat_detect -- --ignored`. With a GPU pack it must run on CUDA.
- **TypeScript (`pnpm test`):** schemas, the timeline mapping, move snap, graphics keyframe snap and undo, hook detection, AudioPanel, and `pacing.test.ts` on a known 120 BPM fixture.
