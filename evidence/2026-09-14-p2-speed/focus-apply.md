# Speed Apply keyboard focus completion — 2026-09-14

## Actual result

Reproduced the gap before implementation. Replaced S9-01's forced `Reset speed.focus()` with a real `Speed (%).toBeFocused()` assertion following Enter Apply and revision adoption. Ran:

`pnpm --filter @supa-video/desktop test:browser browser-tests/ClipSpeedControl.spec.ts -g S9-01`

Result: **1 failed** at `ClipSpeedControl.spec.ts:45`: expected focused, received inactive after revision 1, commit 1, canonical value 150. This directly demonstrated lost useful focus; the failure assertion did not separately log the active element's tag. The previous test forcibly focused Reset and masked this completion gap.

Implemented a one-shot, selection-scoped return-focus ref in the unkeyed inspector, following the existing component-ref/effect focus pattern. The keyed speed child reports keyboard versus pointer activation and exposes its input ref. Completion waits until saving/disabled/locked gates clear; selection changes cancel the request. Restoration only repairs body focus, never replaces another focused control. Pointer Apply clears the request. No document listeners, autofocus, global suppression, draft caching, or relaxed saving gates. The selection/revision child key remains unchanged.

## Exact tests changed

- `apps/desktop/browser-tests/ClipSpeedControl.spec.ts`, **S9-01 keyboard draft, one Apply, reset and fixture undo**: asserts speed input focus after both successful keyboard Applies; reaches Reset with five actual Tabs instead of `.focus()`.
- Same file, **S9-02 invalid, inexact, locked, pending and save-error states**: submits failure using Tab/Enter, verifies input and Apply disabled during saving, input focused and editable afterward, then edits using only keyboard and verifies Apply enabled.
- Same file, **S9-03 selection and external revision discard stale drafts**: preserves stale-draft assertions; verifies selection/external-revision buttons retain focus, selection during pending keyboard save does not steal focus on completion, and pointer Apply plus subsequent revision does not focus input/Apply.
- `apps/desktop/src/video/ClipSpeedControl.test.tsx`, **keeps drafts local, validates exact duration, applies deliberately and resets as a draft**: updates exact callback expectation for the keyboard-origin argument (synthetic click detail zero).
- Inspector unit tests and all four S9-04 accessibility/overflow tests are unchanged.

## Verification

All completed successfully after implementation:

- `pnpm --filter @supa-video/desktop test:browser browser-tests/ClipSpeedControl.spec.ts` — **7 passed**, including four axe/overflow/rendered modes; existing screenshot outputs refreshed by those tests.
- `pnpm --filter @supa-video/desktop test src/video/ClipInspector.test.tsx src/video/ClipSpeedControl.test.tsx` — **11 passed**, 2 files.
- `pnpm --filter @supa-video/desktop check` — desktop, node, browser TypeScript checks passed.
- `pnpm exec eslint apps/desktop/src/video/ClipSpeedControl.tsx apps/desktop/src/video/ClipInspector.tsx apps/desktop/src/video/ClipSpeedControl.test.tsx apps/desktop/browser-tests/ClipSpeedControl.spec.ts` — passed.
- `pnpm exec prettier --check apps/desktop/src/video/ClipSpeedControl.tsx apps/desktop/src/video/ClipInspector.tsx apps/desktop/src/video/ClipSpeedControl.test.tsx apps/desktop/browser-tests/ClipSpeedControl.spec.ts` — passed.
- `git diff --check` — passed (existing unrelated CRLF notices only).
- Reread modified inspector focus effect/wiring, speed control, and browser focus assertions after checks.

No dependencies, commits, roadmap, ProgramMonitor, native code, or browser fixture changes made by this task. Browser evidence uses the existing asynchronous inspector fixture, not packaged native execution; the parent's working-capture blocker is outside this fix and is not claimed resolved.
