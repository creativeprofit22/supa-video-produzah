# Step 5 — minimized live timing failure

RUNTIME: `0753793b-9611-43ba-9863-fea75c29190f` ran the unchanged raw HTML-video observer three times via dedicated raw-parity config, output `test-results/completion-raw-diagnosis`. Exit 1, **3 failed**. One-frame gate remained 1.0 frame. Signed audio-minus-expected-display errors: +47.0697, +57.7423, +44.5213ms (1.41209 / 1.73227 / 1.33564 frames). This is a stable red-capable minimal diagnostic, not a stable magnitude. No React, ProgramMonitor or retiming participates; observer still adds a Web Audio graph.

RUNTIME: `323ce41e-2164-4eb6-bf94-9b054dfeafb4` ran only existing 30/1 100% shared preview and final live tests, output `test-results/completion-shared-diagnosis-corrected`. **1 pass / 1 fail**, exit 1. Final error 1.27768 frames. Pitch, decoded endpoint and other soft assertions did not fail in this invocation. Initial invocation `f39beae4-2690-4578-870c-ae289d0f4b28` selected no tests because anchored grep also matched the file-prefix title; retained as invocation error, not a test pass. No full matrix was rerun.

Ranked hypotheses published before further diagnosis:

1. Added observation graph changes the output path. Raw and production graph need a separate common-clock output reference. Not testable with the same observer pretending to be passive; prerequisite is step 6 authorized isolated capture.
2. Timestamp stages differ. Raw trace inspection (`cf1664be-c643-4af9-8dcd-0580bd48faec`) retains display, callback and presentation fields. Presentation→display spans were 15.8 / 15.1 / 15.6ms; callback `now` equaled expected display for the crossing sample. Using earlier presentation timestamps increases positive audio lag rather than bringing these runs inside one frame. This one-variable timestamp-stage observation cannot calibrate physical/digital output.
3. Recorder readiness, contamination or stale ROI could invalidate a separate capture; require readiness acknowledgement, matched unique events, retain unmatched events and fail closed. Not claimed tested before such capture exists.
4. Production clock/effect skew. Current raw failures prevent attributing remaining timing error specifically to production. Pursue only if calibrated raw/final controls pass and production consistently fails.

Recorded baseLatency=10ms and outputLatency=40ms in all three raw runs. Neither was subtracted. Earlier historical failures and new failures remain intact. Decoded media sync/pitch and eight seek cases independently passed in step 4; they do not replace live parity.

Step 5 reproduction/minimization and hypothesis discrimination complete to the authorized observer boundary. Root cause remains unproven. Step 6 must establish the independent capture route before testing observer-effects against actual captured output; step 7 must qualify that route before any production timing repair or full matrix.
