# Assemble workspace layout — 2026-09-14

## Implementation

- Actual integration: `apps/desktop/src/video/VideoWorkspace.tsx`, existing `workbench-grid` children remain program/timeline column followed by source/media/editing-controls column. No pane reordering or editor-controller/multiselect changes. Reusable `TwoPaneWorkspace` owns only local layout state.
- Actual stylesheet: `apps/desktop/src/App.css`. Existing shared rail, border/focus tokens and panel styles reused. Split defaults to 68.5%, bounded 25–75%; CSS additionally enforces 18rem pane minimums. Below a 60rem layout container, panes stack and the separator is display:none (no accessibility-tree entry or tab stop).
- Separator accessible name in actual workspace: `Program and media / editing controls pane width`; role separator, vertical orientation, numeric min/max/current, generated React useId aria-controls target. Reset action: `Reset layout`.
- Pointer capture, RTL physical direction, cancel/lost-capture rollback, unmount RAF/capture cleanup. Pointer/keyboard drafts coalesce through requestAnimationFrame; completed gestures save once, keyup followed by blur does not duplicate writes.
- Preference key: `supa-video.workspace-preferences`; JSON version 1, finite numeric split in [25,75] only. Invalid/corrupt/version-mismatched/read-denied preferences recover to defaults. Failed writes retain session layout and show status. Reset repairs saved data. Component has no project controller/command imports or project revision/history writes.

## Executed verification

- Prettier write on new component/preferences/unit tests, actual stylesheet, and new browser fixture/spec before checks. VideoWorkspace integration limited to import/open/close wrapper lines; unrelated concurrent editor JSX intentionally not reformatted.
- `pnpm --filter @supa-video/desktop check` — PASS twice (application, node, browser TypeScript configurations).
- `pnpm --filter @supa-video/desktop exec vitest run src/video/TwoPaneWorkspace.test.tsx src/video/VideoWorkspace.test.tsx` — PASS, 22 tests (13 splitter/preference, 9 actual workspace regression tests).
- Unit coverage: pointer upper/lower bounds in LTR/RTL; capture cancellation; keyboard Home/End/arrows/bounds; one write per completion; RAF coalescing; child DOM identity; reload preference; reset; corrupt/version/range/type/nonfinite storage; denied reads/writes. Persistence spy verifies workspace key only. No canonical command path exists in splitter; no explicit controller-spy integration test added.
- `pnpm --filter @supa-video/desktop exec playwright test WorkspaceLayout.spec.ts` — PASS, Chromium test **LAYOUT-B01 keyboard persistence and narrow/text reflow**. 1440px keyboard Home, reload restores width, reset restores default; 320px with root font-size 200%, hidden separator, controls visible, no horizontal document overflow, tab skips hidden separator.
- Screenshot: `evidence/2026-09-14-p2-editor-controls/layout-320-text200.png`.

## Gaps / parent integration follow-up

- Browser fixture exercises the actual reusable splitter with the actual stylesheet and representative pane controls, not a populated VideoWorkspace/project. Full inspector/timeline content at 320px/200% still needs parent integration coverage; do not interpret fixture evidence as proving every existing child control reflows.
- CSS minimums can constrain rendered proportions beyond requested percentage near the stacking threshold; aria-valuenow represents requested preference, not measured pixels.
- Browser pointer/RTL and real browser zoom not separately exercised (unit pointer/RTL and browser 200% root text sizing were executed). No native build, dependency additions, commits, or roadmap edits.
