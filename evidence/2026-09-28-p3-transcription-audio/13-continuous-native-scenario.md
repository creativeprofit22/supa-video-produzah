# Step 13 · One continuous in-app scenario, real launched app (2026-09-28)

**Result: PASS, all 7 steps, in one app session, including an audible fade-out.** The run used a fresh
app-data folder and a fresh project, and the transcription ran cold on the GPU (no cached result). This is
the 14th attempt. The earlier attempts found **six product bugs, all fixed** (listed below) and several
harness issues. Attempt 13 passed every step but showed the fade-out was inaudible; that was fixed (bug 6)
and the whole scenario was run again from scratch.

- Build: isolated debug app, identifier `com.supavideo.p3-continuous-scenario-20260928`, built with
  `CARGO_TARGET_DIR=E:\nemo-runtime\proof\hwhap-436\scenario\target`. The user's real app data was not touched.
- Driver: `13-continuous-native-scenario.mjs` launched the real app through the owned launcher (`13-owned.mjs`,
  `13-OwnedLauncher.cpp`), connected to WebView2 over CDP, and drove it by accessible roles. Native pickers
  were answered by `13-native-dialog.ps1`, which checks the owner PID and creation token.
- Source: NASA *Houston We Have a Podcast* Ep. 436, interview clip `interview-102-400.mp4` (2 real speakers,
  H.264 1280×720 + AAC). ffprobe reports **video 298.967 s and audio 298.000 s**: the sound ends ~1 s before
  the picture.
- Raw log: `13-scenario-log.json`. Media stays on E: under `E:\nemo-runtime\proof\hwhap-436\scenario\run2\`.
  Attempt 13's export (before the fade fix) is kept for comparison under `run2-attempt13-pass-before-fadefix\`.

## Steps

| # | Step | Result | Time | Observed |
|---|---|---|---|---|
| 1 | Import | PASS | 41.5 s | Source sha256 `050f0b09…0e51` matched **before** the run. Project revision 1, one clip covering frames 0–8970. The saved probe now records the audio length: `"audio": {…, "durationMicroseconds": 298000000}`. `13-01-imported.png` |
| 2 | Transcribe with speakers | PASS | 63.1 s | Licence consent given. The runtime folder `E:\nemo-runtime\runtime` was chosen through the real folder picker. Job `5a71d72c-ed90-4bf5-8060-72e8f0dfa304` ran for 53.3 s. **678 words**, with `h3` headings "Speaker 1" and "Speaker 2" (8 speaker turns). The panel shows "may be wrong". Peak VRAM **7,027 MiB** of 8 GiB (`13-vram.csv`). `13-02a/b/c-*.png` |
| 3 | Word seek | PASS | 0.8 s | Clicked "Seek to close at 2:20.40". The playhead moved from frame 0 to **frame 4212** (4212 / 30 fps = 140.40 s). The word got `aria-current="true"`. `13-03-seek.png` |
| 4 | Cut with preview, then undo | PASS | 6.4 s | Selected the 11 words of "That's fantastic, and you've been charged with quite a big task." The **Review cut** dialog listed the ranges. **Revision stayed 1 while the dialog was open.** Apply cut → revision 2, 9 visible clips, frames 0–8894. Undo → revision 3, **one clip covering frames 0–8970 and 678 words again.** `13-04a/b/c-*.png` |
| 5 | Captions at 3 frame shapes | PASS | 8.1 s | Generated **80 captions** (revision 3 → 4). Frame radio: 16:9 → 1280×720, 1:1 → 720×720 (rev 5), 9:16 → 720×1280 (rev 6, the monitor turns portrait at 315×560). `13-05a/b/c-*.png` |
| 6 | Fades and loudness | PASS | 4.2 s | Clip fade-in and fade-out set to 30 frames (1 s) each (rev 7). Loudness target −16 LUFS (rev 8). `13-06-audio.png` |
| 7 | Export 9:16 | PASS | 83.5 s | Final render job `d14c2a58-e95f-498d-bee7-a58c8f96c7f4` completed (81.1 s). Its plan carries `audioEndMicroseconds: 298000000`, and its filter has `afade=t=out:st=297.000000:d=1.000000` (before the fix: `st=298.0`, after the audio had ended). App report: "Met the loudness target", −16.0 LUFS, true peak −5.7 dBTP. `13-07-export-done.png`, plus a real export frame with a burned-in caption: `13-07b-export-frame-9x16.png` |

## Independent checks on the exported file

`E:\nemo-runtime\proof\hwhap-436\scenario\run2\export.mp4` (14,220,859 bytes):

- **ffprobe:** H.264 **720×1280**, 299.000 s (8970 frames, matching the timeline); AAC 298.005 s.
- **Loudness, independent `ffmpeg -af ebur128=peak=true`:** integrated **−16.0 LUFS**, peak −5.7 dBFS. This
  matches the app's report.
- **Fade-in** (measured on this export, RMS): −29.5 dB (0.00–0.25 s), −22.4 (0.25–0.50), −17.7 (0.50–0.75),
  −18.9 (0.75–1.00), then −15.7 dB (1–2 s), so it ramps up over the first second.
- **Fade-out, `ebur128` momentary loudness (400 ms window ending at t), before vs after the fix**
  (`13-fade-out-ebur128.txt`):

  | t (s) | before fix (LUFS) | fixed (LUFS) |
  |---|---|---|
  | 297.0 | −15.1 | −15.1 |
  | 297.2 | −14.5 | −14.6 |
  | 297.4 | −15.2 | −17.2 |
  | 297.6 | −16.0 | −19.6 |
  | 297.8 | −16.9 | −25.5 |
  | 298.0 | −15.5 | **−28.3** |

  Before the fix, speech stayed at full level (≈ −16 LUFS) up to the moment the audio stopped. After the fix,
  the level falls steadily from 297.0 s to the end. The momentary window is 400 ms wide, so it still includes
  louder speech from before the fade.
- **Fade-out, sample-level RMS per 100 ms** (whole-track decode, identical source and settings, only the fix
  differs):

  | window (s) | before fix (dB) | fixed (dB) |
  |---|---|---|
  | 296.9–297.0 | −12.6 | −12.6 |
  | 297.3–297.4 | −12.6 | −16.4 |
  | 297.6–297.7 | −14.7 | −23.7 |
  | 297.8–297.9 | −15.7 | −32.8 |
  | 297.9–298.0 | −14.1 | **−39.2** |
  | 298.0–298.1 (last 5 ms) | −48.6 | **−110.1** (digital silence) |

  The two exports are identical up to 297.0 s (±0.1 dB). From there the fixed export falls 25 dB by 298.0 s
  and reaches silence. The unfixed one was cut off abruptly at full level.
- **Source unchanged:** sha256 `050f0b0958e2d56638d58e21e99b35d708d91acc81226b90c510c2926a2f0e51` was
  re-hashed after the run and still matches.

## Product bugs this scenario found, all fixed and covered by tests

1. **Transcription failed on real long speech.** The runtime's word times overlap. Covered in step 12
   (`repair_word_overlap`).
2. **Choosing the runtime folder hung for more than 8 minutes in debug builds.** Integrity hashing of the
   ~1.2 GB runtime ran in unoptimized `sha2`. `Cargo.toml` now optimizes `sha2` on the dev profile, which
   the test profile inherits, and verification takes ~4 s.
3. **"Generate captions" failed on fast speech.** The 20 characters-per-second reading speed was a hard rule;
   14 of 80 captions of this interview can't meet it however they are split. **User decision:** captions are
   always generated, fast ones are flagged "Reads fast" for review, and a word longer than the maximum cue
   length still fails. The shared TS check (`packages/video-contracts`), the native validator (`caption.rs`)
   and generation/re-placement (`cueEndWithinLimits`) were changed together, and the one-frame overlap
   between touching words is absorbed (`speechEndBeforeNextCue`).
4. **Applying captions broke the project view.** The native side saved `active_caption_artifact`, but the
   contract reads `activeCaptionArtifact`, so the whole projection was rejected ("invalid response"). The
   field is renamed, with a snake_case alias so older projects still load. Regression test:
   `applied_caption_artifact_serializes_under_the_contract_field_name`.
5. **Export failed on any caption containing an apostrophe** ("it's"). drawtext text was quoted as `'it\'s'`,
   which FFmpeg rejects. It is now escaped for all three FFmpeg parsing layers. A native test renders
   escaped text and checks the pixels match the raw text drawn from a file (`13-drawtext-escape-probe.py`
   shows the old form fails and the new one matches). TS and Rust stay byte-identical (shared golden).
   Separately, this interview's caption graph was 32,358 characters, right at Windows' 32,767 command-line
   cap. The graph is now passed as `-/filter_complex <file>` (FFmpeg ≥ 5.1; bundled 8.1.2) in a private
   temp directory that is deleted after FFmpeg exits. Tested with a 40,000-character graph through the
   bundled FFmpeg.
6. **The fade-out was inaudible when a file's audio is shorter than its video.** The fade was timed to the
   clip's video length (`st=298.0`) and started after the audio had already ended. Fix:
   - Import now records the audio stream's own ffprobe duration as `probe.audio.durationMicroseconds`. It is
     optional: projects saved before the fix load unchanged and re-save without the field, and a missing or
     unparsable stream duration is simply not recorded.
   - When a clip fades out and its audio ends before the clip does, the export plan carries
     `audioEndMicroseconds` (clip-relative, after source offset and speed). The fade then ends there and is
     shortened only if the audio is shorter than the fade itself.
   - The TS compiler (`compile-render-plan.ts`), the TS plan validator (`render-plan.ts`) and the native
     validator (`render.rs`) derive the identical `afade` text. Every other case (no recorded duration,
     audio as long as or longer than the clip) keeps the previous video-length fade.
   - Tests: TS `audio shorter than the video` (7 cases: audio ends 1 s early, audio shorter than the fade,
     source offset and 2× speed, three fallback cases, no fade-out). Rust
     `render_fade_out_ends_where_shorter_audio_ends` (a 2 s clip whose audio ends at 1 s, the old timing
     rejected, bounds and consistency) and
     `probe_records_the_audio_stream_duration_and_old_probes_still_load` (298 s audio in a 299 s file, old
     probe round-trip, `null` rejected, missing duration tolerated).

## Checks after the fix

| Check | Result |
|---|---|
| `pnpm check` | exit 0 (all 5 workspace packages) |
| `pnpm test` | exit 0: 288 + 84 + 46 + 149 + 437 = 1,004 tests passed |
| `pnpm format:check` | all files formatted |
| `cargo fmt --check` | clean |
| `cargo clippy --all-targets --features tauri-ipc-test -- -D warnings`, and without features | clean |
| `cargo test --lib --features tauri-ipc-test` | 431 passed, 0 failed, 21 ignored (the ignored tests are the real-GPU/opt-in suites) |
| ESLint | only fails on `evidence/2026-09-16-p2-editor-controls-completion/synthetic-clock-representation.mjs`, a committed P2 evidence script this phase did not touch |

## Open findings (not fixed, stated plainly)

- **A sentence cut leaves the gaps between words behind.** Removing 11 words produced several cuts and left
  1–4 frame slivers of the pauses between them (9 clips). This is correct per the word-level mapping, but a
  user probably expects the whole sentence span removed. **Kept as-is by instruction**; this is a design
  choice to settle, not a crash.
- **Monitor caption overlay not verified.** The scenario's overlay probe found no caption text in the
  preview at the checked playhead. The export frame proves captions render, but the live preview overlay
  was not independently verified.
- **VRAM headroom is thin:** peak 7.0 GiB of 8 GiB for a 5-minute source. The separate-`diarize`-pass
  fallback is not implemented.
