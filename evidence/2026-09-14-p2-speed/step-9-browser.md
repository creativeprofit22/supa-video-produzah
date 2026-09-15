# Step 9 — rendered speed control browser verification

Date: 2026-09-14. HEAD: `b21a303c51c258d3aa63fa51217bcbb4508fef0f`; verification used the current dirty working tree, not HEAD alone. Other agents concurrently own controller/preview/integration work. No native, render, ProgramMonitor, dependency, roadmap or history changes were made here.

## Result

Focused Chromium suite: **7 passed**, exit 0, 18.0 seconds reported by Playwright.

Command: `pnpm --filter @supa-video/desktop exec playwright test --config playwright.speed.config.ts --workers=2`

Execution ID: `af0d41bd-9bdb-47bc-8746-aed929180ffa`, started `2026-09-14T18:11:32.588Z`.

- **S9-01:** sequential Tab reaches the named real Speed (%) input; visible focus outline >=2px; keyboard typing drafts 150%, displays exact 200-frame result, with zero fixture commits/revisions. Keyboard Enter on Apply produces exactly one callback/revision and disables same-value Apply. Keyboard Reset selects 100% without committing; subsequent Apply commits once. Fixture undo feeds prior canonical props back into the real component and restores 150%.
- **S9-02:** out-of-range 49/201, fractional 100.5, inexact 101 and empty drafts expose aria-invalid and visible alert, disable Apply and issue no callback. Locked and pending controls are disabled; pending fieldset exposes aria-busy and Saving clip speed status. Injected save failure retains draft and revision with visible explanation.
- **S9-03:** changed selection and external revision keys discard stale drafts.
- **S9-04 (four cases):** desktop 1280x800; narrow 320x800; 320px plus 200% text; forced colors + RTL + reduced motion at 320px. All inspector descendants stay within viewport horizontal bounds. Axe WCAG 2A/2AA/2.2AA reports zero violations for the inspector. Existing long clip/track identity labels are retained.

## Actual rendered screenshots

All are full-page Chromium captures from production `ClipInspector` containing production `ClipSpeedControl` and production App.css; the additional history buttons below the panel belong only to the fixture.

- [Desktop](step-9-desktop.png)
- [320 CSS px](step-9-narrow.png)
- [320 CSS px and 200% text](step-9-text-200.png)
- [Forced colors / RTL / reduced motion](step-9-forced-colors-rtl.png)

The narrow and text captures were opened and visually inspected: speed input, duration, presets, Apply/Reset and guidance remain readable and wrap without horizontal clipping. The text test snapshots every element's computed font size then doubles it; this exercises text enlargement, **not browser zoom**. Keyboard/focus/name assertions are automated real-browser interactions, not a human assistive-technology audit.

## Demonstrated fix and execution history

Initial standard config could not start because port 4173 was already occupied (execution `7743b3b7-f7be-483d-8620-fb7a79d15887`). A first isolated-config attempt inherited both web servers (`3c67fd9c-4470-4337-9422-8437285acf32`); fixed config now replaces the server and uses port 4175 without disturbing the other process.

First actual suite (`613731e4-a1bd-4738-ae34-13cef7d23faf`): six passed, forced-colors case failed contrast. Scoped inspector system-color variables improved existing labels; the next run (`5e575e0d-9eb8-4ea0-9dd9-353fc002b231`) still found inherited speed duration text and Apply foreground/background contrast failures. Final fix gives this inspector CanvasText inheritance and Highlight/HighlightText primary buttons under forced colors. Final suite above passed without disabling axe rules or relaxing assertions. CSS changes are confined to `.clip-inspector-panel` in the existing forced-colors media query.

New fixture/spec/config were formatted with targeted Prettier (exit 0, execution `2fbfccba-83be-4782-91b4-cf2cf17012ef`); fixture was re-read afterward. Production control logic was not modified. After formatting and re-reading all changed files, the same browser command passed again: seven tests, exit 0, 14.3 seconds; execution `cc3c84ce-fd2e-4b55-bccb-c4c0f87220ad`, started `2026-09-14T18:13:34.433Z`. Steroids was unavailable; this work was compared with the existing local transform/opacity browser fixture, not cross-checked against external real-world implementations.

## Explicit limits / parent handoff

This follows the existing transform/opacity **component fixture** approach. Revision, callback counts, saving/error and undo are an explicitly identified React harness, **not use-video-project, native storage, canonical command-service history, or full workspace integration proof**. Parent step 7/integration must verify actual canonical revision/history behavior. Browser evidence does not establish overlap/stale-native-revision rejection, persistence, Windows WebView playback/pitch, exports, screen readers, native accessibility, or human keyboard usability. Full desktop browser regression suite and repository-wide checks were not executed here. Existing informational side-effect CSS-import IDE diagnostic predates these fixture changes; browser bundling succeeded.
