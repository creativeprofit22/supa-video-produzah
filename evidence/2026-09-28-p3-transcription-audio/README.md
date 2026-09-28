# P3 · Production transcription and audio — evidence (2026-09-28)

Roadmap phase `6c481cb4-1231-448d-b164-4b7e1f889bbb`. Plan: `.gg/plans/approved/10db4f02-22d4-4e9f-8e4e-93aef30a3b91.md`.
All work is **uncommitted** on `main` at the time of writing.

## What each file shows

| File | Shows |
|---|---|
| `01-runtime-prerequisites.md` | GPU/driver/CUDA inspection, user-authorized provisioning, the lock-vs-upstream model hash discrepancy |
| `smoke.out`, `smoke.err` | CLI smoke run on the GTX 1080 (`Using GPU backend: CUDA0`); not the production-path proof |
| `10-real-gpu-proof.md`, `10-real-gpu-proof.json` | Real NeMo/CUDA transcription through the production job path (WER 0.0, 22/22 timed words) |
| `gpu-before.txt`, `gpu-during.csv` | Independent VRAM/utilization samples during the proof run (628 → 2,430 MiB, util 51 %) |
| `transcript-panel-*.png`, `transcript-license-*.png` | Transcript panel and license dialog at 1280 px and 320 px/200 % text |
| `captions-panel-320px-200-percent-text.png` | Captions style/timing panel reflow |
| `caption-probe-*.png` | Styled `drawtext` probe frames at 16:9, 9:16, 1:1 |
| `audio-panel-320px-200-percent-text.png` | Audio panel with a failed-export loudness report |

## Criteria → evidence

1. **Transcription wired through production commands and durable jobs** — `video_asr_runtime_status`,
   `video_asr_set_runtime` (native folder picker), `video_asr_accept_consent`, `video_start_transcription`,
   `video_transcription_result`; media-state schema v3 adds the `transcription` job kind; `Gpu` scheduler slot
   (1 permit); pinned runtime manifest with license fields; consent bound to the manifest hash; provenance in
   the ASR configuration identity; 2 attempts with auto-retry only for crash/timeout; CUDA-not-proven and runtime
   problems block with `verify_toolchain`. Tests: `transcription_job_*`, `asr_*`, `migrates_v*_to_v3`,
   `transcription_commands_fail_closed_over_mock_ipc`.
2. **Real NeMo/CUDA execution** — `10-real-gpu-proof.md`. JFK fixture only; the spike's long-form, noisy-dialogue
   and determinism benchmarks were not run.
3. **Caption styling/retiming and production audio**
   - Style/retime: `caption-edit.ts` (new validated artifact → one `ApplyCaptionArtifact`), Captions panel.
   - Render: exports previously ignored caption artifacts entirely; both compilers now emit styled cues with an
     explicit `fontfile` from a closed 20-font table, safe-area clamping, TS↔Rust byte-identical golden, and real
     frames measured inside the safe area at three aspect ratios.
   - Sidecars: SRT/VTT/ASS generation with golden tests; FFmpeg parsed the SRT/VTT with exact timings; native write
     only to a dialog-granted path.
   - Audio: optional `audioRole` and `loudnessTarget` (legacy bytes unchanged), set/undo/redo/journal-recovery
     tests; padded-key ducking and dialogue cleanup in both compilers with TS↔Rust golden; two-pass `loudnorm` with
     a mode-reporting linear gate; post-render `ebur128` + `astats` report persisted in the render result; out of
     tolerance fails the export. Real exports via the TS compiler → native worker → bundled FFmpeg met -14/-16/-23
     LUFS within ±1 LU with true peak ≤ -1 dBTP, and ducking pulled music 6.4 dB under speech while it returned
     after the last word.
4. **Reuse** — transcript store, exact-key read, `ApplyCaptionArtifact`, `InsertTrack` and the job scheduler are
   reused; no new caption command type was added.

## Checks run (final pass)

- `pnpm check`: 0 errors. `pnpm test`: contracts 271, render 76, media 44, project 149, desktop 396 passed.
- `pnpm format:check`: clean for source (pre-existing warnings only under `evidence/**`).
- `pnpm lint`: no errors in source files; all reported errors are pre-existing `evidence/**/playwright-report` assets.
- `cargo fmt --check`: clean. `cargo clippy -D warnings`: clean for `desktop-runtime` and `tauri-ipc-test`.
- `cargo test --lib --features tauri-ipc-test --test-threads=4`: 405 passed, 0 failed, 21 ignored.
  At full default parallelism, `durable_command_acknowledgement_p95_meets_budget` failed twice while the new real
  FFmpeg export tests ran concurrently; alone it passes 3/3 at p95 ≈ 12–17 ms (budget 300 ms). This is CPU
  contention, recorded rather than hidden; the budget was not changed.
- Playwright: new specs `TranscriptPanel.spec.ts` (6) and `AudioPanel.spec.ts` (2) pass, covering keyboard, axe
  WCAG 2.2 AA and 320 px/200 % text. Full desktop run: 100 passed, 10 failed, all in `ProgramMonitorSharedParity`
  and `RawMediaParity`. The failing checks are preview frame/transient alignment gates (count varies run to run:
  10, 9, 6) in files this phase did not touch, which is Phase 4's open preview/export sync acceptance.

## Not done / known gaps

- No single continuous native scenario was run in the launched app (transcribe → delete a sentence → preview →
  apply → undo → captions at three ratios → export). Each link is verified separately above.
- Nothing is committed.
- The model hash in the 2026-08-09 lock differs from the upstream LFS hash; see `01-runtime-prerequisites.md`.

## Corpus references used

veedstudio/open-edit (mux-audio.ts, mix-audio.ts, check-delivery.ts), calesthio/OpenMontage (audio_mixer.py),
nickathens/MyOldMachine (audio.py), CapSoftware/Cap (captions-export.ts), tmoroney/auto-subs (manifest.rs),
jub0t/Concat (transcribe.rs), ggml-org/whisper.cpp (cli.cpp), krillinai/OpenCreator (srt_embed.go). Permalinks are in
the approved plan's Sources section.
