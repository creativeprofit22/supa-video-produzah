# Step 4 — production-compiled media coverage

All runs are bounded synthetic local media, verified bundled media tools, existing path grants and argv arrays. No user project or foreign recording.

Added `compile-multilayer-export.mjs`, which constructs a canonical two-asset revision and invokes the production compiler. Native `render_multilayer_production_compiler_independent_hidden_and_muted` renders four eligible modes (normal / muted / hidden / both) through the real native worker. Red video + 700Hz audio at 150% and blue video + 1300Hz audio at 50%, both with nonzero source-in, independently distinguish image and sound. Every output has exactly 60 decoded frames at 30/1; hidden reveals blue without removing the red tone, muted retains red pixels without its tone. PCM frequency projections use an interior window to exclude AAC priming/atempo edges. Unsupported nonzero-start composition is explicitly rejected, not admitted by new compiler behavior.

Added a dedicated browser fixture/spec/config using generated native outputs and real media. Pixel samples come from screenshots of the actual monitor composite, not CSS-only assertions. Covers both colors, independent mute/hidden media state, exact source mapping at frames 0/15/45/59, two playback speeds, final 1x and last frame, raw audition 1x, plus decoded layer switching through a black gap and real pause/resume to the last frame. It does not claim calibrated live A/V synchronization or passive browser output PCM; those belong to later steps.

## Reproduced product defect

Native export passed but browser `muted` case failed: clock-layer loadedmetadata invoked generic `applyEffectiveAudioState`, overwriting its track mute when another track was audible. Added loadedmetadata assertions to the existing layer independence unit test; observed red (`9e3a730d-54ed-45a0-81a6-1968295b7a31`, exit 1, one selected failure; 44 tests filtered by name, not source-skipped). Fix makes the shared audio-state handler consult the actual composition layer's mute/hasAudio state. Final/raw paths remain unchanged. Existing pre-session endpoint fix is retained, not rewritten.

## Execution ledger

- `029bf189-8a71-4a4d-b323-d9899da539bc`: initial native multilayer test passed. The preceding render package filter matched no project; this is not claimed as a build. Corrected to the actual `@supa-video/render` name in the next run.
- `0a244839-6e9c-45f3-98c7-540b2ce0fd8f`: render build passed; first browser invocation failed parsing a missing bracket in new test code. No tests executed; corrected syntax.
- `7ec7e8ed-761b-4378-955a-e303270673aa`: browser 3 pass / 2 fail. One real metadata/mute defect above. Gap pause test also sampled at coarse polling intervals and could reach the clip end before clicking Pause. Changed polling cadence to 16ms (not tolerance/time budget); no fixture length or production clock changes.
- `41b11c59-542e-4a55-bb5d-84e5deae6839`: 45 component tests and 5 browser tests pass after mute fix.
- After scoped formatting and rereading: `c036b805-4187-48ca-9285-c6e215261322`, exit 0, **three real-media native tests passed**. Explicit filters: `render_speed_production_compiler_actual_parity`, new multilayer test, and `render_audio_gain_and_fades_actual_compiler_output`. Eight speed/rate combinations preserve exact frame count/rate, one-output-frame sync/cadence/duration gates, 1% pitch and wrong-speed/pitch-shift sensitivity. Gain/fade PCM ratios retained. Multilayer red tone approximately 0.125148 when audible, 0.000016 when muted; blue remains approximately 0.123 in all four modes.
- `3ac3468b-70df-4184-911b-20254ac905ef`, exit 0: desktop TypeScript, **59 affected component tests**, **5 multilayer browser tests** using five workers; formatted source.
- `e337e6e7-5b1c-4283-a460-40e86bb2e54b`, exit 0: **eight existing decoded-seek browser tests passed**, both 30/1 and 30000/1001 at 50/100/150/200%. Only deterministic decoded tests selected; no full live timing matrix rerun before calibration. Existing dedicated config's one worker was unchanged.

Execution logs: local GG foreground directory by execution ID. Distinct ignored browser output directories retain failures and traces. Generated MP4 fixtures are already ignored by repository rules.

Step 4 fixture/output work complete. Live timing measurement is not qualified, browser independent sound output still needs qualified changed-flow evidence, and actual Windows-editor/native output interaction remains unexecuted. No step 8 or final acceptance claim.
