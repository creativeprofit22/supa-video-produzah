# Multiselect accessibility implementation evidence

## Implemented

- Common volume uses dB (−96 to +24, 0.001 step); canonical integer milli-decibels remain unchanged. Browser assertion explicitly expects [-3000, -3000] after input -3.
- Mixed blank audio fields preserve individual canonical values. Whole-frame fades validate per target including their combined duration. Common speed also checks existing fades against resulting duration.
- Fieldsets disable all relevant inputs and buttons during saving, external pending operations, locked selections, or audio/speed ineligibility. Immediate ref guard prevents simultaneous submissions.
- Local multi-clip CSS uses existing panel/tokens, wrapping labels, constrained numeric input width, and zero fieldset minimum inline size.
- Selection-only mounting key and revision reset discard stale drafts without remounting the selected inspector. Keyboard Apply restores volume focus across adoption; pointer Apply does not request focus.
- Parent-owned successful keyboard Delete focus record restores fallback Undo focus after disappearance; explicit timeline selection and Clear selection cancel that record. Stable fallback history toolbar retained.

## Commands and exact results

- `pnpm --filter @supa-video/desktop check`: PASS, final run checks application, node, and browser TypeScript configurations.
- `pnpm --filter @supa-video/desktop exec vitest run src/video/MultiClipInspector.test.tsx src/video/bulk-clip-edit.test.ts`: PASS, **one matching file / two tests**. The named bulk-clip-edit.test.ts did not match a test; no separate bulk/controller suite was verified in this run.
- `pnpm --filter @supa-video/desktop exec playwright test browser-tests/VideoWorkspace.spec.ts`: final PASS, **2/2**, 6.1 seconds. Earlier strengthened keyboard Delete test exposed missing rerender after promise completion; fixed with parent focus-state notification and rerun successfully.
- Populated actual VideoWorkspace multiselection at 320px viewport and 200% root text: PASS document scrollWidth <= viewport width; keyboard volume→fade Tab focus PASS; axe scoped to Editing controls has zero violations. Screenshot: `workspace-320-text200.png` in this directory. Layout/canonical snapshots attached to Playwright results.
- Populated controller browser test verifies canonical -3000 values, grouped bulk gain/speed/move revisions, locked selection disables all Apply/move/delete actions, keyboard Apply focus, keyboard own Delete→Undo focus, delete Undo/Redo.

## Gaps / handoff

- **Distinct-track browser fixture remains unfinished**: browser still splits two clips on one shared video track. Unit locked-target fixture now uses distinct track IDs, but this does not substitute for canonical Insert/Move creation and distinct-track browser lock evidence. No fake canonical state was introduced.
- No dedicated async failure/selection-change/pointer-focus-ring or repeated-click regression tests were added; those behaviors are implemented but not independently proven here.
- No native/Rust/render tests or builds run. No dependencies or commits. No ProgramMonitor/native/render/root-style changes.
