# Actual native playback and Final preview — verified, live timing still open

Execution `3af00a84-6d57-4e61-ac78-5ba4679c95e2` exited 0 on 2026-09-17T01:59:25Z. Isolated native build `13518a93-d65c-43b0-885d-d04e74ce0f3c` passed; native executable SHA-256 `ba229aad0dda4ceb848b990754f622fa94defc3d3a620d539daf276c20482e15`. It used the real production editor and native IPC/pickers, not the browser speed fixture. Disposable evidence: `C:/Users/SPARTA~1/AppData/Local/Temp/supa-controls-native-Dfdbcs`.

Parent review `35c6d58f-85e4-40c8-a6db-1da43e3f79b6` confirmed `playback.json`, `decoded-final.json` and owned cleanup:

- Actual UI imported the synthetic source and committed 150% speed, -6 dB gain, 5/7 frame fades and selected source in 30, with canonical revision 4 recovered from the matching native journal projection.
- Preview paused at source time 1.250001 s, rate 1.5; resumed and stopped at source time 3.950001 s, canonical frame 59, paused=true. The two-animation-frame paused-time stability assertion passed.
- Actual native export completed through its real save picker. Output has 60 frames, approximately 1000.006436 Hz, decoded sound-minus-flash -15.979167 ms (within unchanged one 30fps frame).
- Final preview paused at 0.231845 s, rate 1; resumed and stopped at 1.966668 s, frame 59, paused=true. Final was explicitly rewound through real transport commands, because changing modes correctly preserves the canonical playhead.
- Owned job reports all processes exited, `closed` rootExit=0/empty=true, launcher exit=0.

## Reproduced production fix

Earlier run `db96a6bb-7781-499d-a2c4-c39b0dd52a62` exported successfully but Final could not load. The renderer wrote cached Final previews under legacy `video-phase1/render-preview`, outside the existing allowed asset scope. It now writes `supa-video-media-v1/derived/render-preview/<job>/preview.mp4`, using the existing namespace and directory containment checks. CSP/grants were not widened. Legacy cached previews were not migrated or deleted.

Regression `a1d674c2-3280-44eb-a6d7-41e0281468de` failed before the fix. Exact-path and invalid-component tests now pass. The first symbolic-link fixture failed with Windows privilege error 1314 (`67683ccb-db68-4115-8737-10bc5c7cfeea`); this failure remains retained. The repository's existing real Windows junction fixture then verified rejection at all five ancestor levels, intact redirects and untouched targets. The suspected junction-check defect did not reproduce; no speculative production check change was added. Do not claim successful Windows symbolic-link execution.

## Reproduced test-setup fixes

Raw cargo builds did not stage bundled media binaries in the separate target directory. The driver now copies only manifest-verified local binaries, refuses mismatched existing resources and never falls back to PATH. Import preparation completion is followed by waiting for its actual native projection, without increasing the 45-second/120-second bounds. The checkpoint at revision 0 is not mistaken for the current journal projection.

Handy's unrelated server occupied 4173. The user explicitly approved a validated local-only test-port override. This run uses 4183; Handy was untouched. Host restriction, strict port ownership, CSP, grants and test budgets are preserved.

## Limits

This is **tool-driven native playback/export verification**, not live digital A/V capture or human keyboard/assistive-technology proof. `playback.json` explicitly records timingAccepted=false. The optional native capture path is implemented and has syntax/unit/PowerShell-parse checks, but native geometry, zero-packet readiness and calibrated native capture are not yet runtime-qualified. Discord remained active at the last inspection; recording is conditional on isolation. Step 9 is not wholly Done.
