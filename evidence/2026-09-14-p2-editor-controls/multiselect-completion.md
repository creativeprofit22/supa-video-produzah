# Multiselect completion handoff — 2026-09-14

Implemented direct-video bulk speed draft/reset/apply, signed sequence-frame relative move, and non-ripple RemoveClip deletion in the multi inspector and existing canonical controller group path. No native commands, other inspectors, ProgramMonitor, layout, dependencies, commits, or file deletion changed.

## Evidence

- `apps/desktop/src/video/bulk-clip-edit.ts:7`: bounded 100-target planner, one cloned snapshot and indexed target lookup; original-target command construction, final schema/overlap validation only. Locked/duplicate/stale targets reject all. Managed caption contexts and nested source/child contexts explicitly unsupported (conservative sequence-wide managed caption rejection).
- `apps/desktop/src/use-video-project.ts:1501`: controller delegates one group through existing runTimelineEdit pending/stale/adoption/history path.
- `apps/desktop/src/video/MultiClipInspector.tsx:10`: mixed speed draft, reset to 100%, explicit audio unsupported, signed move, undoable N-clips delete, local repeat-submit guard. Existing bulk audio retained.
- `apps/desktop/src/video/VideoWorkspace.tsx:194`: target speed/video metadata; existing revision/selection keyed inspector reset and selection pruning after adoption retained.
- `apps/desktop/src/test-video-service.ts:545`: mock now actually removes clips rather than silently ignoring RemoveClip; existing snapshot-based mock history restores them.
- `apps/desktop/src/test-video-service.test.ts:87`: integration exercises adjacent move (no intermediate overlap rejection), speed, delete, gain/fades, actual values, undo/redo, immutable planning, negative delta, stale target/revision, locked-selection rejection.

## Verification actually run

- `pnpm --filter @supa-video/desktop check` passed all three TS configurations after implementation/UI wiring, before final mock/test additions.
- `pnpm --filter @supa-video/desktop exec vitest run src/test-video-service.test.ts src/use-video-project.test.tsx src/video/MultiClipInspector.test.tsx src/video/clip-selection.test.ts --maxWorkers=1 --no-file-parallelism`: 16 tests passed across mock integration (11), inspector (2), selection (3). Overall exit 1: controller test worker failed to start (Vitest forks timeout), not an assertion failure. Command took 205 seconds. No Rust run.

## Exact remaining gaps for parent

1. Rerun TS check after mock/test additions; rerun controller suite after resolving worker startup timeout. No new bulk-controller-specific test was added yet.
2. Add new UI tests for mixed-speed/reset/nonmutating draft and repeat Apply pending guard (existing audio UI tests pass).
3. Add managed-caption/nested factory fixture rejection tests, final-overlap/out-of-bounds and 100-command boundary tests, and explicit mixed locked-target backend rollback test. Current new locked assertion is planner-level; stale revision is backend-level.
4. Strict O(project+selection) is not fully achieved: planner clones only once and indexes lookup, but final overlap check sorts each affected track, O(n log n); existing bulk audio and UI target derivation retain repeated scans; mock speed helper still clones per command.
5. Native inverse behavior is reused via canonical RemoveClip, not independently verified (Rust explicitly not run). Mock undo/redo is snapshot history, not native inverse execution.
6. Managed-caption/nested bulk timing and deletion are deliberately unsupported with descriptive rejection, not claimed finished for those contexts. No lifecycle detachment occurs.
