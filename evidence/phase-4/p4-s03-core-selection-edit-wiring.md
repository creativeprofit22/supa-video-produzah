# P4-S03 — Core selection and edit wiring verification

## Result

- **Status:** Passed
- **Verified:** 2026-08-04
- **Phase:** `2a90122d-4b4f-5abe-a9f2-8e99cf1f48c6`
- **Dependency:** P4-S02 commit `7292335 Add visible multitrack timeline projection`

## Typed verification runs

| Type                                 | Command                                                                                                                                                          | Result | Evidence                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Focused controller/UI/integration    | `pnpm --filter @supa-video/desktop exec vitest run src/use-video-project.test.tsx src/video/MultitrackTimeline.test.tsx src/video/workflow.integration.test.tsx` | Passed | 3 files, 28 tests passed.                                                                                        |
| Rust persistence/recovery            | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml service_split_move_trim_groups_persist_and_recover_exact_history --lib`                            | Passed | 1 focused test passed; exact state hashes, monotonic revisions, reopen, undo, and redo assertions completed.     |
| Browser accessibility/responsiveness | `pnpm --filter @supa-video/desktop test:browser -- MultitrackTimeline.spec.ts`                                                                                   | Passed | 16 browser tests passed, including the three multitrack desktop/mobile/200%-text cases with zero axe violations. |
| Required test gate                   | `pnpm test`                                                                                                                                                      | Passed | Exit 0; desktop reported 13 files and 114 tests passed, with all workspace test scripts successful.              |
| Required type gate                   | `pnpm check`                                                                                                                                                     | Passed | Exit 0 across contracts, media, project, render, desktop, Node, and browser TypeScript projects.                 |
| Required lint gate                   | `pnpm lint`                                                                                                                                                      | Passed | Exit 0 from `eslint .`.                                                                                          |
| Required format gate                 | `pnpm format:check`                                                                                                                                              | Passed | Exit 0; Prettier reported all matched files formatted.                                                           |
| Diff integrity                       | `git diff --check`                                                                                                                                               | Passed | Exit 0; only Git line-ending notices were emitted.                                                               |

## Criterion-to-evidence mapping

| Done-when criterion                                                           | Evidence                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pointer and keyboard selection share one model.                               | `VideoWorkspace.tsx` owns and reconciles one controlled `selectedClipId`; `MultitrackTimeline.test.tsx` covers pointer and keyboard activation and `aria-pressed`; Playwright verifies exactly one selected clip and focus styling.                             |
| Split, move, and trim use existing project commands.                          | `use-video-project.ts` builds existing `SplitClip`, `MoveClip`, and `TrimClip` variants through `buildProjectCommand` and `buildCommandGroup`; controller tests assert strict requests and current base revisions.                                              |
| One gesture commits one understandable undo entry; preview remains ephemeral. | Timeline tests assert no callback during pointer movement, one callback on pointer release, and none on cancellation. Workspace integration asserts one execute-group request per gesture and one grouped `TrimClip, MoveClip` request for a left trim.         |
| Command grouping, undo/redo labels, and persistence/recovery pass.            | The focused Rust test commits separate split/move/trim groups, closes/reopens, verifies exact hashes/state, and checks `Split clip`, `Moved clip`, `Applied trim`, and originating undo/redo labels. Integration tests verify grouped left-trim label behavior. |
| Required gate passes.                                                         | `pnpm test`, `pnpm check`, `pnpm lint`, and `pnpm format:check` all exited 0.                                                                                                                                                                                   |

## Changed paths

- `apps/desktop/src/use-video-project.ts`
- `apps/desktop/src/video/VideoWorkspace.tsx`
- `apps/desktop/src/video/MultitrackTimeline.tsx`
- `apps/desktop/src/App.css`
- `apps/desktop/src/test-video-service.ts`
- `apps/desktop/src/use-video-project.test.tsx`
- `apps/desktop/src/video/MultitrackTimeline.test.tsx`
- `apps/desktop/src/video/workflow.integration.test.tsx`
- `apps/desktop/src-tauri/src/video/project/tests.rs`
- `apps/desktop/browser-tests/multitrack-timeline.fixture.tsx`
- `apps/desktop/browser-tests/MultitrackTimeline.spec.ts`
- `evidence/phase-4/multitrack-timeline-desktop.png`
- `evidence/phase-4/multitrack-timeline-mobile.png`
- `evidence/phase-4/multitrack-timeline-320px-with-200%-text.png`
- `evidence/phase-4/p4-s03-core-selection-edit-wiring.md`

## Visual evidence

- `evidence/phase-4/multitrack-timeline-desktop.png`
- `evidence/phase-4/multitrack-timeline-mobile.png`
- `evidence/phase-4/multitrack-timeline-320px-with-200%-text.png`
