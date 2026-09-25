# Step 9 — later actual-editor persistence pass, timing/human gates remain

This supplements, not replaces, `step-9-native-partial.md`. The earlier picker/tool-readiness failures remain failures. The user authorized independent native checks while capture was deferred.

## Actual native run recovered from retained evidence

Execution `07bb3970-0aca-4d3c-9bf0-12e99679216f`, timestamp 2026-09-16T22:10:39.752Z, returned `UI_CHECKS_PASS` on both launches and `NATIVE_UI_RESTART_PASS`. Source hashes: `stamp-native-ui-final.json`. Runtime: WebView/Chromium 153.0.4234.32. Disposable project: `C:/Users/SPARTA~1/AppData/Local/Temp/supa-controls-native-dy0KVw/acceptance.svpvideo`. Real production root, actual IPC, owned native file picker and isolated app identifier/profile; no user project or mock backend.

The real tool readiness checks took 30.512 s and 27.498 s on the two launches. The driver awaited actual bundled ffmpeg/ffprobe readiness instead of treating import preparation as instant. This does not certify a startup performance budget.

Driver and execution evidence cover single speed 150%, gain -6 dB, fades 5/7 output frames, source in 30, exact revision adoption, source-range undo/redo, locked controls disabled, unlock, split, keyboard multiselection, common gain -9 dB, common speed 200%, move +5, delete, undo/redo/undo, local layout resize, real project reopen and actual process restart. Layout is local preference and selection is absent after restart; neither is added to project history.

Independent retained-file verification `653a1aeb-3744-4103-8637-73f6f5e8cafd`, exit 0, confirmed:

- Revision 16; undo stack length 10; redo stack length 1.
- Saved project exactly equals the expected captured document, including state, revision and history.
- Clip 1: timeline start 5; source [30,120); speed 2/1; gain -9000 milli-decibels; fades 5/7.
- Clip 2: timeline start 65; source [120,180); speed 2/1; gain -9000 milli-decibels; fades 5/7.
- Project SHA-256: `082c1ad1b26e766644d24fa1bc531e8cba20ebde9916f2f93c10c5eeaa57d0d8`.
- Both owned launches have `closed`, rootExit=0, empty=true and launcher exit 0, not just browser navigation. The second launch's driver also asserts exact state/revision/history equality against the first launch.

## Explicit limits

This is a **tool-driven native interaction and persistence pass**, not a human keyboard or native assistive-technology pass. The driver contains no Play/Pause/end-frame assertions, so this run does not establish native playback, final end behavior or calibrated changed-flow parity. Step 9 as a whole remains incomplete until those required checks and the bounded human check are resolved; do not issue its completion marker on persistence evidence alone.

## Later independent verification correction

The latest recorded ordinary browser command is `3931f706-5ca1-454b-82a8-98ab31b49402`, **exit 1: 90 passed / 12 failed**, not the earlier 91/11 checkpoint. Ten failures are shared-parity live timing; two are the ProgramMonitorSpeed 200% and final/wrong-speed measurement-control tests. No suppressions, tolerance changes or skips authorize treating that suite as passed. Full log retained at `C:/Users/SPARTAN PC/.gg/foreground/3931f706-5ca1-454b-82a8-98ab31b49402.log`.

The separately user-authorized repository formatting pass is historical context, not authorization for new unrelated edits. Later lint/format successes must be distinguished from this turn's subsequent capture-harness edits, which require affected verification again. See the new calibration review for the now-qualified digital measurement route; production timing remains unaccepted.
