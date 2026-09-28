# 15 — Long-file transcription: bounded pieces + one separate speaker pass

Plan: `.gg/plans/approved/2dd7810a-3ac1-41f1-a15e-c6ae6006ad3e.md`. RTX 8 GB, pinned runtime `E:\nemo-runtime\runtime`.
All GPU numbers are **total** device memory, including the desktop's own use (1.6–1.7 GB idle here).
Raw output for every run is on `E:\nemo-runtime\proof\long-files\` (`step1\`, `prod\`).

## Result

Long files are now transcribed in pieces of at most 240 s, cut in the quietest 250 ms inside the last 20 % before
each limit. Each piece runs in the runtime's full-quality mode without the speaker model. Speakers then come from
one streaming speaker pass over the whole file, and each word takes the speaker it overlaps most.

| Run (production job path) | Length | Peak GPU | WER | Speaker attribution | Job time |
|---|---|---|---|---|---|
| Before: step 12, speaker model inside the one run | 5 min | 7,165 MB | 0.0452 ¹ | 99.4 % | – |
| **After** | 5 min | **6,149 MB** | **0.0408** | 99.4 % | 109 s ² |
| Before: probe of today's single run (runtime drops to chunked mode) | 50 min | 4,859 MB | 0.0763 | **85.6 %** | 398 s |
| **After** | 50 min | **6,144 MB** | **0.0710** | **99.51 %** | 644 s ² |
| **After**, 2 h (episode + 5 min silence + episode) | 107 min | **5,892 MB** | – ³ | 99.62 % ⁴ | 1,180 s ² |

¹ Step 12's published WER was 0.067 under the earlier scorer. Both rows here are rescored with `15-score.mjs`
against the same NASA reference turns, so they compare like with like. Punctuation is unchanged on the 5-minute
clip.
² These are debug-build test times. About 8 s before each piece is spent re-verifying the runtime (hashing the
model files), as the plan requires. That is about 4 of the 20 minutes on the 2-hour file.
³ The only reference covers the 50-minute interview span. The 2-hour WER figure in the raw JSON is scored against
the 5-minute gold and is meaningless.
⁴ Scored on the interview span. Label consistency is measured separately: the file holds the same episode twice,
an hour apart, and 7,521 of 7,645 matched words (**98.4 %**) carry the same speaker label in both halves.

### Plan targets

| Target | Measured | Met |
|---|---|---|
| 5 min: WER and speakers no worse than step 12 | WER 0.0408 vs 0.0452, speakers 99.4 % = 99.4 % | yes |
| 5 min: peak below 7,165 MB | 6,149 MB | yes |
| 50 min: WER ≤ 0.075 | 0.0710 | yes |
| 50 min: speaker attribution ≥ 99 % | 99.51 % | yes |
| 50 min: peak ≤ 6,000 MB total | **6,144 MB** | **no, by 144 MB** |
| 2 h: speaker pass stays flat | 2,335 → 2,257 → 2,254 → 2,254 MB (max per quarter) | yes |
| 2 h: every run within its limit | extraction 1.8 s / 15 min; pieces ≤ 20.2 s / 30 min; speaker pass 404 s / 4 h | yes |
| 2 h: silent stretch → zero-word chunk, not a failure | piece 14 (3,051.4–3,291.3 s) has 0 words; job complete on attempt 1 | yes |

**The 50-minute memory target is missed by 144 MB.** Only two pieces went over 6,000 MB: piece 9 (6,022 MB)
and piece 10 (6,144 MB). The largest rise above the idle desktop was 4,388 MB, on piece 10. The rest comes from
the desktop's own use, which moved between 1,565 and 1,973 MB during the run. The probe had measured about
4,250 MB above idle per piece, so the pieces themselves ran about 140 MB higher than predicted. By user
decision this is recorded, not tuned. 180 s pieces measured 5,500 MB in the probe, but with a worse WER (0.0735
against 0.0705).

### Words at cuts

No word was split across a cut. In the 50-minute run, every cut falls in a pause, and the next word starts
0.7–2.2 s later. In 7 of the 13 cuts the last word before the cut ends exactly on it. That word's end was
reported slightly past the piece's audio and was trimmed to the cut, as described below. On the 2-hour file the
same holds for 19 of 29 cuts, and the next word starts 0.3–2.6 s after each cut. No cut had to fall back to the
hard 240 s limit.

## Runtime behaviour found on real audio, and how it is handled

1. **No speech** (step 1, `step1\`): for 240 s of digital silence, and for a 7 s music break from the episode, the
   runtime exits 0 and prints `{"file":…, "text": "", "confidence": 1, "duration": N, "languages": [], "words": []}`.
   Only that exact shape (`text` exactly `""` and `words` exactly `[]`) becomes a zero-word chunk. Whitespace
   text, text without words, or missing fields still fail. A 10 ms tail piece gives the same shape.
2. **`diarize`**: `--format json -o PATH` writes the JSON to the file and leaves stdout empty. The CUDA proof line
   is the same `Using GPU backend: CUDA0`. With no speech it prints `{"file": …, "segments": []}`. Times are
   seconds with three decimals, and speakers are 1-based.
3. **Word ends past a piece's audio.** The runtime places times on an 80 ms frame grid and rounds the final
   partial frame up. The last word of the last 50-minute piece ended at 140.56 s on 140.516 s of audio, and
   across the 14 pieces ends reached up to 105 ms past the audio. Up to 160 ms (two frames) is accepted, and
   normalization clamps the word to the chunk end and marks it `clamped`. Anything further out still fails. The
   first 50-minute production run failed exactly here before this rule existed.
4. **A last word starting past a piece's audio.** Piece 0 of the 2-hour file (212.14 s) ended with "so" at
   212.16–212.24 s, and piece 1 does not hear it. The word is kept, placed in the piece's last 80 ms frame and
   marked `clamped`. The first 2-hour production run failed here before this rule existed. Speaker segments get
   the same 160 ms end tolerance and are clamped to the file end.
5. The app accepts only video sources, so the 50-minute and 2-hour audio were wrapped in an MP4 with a still
   frame (`prod\interview-long.mp4`, `prod\long2h.mp4`) before they went through the production job.

## What changed in code

- `nemo_transcription.rs`:
  - `plan_transcription_pieces` (pure; quiet window below about −35 dBFS, otherwise a hard cut at the limit).
  - Piece WAVs are written with `create_new` and re-validated, then deleted after their run.
  - `run_nemo_piece` never passes the speaker model and has a 30 min per-run limit.
  - `run_nemo_diarize` makes one streaming pass with a 4 h limit and writes JSON to a fresh temporary file.
  - The speaker output is parsed strictly, with a size cap, `deny_unknown_fields`, speakers 1–4, and ordered,
    finite times inside the source.
  - `assign_speakers` gives each word the largest overlap, then the nearest segment within 0.5 s. Ties go to the
    earliest segment.
  - Required mode is now checked across the whole job. If every piece is silent, the job fails with
    `transcript_invalid`, and the speaker pass never runs.
- `asr_runtime.rs`: `chunk_duration_us = min(source, 240 s)`, and new provider settings
  `segmentation = silence-cut-v1` and `diarization_pass = whole-file-streaming-v1` (with a diarizer), with keys
  still sorted. Transcript identity changes, so earlier cached transcripts are transcribed again rather than
  reused. Nothing is deleted.
- Tests:
  - Zero-word chunks are accepted in Rust (`normalize`/create/load) and in TS (`transcriptArtifactV1Schema`).
  - Piece planning, speaker assignment, speaker-output rejection, and piece parsing have their own tests,
    including the real outputs from points 1, 3 and 4.
  - The fake runtime covers several pieces with correct offsets, the separate speaker pass, Off mode never
    running `diarize`, Required mode with no labels, cancelling during a later piece, a silent middle piece, and
    every piece silent.
- `transcription_gpu_proof.rs`: an optional `SUPA_VIDEO_REAL_ASR_JOB_LIMIT_SECS` for long sources (default still
  900 s), and the evidence JSON now records chunk bounds and word counts.

## Checks

Final pass, on the committed code:

- `cargo fmt --check` and `cargo clippy --locked --all-targets --all-features -- -D warnings`: pass.
- `cargo test --locked`: 441 passed in the library, with 13 ignored (the real-GPU proofs), plus 5 more.
- `pnpm check`, `pnpm lint`, `pnpm format:check`: pass.
- `pnpm test`: 1,007 passed (contracts 288, render 84, media 47, project 151, desktop 437).

Earlier intermediate runs had two load-dependent timing failures in untouched tests, and both pass here:

- a project-command p95 test;
- `workflow.integration.test.tsx`, which has a 5 s limit.

The 5-minute and 50-minute real runs were made before the point-4 rule. That rule only accepts more than before,
and it changes nothing when no word starts past its piece, which was true in both runs.

## Scripts

| File | Does |
|---|---|
| `15-long-file-probe.mjs` | The pre-plan probe that produced the "before" 50-minute numbers and the 240/180 s comparison |
| `15-score.mjs` | Scores a word list against NASA's speaker turns (WER in the reference span, speaker attribution) |
| `15-sample-gpu.ps1` | Samples total GPU memory and the running `ffmpeg`/piece/`diarize` process every 250 ms |
| `15-summarize-run.mjs` | Turns a sample CSV into peak memory and per-process times |

Production runs were started with `SUPA_VIDEO_REAL_ASR_PROOF=1`, `SUPA_VIDEO_REAL_ASR_RUNTIME`, `_SOURCE`,
`_FFMPEG_DIR`, `_GOLD_FILE`, `_EVIDENCE` and `_JOB_LIMIT_SECS`, then
`cargo test --lib -- --ignored --exact video::transcription_job::gpu_proof::real_nemo_cuda_transcription_through_production_job_path`.
All output went to `E:\nemo-runtime\proof\long-files\prod\` (`clip5`, `long50`, `long2h` with `.json`, `.csv`,
`.summary.json`, `.score.json`, `.test.log`, and the failed first attempts).

## Follow-ups (not done here)

- The job shows one stage, so a 20-minute job gives no progress within it.
- Re-verifying the runtime before every piece costs about 8 s each in a debug build. Checking a cheaper
  identity between pieces would need its own decision, because it trades away a check the plan requires.
