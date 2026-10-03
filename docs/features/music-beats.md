# Music beats

Supa Video finds **music beats** (the pulse of a music track) so that cuts and graphics keyframes can snap to them, and so QC can report how the edit sits on the music. Music beats are not **narrative beats**, which are the story units of a first-cut plan. The two never share names or types (see `CONTEXT.md`).

## Detecting music beats

In **Audio → Music beats**, every asset on a track marked **Music** has a **Detect music beats** button. Detection is a cancellable media job (`music_beat_detection`) and shows up in the job center.

1. ffmpeg decodes the first audio stream to 22.05 kHz mono 16-bit WAV. Audio past one hour is not analysed.
2. The detector runs:
   - **Beat This!**, when the music beat runtime is ready (see below). It runs `File2Beats(checkpoint_path=<local final0.ckpt>, dbn=False)` and uses CUDA when it is available.
   - Otherwise the **in-app tempo fallback**, written in Rust. It computes a spectral-flux onset envelope, estimates tempo by autocorrelation over 60–200 BPM with a prior centred on 120 BPM, and tracks music beats with Ellis-style dynamic programming. It handles percussive music well and non-percussive music poorly.
3. Onsets always come from the in-app envelope.
4. The result is stored as derived media: artifact kind `music_beats`, format `music-beats-v1`. It is keyed by the source content digest plus detector kind, version and checkpoint digest. Running detection again on the same file with the same detector reuses the stored analysis.

```json
{
  "schemaVersion": 1,
  "detector": { "kind": "beat_this", "version": "1.1.0", "checkpointSha256": "8c32…" },
  "durationUs": 184000000,
  "tempoBpm": 120.0,
  "beatsUs": [500000, 1000000],
  "downbeatsUs": [500000],
  "onsetsUs": [498000, 1001000]
}
```

All times are integer source-time microseconds, strictly increasing and capped (20 000 music beats and downbeats, 60 000 onsets). The analysis is validated both in Rust (`music_beats.rs`, `deny_unknown_fields`) and in TypeScript (`musicBeatAnalysisV1Schema` in `@supa-video/media`).

## Music beat runtime (Beat This!)

Python is not bundled with the app. The runtime is a folder you choose, and it must contain:

- `.venv/Scripts/python.exe` (`.venv/bin/python` outside Windows), with `beat-this` installed;
- `final0.ckpt`, the official Beat This! checkpoint.

`apps/desktop/src-tauri/src/video/music-beat-runtime-manifest.json` pins these values:

| Item               | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Package            | `beat-this` 1.1.0 (CPJKU/beat_this @ `b95c8ab0`)                   |
| Checkpoint         | `final0.ckpt`, 81 058 141 bytes                                    |
| Checkpoint SHA-256 | `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331` |
| Licence            | MIT (repository LICENSE); no separate checkpoint licence is stated |

Before each run the app checks the checkpoint's size and hash and probes `python -I -c` for the `beat-this` version. The runner script is embedded in the app and written content-addressed into the app cache. It always receives the local checkpoint path, so Beat This! never downloads anything. If the runtime is missing or does not match the manifest, detection uses the tempo fallback, and the analysis and QC messages say so.

To build the folder (this downloads PyTorch, about 2.5 GB, and the 81 MB checkpoint, and needs `uv`):

```powershell
scripts/setup-music-beat-runtime.ps1 -RuntimeFolder D:\supa-music-beats
scripts/setup-music-beat-runtime.ps1 -RuntimeFolder D:\supa-music-beats -VerifyOnly
```

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

- **Rust (`cargo test`):**
  - fallback tempo within ±1 BPM and music beats within 20 ms on synthesized 100/120/128 BPM clicks;
  - analysis validation;
  - runtime status (ready, missing, hash mismatch, probe failure);
  - job complete, cancel, fallback and malformed runner output;
  - media-state v1/v2/v3 → v4 migration;
  - pacing QC kinds mirrored with golden finding ids.
- **End-to-end, ignored by default:** `cargo test --lib music_beat_ffmpeg_click_track_end_to_end -- --ignored` makes a 120 BPM click track with ffmpeg `aevalsrc`, then detects, publishes and reloads it.
- **Real Beat This! proof:** set `SUPA_VIDEO_REAL_BEAT_THIS_PROOF=1` and a configured runtime. It needs PyTorch and the checkpoint.
- **TypeScript (`pnpm test`):** schemas, the timeline mapping, move snap, graphics keyframe snap and undo, hook detection, AudioPanel, and `pacing.test.ts` on a known 120 BPM fixture.
