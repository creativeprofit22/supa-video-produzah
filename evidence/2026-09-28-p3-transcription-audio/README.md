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

- **Full desktop browser suite does not pass — carried to Phase 4, not counted as passing.** 100 passed, 12 failed
  on 2026-09-28. The failures are live-playback timing gates in `ProgramMonitorSharedParity`,
  `ProgramMonitorAudio`, `ProgramMonitorSpeed` and `RawMediaParity`, and the failing set changes between runs.
  On a rerun of just `ProgramMonitorSharedParity` + `RawMediaParity` with the **committed** `ProgramMonitor.tsx`
  restored, the same 14 still failed, so this pass's monitor change does not cause them. These gates were already
  failing before this work (first pass: 100/10; P2: 90/12) and belong to the P2 editor-controls phase's open
  preview/export sync acceptance. By user decision they are recorded here as a carried Phase 4 gap; the plan's
  step-18 browser-suite item is therefore not met in P3.
- **Live-preview caption overlay not independently verified.** Captions are proven in the exported video only.
- **GPU memory for long files** (was "VRAM headroom is thin"; resolved by `15-long-file-transcription.md`).
  Long files now run in pieces of at most 240 s plus one separate speaker pass. Peak total GPU memory was
  6,149 MB for 5 min, 6,144 MB for 50 min and 5,892 MB for 2 h, against 7,165 MB before for 5 min. The
  50-minute run missed its 6,000 MB target by 144 MB: two pieces went over, while the desktop's own use moved
  between 1.6 and 2.0 GB. Recorded rather than tuned, by user decision.
- **No progress inside a long transcription:** the job shows one stage, and a 2-hour file takes about
  20 minutes.
- **Accuracy coverage is narrow:** one clean two-speaker studio recording. Overlapping speech, 3–4 speakers and
  noisy rooms were not measured.

## Corpus references used

veedstudio/open-edit (mux-audio.ts, mix-audio.ts, check-delivery.ts), calesthio/OpenMontage (audio_mixer.py),
nickathens/MyOldMachine (audio.py), CapSoftware/Cap (captions-export.ts), tmoroney/auto-subs (manifest.rs),
jub0t/Concat (transcribe.rs), ggml-org/whisper.cpp (cli.cpp), krillinai/OpenCreator (srt_embed.go). Permalinks are in
the approved plan's Sources section.
