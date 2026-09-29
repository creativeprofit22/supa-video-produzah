# P3 agent proposals — real-app scenario with the switch on

**Result: proposal flow PASS in the real app; app close is intermittently broken (FAIL, 4 of 11 runs).**

- Build: isolated debug Tauri build from HEAD `2529099` (identifier `com.supavideo.p3-continuous-scenario-20260928`, target `E:\nemo-runtime\proof\hwhap-436\scenario\target`), WebView2, Windows. Frontend from the Vite dev server.
- Switch: `SUPA_VIDEO_AGENT_PROPOSALS=1` in the launch environment (read at runtime, `proposal_ipc.rs`); the panel reported `{ enabled: true }`.
- Driver: `01-proposals-native-scenario.mjs` over CDP by accessible roles, reusing the owned launcher and native-dialog helpers from `../2026-09-28-p3-transcription-audio/`. Each run uses a fresh project folder under `E:\nemo-runtime\proof\hwhap-436\scenario\`.
- Source: `interview-102-400.mp4`, sha256 `050f0b09…2f0e51`. It matched before and after every run.
- Transcription: real GPU transcription (about 11 s), 681 words, 2 speakers.

## Steps (representative passing run: `runs/diag1-*`, same numbers in every run)

| Step | Result | Observed |
|---|---|---|
| 1 Import + transcribe | PASS | Revision 1, 681 words, panel present, "Find filler words" enabled |
| 2 Find filler words | PASS | "Filler words: 4 cuts" (4 × "uh"), 4 timeline bands, revision stays 1 (state hash unchanged) |
| 3 Partial approval | PASS | 2:08.47 cut unticked (its band shown as kept); "Apply 3 of 4" → revision 2, 3 cuts applied, 681 → 678 words, "Proposal applied. Undo reverses it." |
| 4 Restore to before | PASS | Revision 3, clips and 681 words match pre-apply, history "Restored to before" |
| 5 Stale proposal | PASS | New proposal at revision 3; ordinary transcript cut → revision 4; Apply disabled; "The project changed too much since this was suggested…"; revision and words unchanged after the attempt |
| 6 Restart during approval | PASS in 7 of 11 runs, FAIL in 4 | When the close works: pending "Filler words: 3 cuts" comes back after relaunch with all 3 ticked, and revision 4 and state hash are unchanged. After relaunch the panel also says "Transcribe a track to get suggested cuts." because the source needs relinking in the new session. |
| 7 Reject | PASS | "Proposal rejected.", revision and state hash unchanged, native status `rejected` |

Timings: steps 2–7 take about 2–10 s each.

## Bug found: window close sometimes ignored (not fixed)

Sending the normal window-close message (same as clicking X) left the app running in 4 of 11 full runs: attempt1, attempt3, diag2 and diag6. No confirmation dialog was open and the page stayed responsive. Other commands answered in 3 ms, but an explicit window destroy failed with Tauri's `failed to send message to the webview`. That error comes from the native event-loop proxy (`tauri-runtime-wry 2.11.4`, `destroy()` → `proxy.send_event`). On Windows it fails when the posted-message route to the UI thread is refused, for example when the queue is full or the loop has gone away.

What is ruled out:
- **The test driver:** it hangs with or without the DevTools connection attached.
- **The app's unsaved-trim guard:** it only blocks the close when there's an unsaved trim, and no trim was pending.
- **Closing a fresh app with no project:** that closed fine in 2 of 2 tries (`01-close-probe.mjs`).

Cause not identified. Native code only sends media-job and render progress events, so a message flood is a hypothesis, not a finding. Only the process tree is killed at the end; the source file and project data were verified intact.

## What this does NOT prove

- It doesn't show the close bug is limited to this scenario, and it isn't fixed.
- The production build and installer weren't exercised. This was a debug build with the switch on.
- No keyboard-only or screen-reader pass.
- Only the rule-based filler-word producer was used; there's no AI producer.
- Crash in the middle of an apply (as opposed to a clean close) wasn't exercised here; unit and native tests cover it.

Runs: `runs/attempt1` (the close hung), `runs/attempt2` and `runs/repeat` (passed), `runs/attempt3` (the close hung, first diagnostic), `runs/diag1`–`diag7` (diag2 and diag6 hung). Logs are in each `*-scenario-log.json`.
