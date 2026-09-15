# Populated workspace browser verification — 2026-09-14

## Outcome: partial verification; two genuine blockers remain

Added `apps/desktop/browser-tests/video-workspace.fixture.tsx`: installed Tauri `mockIPC` with `shouldMockEvents`, `mockConvertFileSrc`, and `createMockVideoService().invoke`; real CommandProvider, useVideoProject, and VideoWorkspace. Fixture buttons create/import canonical media and split into two clips. Fixture-only readback records canonical state, revision, project-group count, total IPC count, and command names. No production test hooks.

Added `VideoWorkspace.spec.ts` covering audio drafts/apply/reset, source range and revision-stale draft discard, keyboard multi-selection, bulk gain/speed/move/delete/history, locked selection, populated 320px/200% text, focus and scoped axe. **Written coverage is not equivalent to passed coverage.**

## Executed

- `pnpm --filter @supa-video/desktop check`: PASS (frontend, node, browser TypeScript).
- `pnpm --filter @supa-video/desktop exec vitest run src/video/TwoPaneWorkspace.test.tsx`: PASS, 13 tests.
- Focused Playwright `WorkspaceLayout.spec.ts`: PASS, including new 961px container regression, actual measured pane ratio versus ARIA, and immediate ArrowRight increment from the clamped width; existing persistence/reset/320px reflow also passed.
- Populated Playwright tests: initial cold-load timeout; reruns successfully loaded the real populated workspace. Latest command: `pnpm --filter @supa-video/desktop exec playwright test browser-tests/VideoWorkspace.spec.ts --workers=2 --timeout=20000`: 2 failed.

Latest controls run passed audio gain/fades draft non-command checks, exactly-one apply and reset-apply revisions, source-range apply, stale draft discard on Undo, split, keyboard selection, and bulk gain. Final actual readback from trace attachment: **revision 7, 6 project-group invocations, 10 total IPC invocations**.

Bulk speed then fails before revision 8: visible schema error rejects extra keys `gainMilliDecibels`, `fades`, `isVideo`, `locked`, `hasAudio`. Evidence: `test-results/desktop-browser/VideoWorkspace-populated-c-02c8a-istory-and-locked-selection/error-context.md:94` and accompanying trace.zip. This is a real controller/component integration boundary issue, not a mock render/audio result. Bulk move/delete/history and lock coverage is written but not reached. The lock scenario currently locks the shared track, not one of two distinct tracks; strengthen that scenario after resolving the boundary.

Populated narrow test reaches the selected Clip audio inspector but **document overflow assertion fails at 320px/200% text**. Keyboard Tab and scoped axe are written after that assertion and were not reached. Evidence: `test-results/desktop-browser/VideoWorkspace-populated-3-ae384-yboard-focus-and-scoped-axe/error-context.md` and trace.zip. No populated screenshot success claimed.

## Splitter fix

`TwoPaneWorkspace.tsx` derives dynamic bounds from ResizeObserver-measured grid width and root rem size, matching the CSS 18rem clamp. ARIA reports effective split; keyboard arrows and pointer movement start from effective geometry. Stored preference is preserved across geometry changes; Home/End remain preference endpoints. Unit checks retain RTL, cancellation and persistence coverage.

No ProgramMonitor/native/render/controller edits; no dependencies, commits, or roadmap edits. Actual media/rendered-audio parity is explicitly separate and unverified here. Returning partial results within the requested time budget rather than claiming remaining controls passed.
