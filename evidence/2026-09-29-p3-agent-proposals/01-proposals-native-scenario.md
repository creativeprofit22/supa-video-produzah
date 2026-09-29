# P3 agent proposals — real-app scenario with the switch on

**Result: PASS — all 7 steps pass in the real app, 6 of 6 runs after a harness fix.** The earlier intermittent "close ignored" failure was the test harness closing the wrong window, not an app bug (see below).

- Build: isolated debug Tauri build from HEAD `2529099` (identifier `com.supavideo.p3-continuous-scenario-20260928`, target `E:\nemo-runtime\proof\hwhap-436\scenario\target`), WebView2, Windows. Frontend from the Vite dev server.
- Switch: `SUPA_VIDEO_AGENT_PROPOSALS=1` in the launch environment (read at runtime, `proposal_ipc.rs`); the panel reported `{ enabled: true }`.
- Driver: `01-proposals-native-scenario.mjs` over CDP by accessible roles, reusing the owned launcher and native-dialog helpers from `../2026-09-28-p3-transcription-audio/`. Each run uses a fresh project folder under `E:\nemo-runtime\proof\hwhap-436\scenario\`.
- Source: `interview-102-400.mp4`, sha256 `050f0b09…2f0e51`. It matched before and after every run.
- Transcription: real GPU transcription (about 11 s), 681 words, 2 speakers.

## Steps (final run: `01-*`; `runs/fixed1`–`fixed5` identical)

| Step | Result | Observed |
|---|---|---|
| 1 Import + transcribe | PASS | Revision 1, 681 words, panel present, "Find filler words" enabled |
| 2 Find filler words | PASS | "Filler words: 4 cuts" (4 × "uh"), 4 timeline bands, revision stays 1 (state hash unchanged) |
| 3 Partial approval | PASS | 2:08.47 cut unticked (its band shown as kept); "Apply 3 of 4" → revision 2, 3 cuts applied, 681 → 678 words, "Proposal applied. Undo reverses it." |
| 4 Restore to before | PASS | Revision 3, clips and 681 words match pre-apply, history "Restored to before" |
| 5 Stale proposal | PASS | New proposal at revision 3; ordinary transcript cut → revision 4; Apply disabled; "The project changed too much since this was suggested…"; revision and words unchanged after the attempt |
| 6 Restart during approval | PASS | Clean close (exit code 0); pending "Filler words: 3 cuts" comes back after relaunch with all 3 ticked, and revision 4 and state hash are unchanged. After relaunch the panel also says "Transcribe a track to get suggested cuts." because the source needs relinking in the new session. |
| 7 Reject | PASS | "Proposal rejected.", revision and state hash unchanged, native status `rejected` |

Timings: steps 2–7 take about 2–10 s each.

## Resolved: "close ignored" was a harness bug

In the 15 runs before the fix, the close was ignored in 5 (attempt1, attempt3, diag2, diag6, rc1). While it was stuck, native window destroy failed with `failed to send message to the webview`.

**Root cause:** the harness sent the close to the wrong window. The launcher's lookup (`13-OwnedLauncher.cpp`) returns the process's first visible, unowned top-level window. Tao's internal message window ("Tao Thread Event Target") is also created `WS_VISIBLE | WS_POPUP` (`tao 0.35.3`, `create_event_target_window`). When Windows lists it first, the close destroys the event loop's message target, not the app window. After that, every native-thread call (`EventLoopProxy::send_event` → `PostMessageW`) fails, so the app can never close itself.

Proof:
- `02-queue-probe.ps1` lists the process's windows by class. In rc1 (failed), the close went to handle 1837386, the Tao target, and afterwards that window no longer exists. In rc2–rc4 (passed), it went to the "Tauri Window".
- Sending the close to the Tao target on purpose (`01-close-probe.mjs tao-target`) hangs 4 of 4 times, and destroy returns the same `failed to send message to the webview` error.
- Fix: the scenario keeps the identity check, then targets the window with class "Tauri Window". After the fix, 6 of 6 runs close cleanly with exit code 0.

The app isn't affected by this: a user can only click the real window's close button. Older evidence harnesses that close via the same launcher lookup carry the same hidden risk; they weren't changed.

## What this does NOT prove

- In the six post-fix runs Windows happened to list the app window first, so none hit the old ordering. That the fix handles the reverse order rests on selecting by class plus the deliberate tao-target reproduction.
- The production build and installer weren't exercised. This was a debug build with the switch on.
- No keyboard-only or screen-reader pass.
- Only the rule-based filler-word producer was used; there's no AI producer.
- Crash in the middle of an apply (as opposed to a clean close) wasn't exercised here; unit and native tests cover it.

Runs: `01-*` and `runs/fixed1`–`fixed5` (after the fix, all pass). Before the fix: `runs/attempt1`, `attempt3`, `diag2`, `diag6`, `rc1` (the close hung) and `runs/attempt2`, `repeat`, `diag1/3/4/5/7`, `rc2`–`rc4` (passed). Logs are in each `*-scenario-log.json`.
