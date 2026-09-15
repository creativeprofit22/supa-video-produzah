# Step 7 inspector verification — 2026-09-14

Scope: finish inherited speed inspector/controller/mock work; preserve other dirty changes. This is not completion of the parent phase or browser/media verification.

## Changes and review

- Added canonical App + real `useVideoProject` + mock IPC integration in `apps/desktop/src/video/workflow.integration.test.tsx:118`: draft emits no group, Apply commits once, canonical source fields remain unchanged, Undo/Redo round-trip, Reset is only a draft until Apply, revision advances monotonically.
- Corrected workspace test to 50%: its selected source interval is 50–75 (25 frames), not 75 frames. Both 150% and 200% are inexact for that interval. No ProgramMonitor behavior or sourceLayers implementation was changed (Prettier formatted existing workspace changes).
- Added original-group context admission in `apps/desktop/src/test-video-service.ts:432`, using context-only preflight: caption detach earlier in the same group cannot bypass original managed-caption lineage. This preflight skips timing and locks, leaving those to sequential/final checks rather than rejecting intermediate overlaps or unlock-then-edit groups.
- Fixed browser fixture exact-optional callback typing with a no-op outside speed mode (`apps/desktop/browser-tests/clip-inspector.fixture.tsx:109`). Browser execution belongs to parent.
- Reread formatted new controls/helper/tests and complete tracked step-7 diff via execution `7ae0a1c5-a8e8-40d1-b166-88b61268ded0` and paged log reads. Existing unrelated changes preserved.

## Executed verification

1. Initial serial six-file Vitest run: execution `52475df5-5f08-45d3-8d02-ddf283c3c2d2`; 95 passed, workspace Apply test failed because 150% was inexact for its 25-frame selected clip.
2. Targeted Prettier write and ESLint for ClipSpeedControl + test, clip-speed-edit, ClipInspector, use-video-project + test, VideoWorkspace + test, test-video-service + test, workflow integration: execution `506baacd-9c41-4787-a6f6-a4d2f6072374`; formatting and ESLint passed. Chained desktop check found browser fixture optional callback typing, then fixed.
3. Final execution `7419e8be-7ca1-4e57-b2c6-dd6fe219a578`, exit 0:
   - `pnpm --filter @supa-video/desktop exec vitest run src/video/ClipSpeedControl.test.tsx src/video/ClipInspector.test.tsx src/use-video-project.test.tsx src/video/VideoWorkspace.test.tsx src/test-video-service.test.ts src/video/workflow.integration.test.tsx --maxWorkers=1 --no-file-parallelism`
   - **6 files, 97 tests passed**, including the new integration.
   - `pnpm --filter @supa-video/desktop check` passed all three TypeScript configurations.
   - Targeted Prettier check and ESLint for browser fixture passed.

Vitest emitted jsdom HTMLMediaElement.pause not-implemented warnings; tests passed. No screenshots, snapshots, browser execution, native execution or media playback/export verification was performed here. Original-group guard was code-reviewed against native context validation and exercised by existing context rejection tests; a dedicated detach-then-speed regression test was not added within this timebox.
