# Step 12 · Real two-speaker GPU proof with the speaker diarizer (2026-09-28)

**Result: PASS.** Real recorded speech from two real people, scored against the publisher's own
speaker-attributed transcript. No synthetic, staged or text-to-speech audio was used. The user rejected a
JFK plus computer-voice mock-up as not a real test.

## Source

| Item | Value |
|---|---|
| Recording | NASA *Houston We Have a Podcast*, Episode 436 "The Moon Base" (recorded 2026-08-14). Host Nilufar Ramji and guest Carlos García-Galán. |
| Audio | Official feed enclosure `https://traffic.megaphone.fm/NATIONALAERONAUTICSANDSPACEADMINISTRATION9936593694.mp3`, sha256 `52be51a0…ad29`, 3102.2 s |
| Reference | NASA's published transcript at `https://www.nasa.gov/podcasts/houston-we-have-a-podcast/the-moon-base/`, with speaker names per turn (`12-nasa-reference-turns.json`) |
| Rights | NASA audio used under NASA media usage guidelines. The media files stay on E: (`E:\nemo-runtime\proof\hwhap-436\`) and are not committed. |
| Clip | 102–400 s of the episode, 298.97 s long. It starts at the host's first interview question and skips the intro and archival launch audio. Muxed to H.264 (episode cover still) plus AAC: `interview-102-400.mp4`, sha256 `050f0b09…0e51` |

## Run

Test: `video::transcription_job::gpu_proof::real_nemo_cuda_transcription_through_production_job_path`, via the
same production path as step 10 (consent → manifest verify → ingest/probe → durable GPU job → FFmpeg →
NeMo `cuda:0` → managed artifact → owner-scoped read). The runtime folder now contains the pinned
diarizer, so the configuration selected `speakerDiarizationMode: optional` and passed
`--diar-model sortformer-v2-f32.gguf --max-speaker-count 4`.

```
SUPA_VIDEO_REAL_ASR_PROOF=1 SUPA_VIDEO_REAL_ASR_RUNTIME='E:\nemo-runtime\runtime' \
SUPA_VIDEO_REAL_ASR_SOURCE='E:\nemo-runtime\proof\hwhap-436\interview-102-400.mp4' \
SUPA_VIDEO_REAL_ASR_FFMPEG_DIR='<WinGet Gyan.FFmpeg 8.1.2 bin>' \
SUPA_VIDEO_REAL_ASR_GOLD_FILE='E:\nemo-runtime\proof\hwhap-436\reference.txt' \
SUPA_VIDEO_REAL_ASR_EVIDENCE='E:\nemo-runtime\proof\hwhap-436\production-proof.json' \
cargo test --lib -- --ignored --exact video::transcription_job::gpu_proof::real_nemo_cuda_transcription_through_production_job_path --nocapture
```

Output: `test result: ok. 1 passed; 0 failed ... finished in 104.59s`. The full artifact words with speakers
are in `12-real-two-speaker-proof.json`, and the scoring is in `12-real-two-speaker-scoring.txt`.

## Measurements

| Metric | Value |
|---|---|
| Distinct speakers found | **2** (`speaker_1`, `speaker_2`). The recording has exactly 2. |
| Labelled words | 678 / 678 (`missingSpeakerWordCount` 0) |
| **Speaker attribution accuracy** | **99.4 %** (643 / 647 exactly matched words; mapping `speaker_1` → host, `speaker_2` → guest). Errors: 2 host words labelled as the guest, 2 guest words labelled as the host, all at turn boundaries. |
| WER against NASA's transcript | 0.067 (46 edits / 686 reference words). NASA's transcript is edited (fillers such as "uh" removed, false starts tidied), so this overstates true recognition error. |
| Job wall clock | 77.9 s for 299 s of audio (runtime re-verify 17.5 s of that) |
| Second start, same source and configuration | `complete` from cache in 8.9 s, same transcript key |
| Peak VRAM (GTX 1080, 8 GiB) | **7,174 MiB** (idle 1,826 MiB), GPU util peak 100 % (`12-vram-production.csv`, 0.5 s samples) |
| Identity | `diarizer_sha256 17ebac6c…579b` is in the provider settings, and the manifest sha256 is `8a412ac9…5806` (changed, so users re-consent) |

The scoring uses a semi-global word alignment: the whole hypothesis against a prefix of the reference,
because the clip ends mid-episode. Speaker accuracy counts only words that match exactly, so ASR errors
don't distort it.

## Defect found and fixed by this run

The first run **failed** with `transcript_invalid`. On real speech, the NeMo runtime emits word times on an
80 ms grid that sometimes overlap: 26 words whose end runs past the next start, and 1 pair sharing the same
frame (27 / 678). This happens **with and without the diarizer**: the same 27 overlaps appear in a
diarizer-free run. The short JFK clip used in step 10 never triggered it. So before this fix, any
realistically long recording failed transcription.

Fix (`repair_word_overlap` in `nemo_transcription.rs`): an overlapping word end is pulled back to the next
start and marked **clamped**. Words sharing a frame split it evenly and are marked **estimated**. The
artifact's clamped/estimated counts record every repair. Words that are genuinely out of order (a word
ending before the previous one starts) still reject the transcript. Regression tests use the exact shapes
from this run.

## Risks and limits (stated, not implied)

- **VRAM headroom is thin.** The 7.2 GiB peak on an 8 GiB card was for a 5-minute clip. Longer sources, or
  other GPU apps, may run out of memory. The plan's fallback (a separate `diarize` pass) is not implemented.
  This is recorded as a known gap.
- One recording, two speakers, clean studio audio. Overlapping speech, 3–4 speakers and noisy rooms were
  not measured. Labels are machine output and the UI says so ("may be wrong").
