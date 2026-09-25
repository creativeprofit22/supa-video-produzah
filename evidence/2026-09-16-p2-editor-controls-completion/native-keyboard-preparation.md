# One bounded native human-keyboard handoff — prepared, not run

Wait for the performance agent to finish. This mode uses the existing isolated binary/config, disposable native project/profile, actual picker/import and 150% / −6 dB / 5–7 frame fades / source [30,120) setup. It makes one real-UI split at frame 30, selects the first of two clips, focuses **Speed (%)**, then stops automation. It does not play/export/capture or create any extra audio route.

## Parent launch (only after coordination)

Use the existing owned production-root server on 4183 and matching isolated build. Do not launch another server or rebuild here. Port 9226 must be free. From repository root, run as a managed interactive background task, **not** `&`/nohup:

```bash
SUPA_VIDEO_TEST_PORT=4183 node evidence/2026-09-16-p2-editor-controls-completion/native-playback-check.mjs --run-native-keyboard-check-authorized
```

Set `run_in_background: true`, `wake.pattern: "KEYBOARD_READY"`. Read the readiness event and its `remainingLeaseMs` / `humanWindowMs`. Prepare these instructions with the user beforehand; the timer does not wait for chat. Do not synthesize keystrokes after readiness. Ask the human to operate only the disposable private-title editor, without Play, Export, file opening, or touching another app/project.

The original 120-second owned lease is unchanged. Handoff ends eight seconds before its conservative lease deadline to allow normal cleanup. If fewer than 30 usable seconds remain after configuration/split/focus, mode writes `insufficient-time`, emits no KEYBOARD_READY, and stops. It does not increase the budget or automatically retry. Even 30 seconds may be insufficient for all four observations: report exactly what the user could finish.

## Four checks for the human

Use Tab/Shift+Tab to navigate, Ctrl+A to replace a numeric field, and Space/Enter on buttons. No claim of a screen-reader test unless the user actually uses one.

1. **Name, focus, invalid Apply + Reset.** Initially **Speed (%)** is focused and reads 150. Verify its visible label/focus (and announced name if using assistive technology). Type 0: validation appears and **Apply speed** cannot commit; Revision 5 must not change. Tab to **Reset speed**, activate it: draft becomes 100, but revision remains 5. Reset changes a draft only; do not Apply 100 because that would expand the first clip into the second.
2. **Valid Apply + Undo.** Return to **Speed (%)**, type 200, Tab to **Apply speed**, activate it. Expect a saved revision and the speed field regaining focus with 200. Tab/Shift+Tab to **Undo**, activate it: speed returns to 150; the undo creates a newer revision (it does not restore revision number 5). Observe usable visible focus, not just the number.
3. **Multiselect.** Tab to the second timeline clip's **Select single-flash-30-1.mp4** button (the two Select buttons have the same label; use their order). Space toggles it on alongside the already-selected first clip: status becomes **2 clips selected (maximum 100)** and **Multiple clip controls** replaces the single-clip inspector. Toggle that same Select again: one clip remains selected and single-clip controls return. Do not activate Delete or bulk Apply.
4. **Separator.** Tab/Shift+Tab to **Program and media / editing controls pane width** (separator). Right then Left changes pane widths in opposite directions, keeping visible focus; Home/End goes toward its bounded minimum/maximum, respecting minimum pane sizes. Project revision must not change. This is local disposable-profile layout, not a project edit.

Ask the user for one short outcome per numbered check: passed / failed (what happened) / not completed before deadline. Never infer these outcomes from tool completion or automated setup.

After collecting the user's answer, send exactly `DONE\n` to the background task's stdin. If the deadline arrives first, the helper closes normally; do not reopen it automatically. EOF, input overflow, or owned process exit also ends the hold. Wait for process completion and inspect `owned.json` for confirmed empty owned-tree cleanup. Preserve all artifacts.

## Evidence interpretation

`keyboard-check.json` records automated setup/readiness, baseline revision, timing budget and tool termination reason only. `humanResult` stays `unverified`, `humanPass` stays null, even after DONE. The parent's separately retained user answer is the human evidence. No playback/export success or Step 9 completion is emitted by this mode. The existing non-human playback/timing modes retain their original paths.
