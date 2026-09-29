# P3 · Production transcription and audio — evidence (2026-09-28)

Roadmap phase `6c481cb4-1231-448d-b164-4b7e1f889bbb`. Plan: `.gg/plans/approved/10db4f02-22d4-4e9f-8e4e-93aef30a3b91.md`.
The first pass is committed (`ebea401`, `6a219ce`, `ddaa049`, `0876a4b`). The gap-closing pass (speaker labels,
word navigation, cut preview, frame shapes, the step-12/13 proofs and the bugs they exposed) is **uncommitted**
on `main` at the time of writing.

## What each file shows

| File | Shows |
|---|---|
| `01-runtime-prerequisites.md` | GPU/driver/CUDA inspection, user-authorized provisioning, the lock-vs-upstream model hash discrepancy |
| `02-diarizer-provisioning.md` | Sortformer 4-speaker diarizer: user-authorized f32 conversion on E:, CC-BY-4.0 licence, pinned revision, source and output hashes |
| `03-model-hash-reconciliation.md` | Resolves the ASR model hash discrepancy: upstream, both local copies and the enforced manifest agree; the 2026-08-09 lock value is an erratum |
| `smoke.out`, `smoke.err` | CLI smoke run on the GTX 1080 (`Using GPU backend: CUDA0`); not the production-path proof |
| `10-real-gpu-proof.md`, `10-real-gpu-proof.json` | Real NeMo/CUDA transcription through the production job path (JFK, WER 0.0, 22/22 timed words) |
| `gpu-before.txt`, `gpu-during.csv` | Independent VRAM/utilization samples during the step-10 run |
| `12-real-two-speaker-proof.md`, `.json` | Real two-speaker recording (NASA *Houston We Have a Podcast* Ep. 436) through the production path with the diarizer: 2 speakers found, 99.4 % speaker attribution, WER 0.067 against NASA's edited transcript |
| `12-real-two-speaker-scoring.txt`, `12-nasa-reference-turns.json` | Alignment scoring and NASA's speaker-attributed reference transcript |
| `12-vram-production.csv` | VRAM/utilization samples for the step-12 run (peak 7,174 MiB of 8 GiB) |
| `13-continuous-native-scenario.md` | **One continuous scenario in the real launched app**, all 7 steps PASS: import → transcribe with speakers → word seek → cut with preview → undo → captions at 16:9/1:1/9:16 → fades + −16 LUFS → 9:16 export; six product bugs found and fixed |
| `13-*.png` | Screenshots per scenario step, plus a real frame from the 9:16 export with a burned-in caption (`13-07b-export-frame-9x16.png`) |
| `13-scenario-log.json`, `13-vram.csv` | Raw scenario event log; VRAM samples (peak 7,027 MiB) |
| `13-fade-out-ebur128.txt` | `ebur128` momentary loudness over the last second, before vs after the fade-out fix |
| `13-drawtext-escape-probe.py` | Shows the old drawtext apostrophe quoting fails in FFmpeg and the new escaping renders pixel-identical to the raw text |
| `13-continuous-native-scenario.mjs`, `13-owned.mjs`, `13-OwnedLauncher.cpp`, `13-native-dialog.ps1` | The harness that launched and drove the real app (owned processes, WebView2 over CDP, owner-checked native pickers) |
| `14-cut-gap-native-scenario.md` | **Deleting a sentence removes its inner pauses**, rerun in the real app: 11 words now give 2 clips (9 before the fix), and undo restores the identical project state hash |
| `14-*.png`, `14-scenario-log.json`, `14-baseline-*` | Step-14 screenshots and log, plus the same run without the fix (9 clips) |
| `14-cut-gap-native-scenario.mjs` | Step-14 driver (reuses the step-13 launcher and dialog helper) |
| `15-long-file-transcription.md` | **Long files in bounded pieces plus one whole-file speaker pass**: 5 min peaks at 6,149 MB (was 7,165), 50 min at WER 0.071 and 99.51 % speaker attribution (was 85.6 %), 2 h runs flat with a silent stretch kept as a zero-word chunk |
| `15-long-file-probe.mjs`, `15-score.mjs`, `15-sample-gpu.ps1`, `15-summarize-run.mjs` | Pre-plan probe, WER/speaker scorer against NASA's turns, GPU/process sampler, and run summarizer |
| `transcript-panel-*.png`, `transcript-license-*.png` | Transcript panel and license dialog at 1280 px and 320 px/200 % text |
| `captions-panel-320px-200-percent-text.png` | Captions style/timing panel reflow |
| `caption-probe-*.png` | Styled `drawtext` probe frames at 16:9, 9:16, 1:1 |
| `audio-panel-320px-200-percent-text.png` | Audio panel with a failed-export loudness report |

## Criteria → evidence

1. **Transcription wired through production commands and durable jobs.** Commands: `video_asr_runtime_status`,
   `video_asr_set_runtime` (native folder picker), `video_asr_accept_consent` (withdrawable),
   `video_start_transcription` and `video_transcription_result`. Media-state schema v3 adds the `transcription`
   job kind, with a `Gpu` scheduler slot (1 permit). The pinned runtime manifest carries licence fields and now
   the optional diarizer. Consent is bound to the manifest hash, and provenance (including `diarizer_sha256`
   when used) is part of the ASR configuration identity. A job gets 2 attempts, auto-retrying only a crash or
   timeout. Tests: `transcription_job_*`, `asr_*`, `migrates_v*_to_v3`, `rejects_future_schema_without_modifying_it`,
   `transcription_commands_fail_closed_over_mock_ipc`, `speaker_assignment_tests`, `diarize_output_tests`,
   `piece_output_tests`, `piece_tests`, `nemo_runner_*`.
2. **Real NeMo/CUDA execution.** `10-real-gpu-proof.md` (JFK). `12-real-two-speaker-proof.md` (5-minute real
   interview with speakers). `13-continuous-native-scenario.md` (cold transcription inside the running app, 678
   words in 53.3 s).
3. **Speaker labels and word-level navigation.** Diarizer speaker N becomes `speaker_N`, and untagged words
   are counted as missing speakers. The transcript panel groups words under speaker headings and marks them
   "may be wrong". Every word has a keyboard-reachable seek button, and the spoken word is marked
   `aria-current`. Proven in the app in scenario steps 2 and 3.
4. **Caption styling/retiming and production audio.**
   - Style/retime: `caption-edit.ts` (a new validated artifact, applied with one `ApplyCaptionArtifact`),
     Captions panel. Reading speed is now a "Reads fast" review flag rather than a blocker (user decision).
     Frame shape (16:9 / 9:16 / 1:1) is a new undoable `SetSequenceFrameSize` command, and the monitor follows
     the frame.
   - Render: styled cues with an explicit `fontfile`, safe-area clamping, and a TS↔Rust byte-identical golden.
     drawtext text is escaped for all three FFmpeg parsing layers, checked pixel-for-pixel against raw text.
     Long caption graphs go to FFmpeg through a file, which avoids the Windows command-line cap.
   - Sidecars: SRT/VTT/ASS with golden tests; native write only to a dialog-granted path.
   - Audio: roles, padded-key ducking, dialogue cleanup, two-pass `loudnorm` and a post-render
     `ebur128`/`astats` report. The fade-out now ends where a file's audio ends (the audio length is recorded at
     import). The scenario export measured −16.0 LUFS in both the app and an independent `ebur128` run, and the
     fade-out reaches digital silence.
5. **Cut preview and undo.** "Remove selected words" opens a Review cut dialog, and nothing changes until
   Apply. Proven in the app: revision unchanged while previewing, then apply and undo back to one clip with
   678 words. Pauses inside a deleted sentence go with it (`14-cut-gap-native-scenario.md`): the cut leaves
   2 clips, and undo returns the identical project state hash.
6. **Reuse.** Transcript store, exact-key read, `ApplyCaptionArtifact`, `InsertTrack` and the job scheduler are
   reused. No new caption command type was added.

## Checks run (final pass, 2026-09-28)

- `pnpm check`: 0 errors.
- `pnpm lint`: 0 errors. Two pre-existing evidence-script faults were fixed for real (no new ignore rules): the
  P2 synthetic-clock script now imports `Buffer`/`console`/`process` from Node, and the P2 native-performance
  ESLint config's `runs/**` ignore is now written relative to its own folder, so its generated run output is
  skipped as originally intended.
- `pnpm test`: **1,006 passed** (contracts 288, render 84, media 46, project 151, desktop 437), run after
  rebuilding the workspace packages the desktop app imports.
- `pnpm format:check`: clean.
- `cargo fmt --check`: clean. `cargo clippy --locked --all-targets --all-features -- -D warnings` (the CI command): clean, re-run after the
  commits were split. Without `--all-features` it reports 30 dead-code errors in test-only IPC helpers
  (`asr_ipc.rs`, `video/mod.rs`) that this pass did not touch; CI never runs that combination.
- `cargo test --lib --features tauri-ipc-test --test-threads=4`: **431 passed, 0 failed**.
- Focused Playwright, `TranscriptPanel.spec.ts` (cut review dialog, keyboard seek, axe WCAG 2.2 AA, 320 px/200 %
  text): all pass.

## Not done / known gaps

- **Full desktop browser suite does not pass — carried to Phase 4, not counted as passing.** Latest run, after
  the step-18 caption fit (2026-09-29): **104 passed, 14 failed of 118** (112 before plus the 6 new
  `MonitorCaptions` tests, all 6 passing). All 14 failures are in the same four files: SharedParity 9, Audio 2,
  Speed 2, Raw 1. Two of them passed in the previous full run: the 2x audio "running with input" check and the
  Speed 100% clock check (0.086 against a 0.08 limit). Those two were run 3 times each with the fit and 3 times
  with the committed `ProgramMonitor.tsx` and `App.css` restored. Both ways gave 5 failed and 1 passed, so the
  caption change does not cause them. Raw results: `browser-suite-run2-after-fit.json/.log` in
  `E:/nemo-runtime/proof/hwhap-436/scenario/`. Earlier runs: 103/9 after step 16, and 100 passed, 12 failed
  on 2026-09-28 before it. The failures are live-playback timing gates in `ProgramMonitorSharedParity`,
  `ProgramMonitorAudio`, `ProgramMonitorSpeed` and `RawMediaParity`, and the failing set changes between runs.
  On a rerun of just `ProgramMonitorSharedParity` + `RawMediaParity` with the **committed** `ProgramMonitor.tsx`
  restored, the same 14 still failed, so this pass's monitor change does not cause them. These gates were already
  failing before this work (first pass: 100/10; P2: 90/12) and belong to the P2 editor-controls phase's open
  preview/export sync acceptance. By user decision they are recorded here as a carried Phase 4 gap; the plan's
  step-18 browser-suite item is therefore not met in P3.
- **Live-preview caption overlay** (resolved; see "Step 16" below). The preview showed no generated captions; it was
  fixed and then proven in the real app at 16:9, 1:1 and 9:16.
- **Captions at 200% text on top of 200% zoom overflowed the 9:16 preview** (resolved; see "Step 18"). Found in
  step 17, where the first line of a two-line 9:16 caption went above the top of the preview
  (`17-before-fix-monitor-captions-9x16-zoom200-text200.png`). The preview and the burned-in export now both
  shrink caption text until the whole block fits the safe area.
- **GPU memory for long files** (was "VRAM headroom is thin"; resolved by `15-long-file-transcription.md`).
  Long files now run in pieces of at most 240 s plus one separate speaker pass. Peak total GPU memory was
  6,149 MB for 5 min, 6,144 MB for 50 min and 5,892 MB for 2 h, against 7,165 MB before for 5 min. The
  50-minute run missed its 6,000 MB target by 144 MB: two pieces went over, while the desktop's own use moved
  between 1.6 and 2.0 GB. Recorded rather than tuned, by user decision.
- **Progress inside a long transcription** (resolved; see `15-long-file-transcription.md`, "Progress inside one
  transcription"). The job now reports audio preparation, each piece ("n of m items") and the speaker pass,
  without touching a pending cancel. This was proven on a real 5-minute run.
- **Runtime re-check before every piece** (resolved by user decision; see `15-long-file-transcription.md`,
  "Cheaper runtime re-check"). The job now does a full hash at the start and holds the files open, locked
  against writes, renames and deletes on Windows. Before each piece it runs a file-identity check, and before
  the speaker pass a full re-hash. Measured on the real runtime: three full hashes take about 30 s per job,
  and the 30 between-piece checks take 0.13 s in total and read 0 bytes. The non-NeMo overhead on 2 hours
  fell from about 289 s to about 50 s. The job total fell only 16 s (1,180 s to 1,164 s), because the GPU ran
  slower in that run.
- **Accuracy coverage is narrow:** one clean two-speaker studio recording. Overlapping speech, 3–4 speakers and
  noisy rooms were not measured.

## Step 16: captions in the live preview (bug found and fixed)

Step 13 only proved captions in the exported file. Its live-preview record showed an **empty** caption
overlay at all three frame shapes, and its screenshots show no caption. Step 16 reproduced this in the
real app (`16-preview-captions-native-scenario.mjs`, isolated build from `a52d65a`): 78 captions
generated, playhead on a spoken word (frame 4216), preview overlay empty at 16:9, 1:1 and 9:16
(`16-attempt1-*`, `16-attempt2-*`, `16-attempt3-*`). The monitor's live props showed an empty caption list.

**Cause:** generated captions are stored as the caption track's active caption artifact. Export reads
that artifact; the live preview read only the older per-item caption list, which generated captions
leave empty.

**Fix:** the preview's caption lookup now reads both sources, the same way export does
(`apps/desktop/src/video/playback-structure.ts`), with a new unit test that failed before the fix.

**Re-run (real app, after the fix):** `16-scenario-log.json`, `16-03a/b/c-preview-*.png`. The overlay shows
"I did it in school that was pretty close / to the Kennedy Space Center, Florida" at 1280x720, 720x720
and 720x1280, fully inside the frame each time. The 9:16 preview wraps the two lines into four, which is
still readable.

**Rerun after the step-18 caption fit (2026-09-29):** same script, same isolated app with a fresh project, and
the workspace packages rebuilt first. PASS: 78 captions, and the overlay shows the same two lines at frame 4216
at 16:9, 1:1 and 9:16, inside the frame each time. The source hash was unchanged. I checked the fresh
`16-03a/b/c-preview-*.png` myself: the caption is visible and not cut off in all three, and at 9:16 it wraps
to four lines. The overlay box in the log is now taller because it spans the whole safe area; the text still
sits at the bottom. The pre-fit screenshots and log are kept as `16-prefit-*`; the raw run log is
`16-rerun-after-fit-stdout.log` in `E:/nemo-runtime/proof/hwhap-436/scenario/`.

Checks after the fix: `pnpm check`, `pnpm lint`, `pnpm format:check`, `pnpm test` (1,011 tests) all pass. Rust
was unchanged; `cargo fmt`, `cargo clippy -D warnings` and `cargo test` passed on `a52d65a` before the fix.

**Full desktop browser suite rerun after the fix** (`pnpm --filter @supa-video/desktop test:browser`,
2026-09-28, working tree = `a52d65a` + the preview caption fix): **103 passed, 9 failed** of 112. The earlier
recorded run was 100 passed / 12 failed of the same 112. All 9 failures are in the four known files and are the
known kinds of live-playback timing and audio-measurement checks:

- `ProgramMonitorSharedParity` (6): 3 "output-clock aligned transient within one sequence frame" and
  3 "decoded visual frame 42 must be directly observed" (30/1 100% and 200% preview; 30000/1001 150% and
  200% preview and final).
- `ProgramMonitorAudio` (1): "reset effects then Final is actual unity PCM at 1x" (0.327, limit 0.03).
- `ProgramMonitorSpeed` (1): "final playback and wrong-speed pitch-shift measurement controls" (0.273, limit 0.08).
- `RawMediaParity` (1): the raw browser video baseline, which doesn't load the app at all.

No new failing file or failure kind appeared. **Same run without the fix:** I temporarily swapped in the
committed `playback-structure.ts` and ran only those four files. Result: 22 passed, **14 failed**, with the same five
failure kinds (8 aligned-transient, 2 frame-42, 2 Audio, 1 Speed, 1 Raw). The fix was put back afterwards. The
failing count moves between runs whether or not the fix is present, so this is the known variability carried to
Phase 4, not a regression. The fix only changes which captions the preview shows, and none of the four failing test
files sets up caption tracks. The only browser tests that generate captions (`TranscriptPanel.spec.ts`) passed. Raw results stay outside the repo in `E:/nemo-runtime/proof/hwhap-436/scenario/`
(`browser-suite-run1.json/.log`, `browser-suite-baseline-4files.json/.log`).

## Step 17: gate checks added for source safety and 200% zoom

**Source media is never changed by transcription.** Two new Rust tests take the bytes, SHA-256 and
modification time of both the imported original and the app's managed copy, run transcription, and require
all three to be unchanged. They also check the audio-extraction step read the managed copy and wrote only
inside the job's own temporary folder.

- `nemo_runner_long_file_never_changes_the_source_media` uses the long-file path (3 pieces plus the speaker
  pass) and also checks no file was added next to the source.
- `transcription_job_never_changes_the_source_media` goes through the full job service, from submit to
  complete.

Both pass. As a check that they can catch a real problem, I temporarily made the fake FFmpeg append one byte
to its input. Both tests then failed, and the change was reverted.

**Captions at 200% zoom.** `apps/desktop/browser-tests/MonitorCaptions.spec.ts` renders the real program
monitor with a two-line caption at 16:9, 1:1 and 9:16. It uses a 640x400 page at pixel density 2, which is
what a 1280x800 window looks like at 200% browser zoom. Each caption line must be unclipped and fully inside
the preview, and the page must not scroll sideways. All 3 pass (`17-monitor-captions-*-zoom200.png`). Step 18
adds the same check with 200% text on top.

**Loudness and true-peak on real audio.** These tests already existed and pass (`video::tests::audio_mix_export`,
bundled FFmpeg on generated dialogue and music):

- `render_role_mix_ducks_music_and_meets_each_loudness_target` exports at -14, -16 and -23 LUFS. Each measured
  output must be within 1 LU of its target, with a true peak of -1.0 dBTP or lower.
- `render_ducking_music_is_attenuated_while_dialogue_plays` compares the decoded audio with and without ducking.

The test's true-peak limit (-1.0 dBTP) is looser than the -1.5 dBTP the product aims for.

## Step 18: captions shrink to fit the safe area (preview and export)

**Rule, same in both:** a caption keeps its size when it fits. When the whole block is taller than the safe
area, the text shrinks until it fits, and the existing position clamp then keeps it inside. Shrinking was chosen
over clamping alone because the clamp already existed and could not help once the block was taller than the
safe area.

- **Preview** (`apps/desktop/src/video/MonitorCaptionOverlay.tsx`, `App.css`): the caption overlay now spans
  the safe area (7% sides, 8% top and bottom, as before), with the lines at the bottom. After each render or
  resize, it measures the lines and lowers a text-scale factor until they fit. The text re-wraps as it
  shrinks, and the factor never goes below 20% of the normal size.
- **Export** (`packages/video-render/src/caption-render.ts`, `fitCaptionStyleToSafeArea`, applied per cue in
  `artifactRenderCaptions`, which `compile-render-plan` uses): if a cue's worst-case height does not fit the
  safe area, its font size and line spacing are scaled down together (minimum 8 px). The worst case is 1.2 em
  for the first line plus 1.45 em for each extra line, plus the box border. These factors come from measuring
  all 20 caption fonts with the bundled FFmpeg; the tallest, Segoe UI, measured 1.17 em and 1.41 em. Styles
  that fit are passed through unchanged, so existing golden outputs don't change. The Rust side only turns
  the plan into an FFmpeg filter, so it needed no change.

**Preview checks** (`MonitorCaptions.spec.ts`, the "known gap" comment replaced by assertions): 6 of 6 pass, at
16:9, 1:1 and 9:16, each at 200% zoom and at 200% zoom plus 200% text. Each check requires both caption lines
unclipped and inside the safe area, the safe area inside the preview, no sideways page scroll, and text at least
8 px (`17-monitor-captions-*-zoom200.png`, `17-monitor-captions-*-zoom200-text200.png`). With the fit
temporarily disabled, the 9:16 200%-text case failed; the fit was then restored and all 6 passed again.

**Export checks:**

- Unit tests in `caption-render.test.ts`: a caption that fits is returned unchanged. An 8-line, 400 px cue
  shrinks to fit at 16:9, 1:1 and 9:16, keeping its other style fields.
- Real FFmpeg (`18-export-caption-fit.mjs`, results in `18-export-caption-fit.json`, run after building
  `contracts` and `render`): it draws the actual caption filter on a green frame and finds the box by pixel.
  An 8-line cue at the largest style (256 px, 400 px spacing) was drawn in five fonts at all three shapes. Every
  fitted version is inside the safe area; every unfitted one runs off the frame. A normal 2-line 48 px cue is
  unchanged and inside. PNGs: `18-export-*-fitted.png` and `18-export-*-unfitted.png`.

**Reruns after the change:** caption lifecycle tests (split, trim, move, ripple delete): 46/46. Desktop
`playback-structure` plus `ProgramMonitor` unit tests: 61/61. `video-render`: 88/88, including
`compile-render-plan` 71/71.

**Real app rerun after this change:** the step-16 real-app scenario was run again with the fit in place. It
passes at all three shapes, with captions visible and not clipped (see the step-16 rerun note). Desktop unit
tests: 440/440, including `ProgramMonitor` 49/49. For the full browser suite, see the first known-gaps entry.

**Difference that remains:** the preview's safe area is a fixed 7%/8% inset, while export uses the
artifact's own safe-area setting. Both now keep the whole caption inside their own safe area, but a caption
can still shrink a little earlier in one than the other.

## Corpus references used

veedstudio/open-edit (mux-audio.ts, mix-audio.ts, check-delivery.ts), calesthio/OpenMontage (audio_mixer.py),
nickathens/MyOldMachine (audio.py), CapSoftware/Cap (captions-export.ts), tmoroney/auto-subs (manifest.rs),
jub0t/Concat (transcribe.rs), ggml-org/whisper.cpp (cli.cpp), krillinai/OpenCreator (srt_embed.go). Permalinks are in
the approved plan's Sources section.
