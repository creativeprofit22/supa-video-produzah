# Selected clip source range — 2026-09-14

Implemented canonical direct-asset video/audio source range inspector alongside appearance/audio controls. Source in/out are source-frame values with rational fps labels and exclusive out. Metadata uses microsecondsToSourceFrames at the clip source rate, the existing exact integer helper (including its established duration endpoint policy), not floating-point source boundary arithmetic. Drafts are local and command-free; Reset draft discards back to canonical; selection/revision changes clear drafts. Saving/locked controls are disabled, status is ARIA live, focus repair is requested only by keyboard Apply and only when focus fell to document body. Nested sequence context explicitly reports unsupported.

Apply passes the unchanged canonical timelineStartFrame to trimTimelineClip, producing no implicit MoveClip. Controller retains command-group, caption lifecycle, stale revision, inverse/recovery authority. Added preflight lock, source asset bound and existing-fade duration checks inside its existing error lifecycle. Exact speed duration mapping continues through clipTimelineDuration; no range rounding/clamping.

## Verification actually run

- `pnpm --filter @supa-video/desktop check`: PASS (app, node, browser TS configurations), after production and test additions. Last subsequent edit only corrected a test expected source-in value from 0 to fixture's 50.
- `pnpm --filter @supa-video/desktop exec vitest run src/video/ClipSourceRangeInspector.test.tsx src/video/VideoWorkspace.test.tsx src/use-video-project.test.tsx src/video/ClipInspector.test.tsx --maxWorkers=1 --no-file-parallelism`: PASS, 4 files / 70 tests, 15.15 seconds final run.
- Added control/helper coverage: bounds/fractions/positive range, exact speed mapping, fade overflow, command-free drafts, canonical reset, single submission, unchanged start, revision reset, lock/saving, nested unsupported.
- Added workspace integration: no legacy draft or canonical command during draft; canonical trim Apply; unchanged start; revision discard.
- Added controller coverage: bounds, lock, fade overflow produce errors without backend groups. Existing caption lifecycle/group/undo/stale transcript and speed/appearance tests passed in focused suites.
- Initial new control run lacked jsdom annotation; fixed. Workspace test initially assumed source-in 0 instead of fixture canonical 50; corrected. Final focused run green.

## Gaps / scope

No real-browser run within time budget; keyboard-vs-pointer focus repair needs scoped browser verification. Dedicated audio source-range integration and source-range-specific later-clip/undo/recovery end-to-end cases were not newly added; canonical existing controller machinery remains in use. No Rust/native builds, dependencies, commits, roadmap edits, ProgramMonitor/render/native implementation edits, or legacy TrimInspector changes.
