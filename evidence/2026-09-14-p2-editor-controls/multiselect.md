# Bounded multiselect — partial Phase 4 delivery

## Implemented
- Ephemeral React selection IDs and primary ID, never written to project state or commands. New-project activation retains initial single selection; subsequent canonical revisions only prune missing IDs, including preserving explicit empty selection.
- Direct asset video/audio ctrl/cmd toggle and shift range in track order, then timeline-start order. Native keyboard-accessible Select buttons expose aria-pressed; live selection count and Clear selection. More than 100 IDs produces an explicit error without changing selection.
- Existing virtualized rendering retained; no all-clips DOM. Multi-selection disables single-clip timeline editing by passing no primary edit target, suppresses trim handles/pointer drags, and hides incompatible single inspectors without modifying transform/opacity policy.
- Common gain and sequence-frame fades inspector shows blank mixed fields, preserving per-target values when unchanged. One Apply invokes existing controller audio bulk method once.
- Controller audio preparation uses cloned state, validates every target (including locked, direct media/audio, duplicates and fades), rejects >100 selected targets or >100 generated commands explicitly, and submits one group through existing runTimelineEdit/native authority. No chunking or intermediate overlap simulation. Changing both gain and fades on 100 clips can exceed the native command bound and is explicitly rejected rather than partly applied.

## Actual verification
- `pnpm --filter @supa-video/desktop check` passed after changes (all three TS configurations).
- `pnpm --filter @supa-video/desktop test src/video/clip-selection.test.ts src/video/MultiClipInspector.test.tsx` passed: 5 tests. Covers range/toggle/100 bound, prune-only-missing/empty state, mixed preservation/one callback, locked-selection UI blocking.
- Earlier focused invocation additionally ran `src/video/MultitrackTimeline.test.tsx` (19 passed, including virtualization-bound test) and `src/video/VideoWorkspace.test.tsx` (9 passed). New inspector tests initially failed for missing jsdom directive; fixed and rerun successfully as above.
- No Rust, full suite, browser tests, dependencies, commits, or roadmap changes.

## Precise remaining gaps for parent
- Bulk speed, signed-relative move, and non-ripple history-backed delete are NOT implemented. Inspector explicitly states these batch operations are unsupported. Existing single-clip speed/timing lifecycle remains unchanged; no managed-caption detachment was added.
- Controller atomic multi-inverse/mock integration tests were NOT added/run. Native group atomicity/history authority is reused, not newly proven here.
- No new browser keyboard integration or workspace multiselect/revision integration tests; selection reducer and mixed inspector tests cover logic, while native button keyboard activation is used. No new screenshots/accessibility audit.
- ARIA selection is conveyed via valid toggle-button aria-pressed and live count, not listbox aria-selected.
- Visual layout of extra per-visible-clip Select buttons needs browser review, especially very narrow clips.
- Full Phase 4 is not claimed complete; parent should complete speed and remaining batch controls plus integration coverage.
