# Step 14: deleting a sentence removes its inner pauses (real app)

**Result: PASS.** In the real launched app, cutting one 11-word sentence now leaves **2 clips**. Before the fix it
left **9**. Undo returns the project to the **identical state hash**.

## The bug and the fix

The transcript cut merged selected words only when they touched or overlapped. Real speech has short pauses
between words, so each pause stayed behind as its own 1–6 frame clip.

The fix is in `packages/video-project/src/transcript-edit-proposal.ts`. Two selected words in the same clip now
join into one cut unless an **unselected** word sits in the pause between them. So:

- Pauses fully inside the deleted range are removed with it.
- A pause next to a word the user kept stays.
- Nothing before the first selected word or after the last one is touched.

Regression tests are in `transcript-edit.test.ts`:

- "removes the pauses inside a deleted sentence…" gives 1 cut `[1,6)`, with kept ranges `[0,1)` and `[6,10)`
  closing up to `[0,1)` and `[1,5)`.
- "keeps a pause next to a word the user did not select" gives 2 cuts, with the middle word and its pauses kept.
- The existing 34-range limit test now uses alternating kept words, so it still makes 34 separate cuts.

## Real-app run (2026-09-28)

- **Setup:** the same isolated build, owned launcher and file as step 13 (`interview-102-400.mp4`, 5 min, 2
  speakers).
- **Driver:** `14-cut-gap-native-scenario.mjs`, run with a fresh project folder and fresh app data. Earlier app
  data was moved aside to the E: drive, not deleted.

| Step | Result |
|---|---|
| 1 Import | PASS, 1 clip, frames 0–8970 |
| 2 Transcribe (Parakeet + Sortformer) | PASS, 678 words, 2 speakers, 71.8 s |
| 3 Delete sentence → preview → apply → undo | PASS |

The sentence was "That's fantastic, and you've been charged with quite a big task." (11 words). The Review cut
dialog said: "Removes 11 words in 1 range … the track gets 0:03.37 shorter."

| | Clips | Timeline | Revision | Project state hash |
|---|---|---|---|---|
| Before | 1 (0–8970) | 0–8970 | 1 | `7215f472…5ea82` |
| While previewing | unchanged | unchanged | 1 | `7215f472…5ea82` |
| After apply | **2** (0–4932, 4932–8869) | 0–8869 | 2 | `5e0eebf4…1570c` |
| After undo | 1 (0–8970) | 0–8970 | 3 | **`7215f472…5ea82`** |

- **Removed length:** 101 frames, which is 3.37 s at 30 fps and matches the dialog.
- **Surrounding timeline:** the material before the cut is unchanged (0–4932). The material after it closes up
  exactly.

### How undo is checked exactly

The state hash comes from the app's own read-only `video_project_inspector` command. It is the SHA-256 of the
canonical serialized project state (`project/hash.rs`). Identical before and after undo means the whole project
is back, not just the visible timeline. The visible clips and the word count (678) also match.

### Baseline: same run without the fix

The desktop app imports the compiled packages. The first run used a build from before the fix and reproduced
the bug: **9 clips**, with frames 4932–4957 left as 1–6 frame pieces. Undo was still exact on that run.

That run is kept as `14-baseline-before-fix-log.json` and `14-baseline-*.png`. The packages were then rebuilt
(`build:workspace-dependencies`) and the run repeated. Step 13 ran after the last package build before the fix,
so it is unaffected.

### Harness fix

The folder picker helper (`13-native-dialog.ps1`) now clears the file-name field before submitting. When Windows
remembers the runtime folder, the dialog already opens there, so the helper's old "navigation clears the field"
check never fired and the helper timed out.

The helper still verifies the full path in the address bar and the owning process before it clicks OK.

## Files

- `14-cut-gap-native-scenario.mjs`: the driver.
- `14-scenario-log.json`: the event log for the passing run.
- `14-01-imported.png`, `14-02-transcribed.png`, `14-03a-review-cut.png`, `14-03b-after-cut.png`,
  `14-03c-after-undo.png`: screenshots of each step.
- `14-baseline-before-fix-log.json`, `14-baseline-03*.png`: the run without the fix.
