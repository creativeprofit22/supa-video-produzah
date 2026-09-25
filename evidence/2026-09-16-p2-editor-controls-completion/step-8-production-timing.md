# Step 8 — production timing work in progress

## Bounded route and first actual production case

The new completion harness reuses the reviewed read-only isolation guard, audio reader, WGC owned-window ROI, owned browser lease/cleanup and unchanged historical interval extractor. It does not attach an observer AudioContext/worklet. Each invocation has fresh synchronized/+100/-100 ms controls and two production targets; unqualified fresh controls stop before production capture. Three-second audio captures retain the six-second maximum bound. Synthetic media is generated offline and final exports use the existing production compiler's exact argv.

Code review corrected the target title after navigation (WGC requires the owned-window tag in addition to PID/HWND). The new result classifier also distinguishes an uncertainty interval crossing the tolerance boundary (**inconclusive**, never accepted) from an interval wholly outside (**fail**); the pass rule remains the entire interval within one output frame. Regression `f6ec11e4-17b6-47d3-9f47-111ebcb9d350` failed before that correction. Six protocol/measurement tests and syntax check passed in `7c8f3578-3101-4c9f-aa20-17938d782920`.

Actual execution `421393bb-ed8c-4ce6-b52e-5dc5089648aa`, exit 0, recorded `capture-AbjlJq`, **30/1 fps at 100%**. Parent review `7d49779c-ad9b-46e9-89d9-d6d3cc18c1fc`, exit 0, confirmed:

| Observation                                      | Audio minus visual interval (ms) | Pitch Hz                            |
| ------------------------------------------------ | -------------------------------- | ----------------------------------- |
| Synchronized control                             | [-3.567933, 24.879867]           | Separate decoded control validation |
| +100 ms control                                  | [106.423767, 127.693867]         | Separate decoded control validation |
| -100 ms control                                  | [-110.276933, -83.875833]        | Separate decoded control validation |
| Production preview, source in 1 s, rate 1        | [-23.620533, -1.698933]          | 1000.000629                         |
| Production-compiled final, source in 0 s, rate 1 | [-16.980633, 2.652567]           | 1000.002575                         |

Production targets each have one sound and one visual onset, no device gaps, normal stop/bounds checks, unchanged pitch tolerance, read-only guard ready/stopped with zero mutation calls. Owned browser cleanup ends `closed` rootExit=0/empty=true and launcher exit 0. Full intervals and all packet/frame samples are retained, including future-valued compositor timestamps; no offset subtraction. **This bounded digital 100% browser case passes parent review**, not the whole matrix or physical speaker/display timing.

## Separate real export defect — not a capture failure

The new silent-to-tone sources expose a previously missed export defect. Parent reproduction `a6046b49-9870-4a30-9eea-624ffed18d90`, exit 1, retained `apps/desktop/browser-tests/completion-media/decode-check-B97DuO/results.json`. Both 50% outputs have exact expected video count/rate and approximately 1 kHz pitch, but sound begins 58.625 / 59.029 ms before the flash, beyond one output frame. These failed assets/plans are preserved; generation refuses to overwrite them.

One-variable offline isolation `0be96c2e-9bb2-4fae-b2d1-c42aa9ee22a6` establishes that the shift already exists before AAC encoding: trimmed source→production tempo PCM onset 0.741375 s, encoded production output onset also 0.741375 s, expected flash 0.8 s. Pristine generated PCM (no input codec) gives the same onset with `atempo=0.50`; without tempo its onset is 0.400020833 s. Correct video mapping and identical pre/post-AAC onset rule out video trimming and AAC as the cause of this particular displacement. The issue is tempo processing around silence/transients.

The bundled, manifest-verified ffmpeg already contains the alternative `rubberband` filter; no new package or version is installed. Its default window still fails (~43 ms early). A short-window probe improves both 50% cases to ~23 ms early with correct pitch/end envelope, but **blanket replacement is not justified**: the probe fails 1% pitch for fractional-rate 150%/200% cases. All diagnostics, including failures, remain in `capture-tempo-HfFz0k/results.json` (execution `eab3d765-9cb0-4e67-bf9c-5665a14ca8f1`; compact review `3916916c-b42a-4f1c-a6ad-b497612f1f47`). These are diagnostic filter probes, not new production-compiled acceptance.

A minimal slower-than-1x repair is under test, preserving the existing speedup path and exact TypeScript/native filter validation. No repaired production acceptance is claimed here. Remaining gates include the other seven browser timing cases, source audition, native changed-flow/end behavior, ordinary-suite failures, human keyboard check and fresh stabilized-source verification. Step 8 is not Done.
