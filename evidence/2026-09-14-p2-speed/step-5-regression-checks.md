# Step 5 regression checks — 14 September 2026

Partial implementation evidence, not completion of speed or the editor-controls phase.

Follow-up: [step-5 consumer/diff audit](step-5-consumer-audit.md) records the completed scoped audit and fresh checks after ownership recovery. The results and remaining-scope statement below are historical; the default-parallel worker-startup failure has not been cleared.

Source base: `b21a303c51c258d3aa63fa51217bcbb4508fef0f`, with the existing dirty tree preserved. This continuation changed only the render and multitrack timeline test fixtures plus this new report. Earlier speed implementation edits and unrelated dirty files remain; this is not a clean-revision or final source-fingerprint claim.

## Reproduced failures and corrections

- Package run `86ff263c-a973-4931-abe7-9129c59b7007` exited 1. Contracts passed 261 tests. The render admission fixture used 75 source frames; 200% requires 37.5 timeline frames and correctly fails strict timing validation before the unsupported-render guard. The admission test now uses 90 source frames, exact for all three tested multipliers. Both compiler rejection assertions remain unchanged; no validation was relaxed.
- Serial desktop run `6bab7f19-0269-4ada-b1d9-f71c3694f90b` exited 1: 105 passed, one timeline test failed. Its pointer movement assumed pixels per frame, but viewport zoom is pixels per second. At 10 fps and 4 pixels/second, a 4-pixel movement is ten frames, not one, and therefore maps exactly at 150%. The test now moves 0.4 pixels for the inexact one-frame proposal and 0.8 pixels for the exact two-frame proposal. Rejection, visible error, one committed edit, and exact source range assertions are retained.

## Observed checks

- `b29ee0eb-0c53-4958-b45e-c62a16c04c0c`: affected contracts/project/render package command exited 0: 261 + 137 + 34 = 432 tests passed.
- `b2db27c4-736f-4d4d-97db-51030504f6b3`: native `speed_timing_tests` command exited 0, 2 passed, 357 library tests filtered out. Covers exact retimed split/trim/move/ripple and rejected source-boundary transactions; not full native-suite proof.
- `29c31948-c9a2-4cb0-b42e-c85fd9c4c7b9`: default-parallel desktop selection exited 1. The trim mapping, move snap and fixture service suites passed 16 tests, but four UI workers failed startup with runner-response timeouts. This remains unresolved and is not converted to a pass by serial diagnostics.
- `6bab7f19-0269-4ada-b1d9-f71c3694f90b`: serial diagnostic passed ProgramMonitor (34), VideoWorkspace (7), and controller (46), with the timeline fixture failure described above.
- `6e0424b0-e118-46f7-8bf3-42b433d7b482`: after the pointer-coordinate correction, serial MultitrackTimeline passed all 19 tests, exit 0.
- `28edd6fe-4add-48ff-8f4e-2e8b8b430dad`: `pnpm check` exited 0 across the workspace.
- `6a49c389-808d-4126-b437-d96657beb18a`: targeted formatting check failed on the render test. Prettier subsequently formatted only that file (`3bb0d292-b158-4d34-b6aa-334c344125f2`, exit 0); the affected region was reread.
- `644b0add-f83d-4a05-aacb-330a9069c7cc`: post-format render tests passed 34; targeted Prettier check passed for both changed test files. The shell explicitly propagated test failure before formatting; combined exit 0.

## Remaining scope

Step 5 still needs its final consumer/diff audit before checkpointing. Speed export compilation, inspector controls, speed-aware playback, browser accessibility and actual browser/Windows WebView/export audiovisual measurement gates remain later approved work. Unsupported speed preview and export remain intentionally rejected at this point. No actual playback, pitch, or export parity is established by these unit tests. No user projects, dependencies, commits, or publication were changed.
