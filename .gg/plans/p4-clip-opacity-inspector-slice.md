# Selected video-clip opacity inspector slice

## Outcome

Ship one complete editing-inspector control: the selected **video** clip's opacity, stored as canonical `opacityPermille` (`0..1000`), edited through an undoable field-specific command, previewed in the source monitor, and compiled into the final FFmpeg render.

The existing always-visible right column becomes unambiguously the editing/control area. The current `ProjectInspector` remains a separate, toggleable, read-only diagnostic surface and is relabeled **Project diagnostics**; it is not the home of the opacity control.

## Scope boundaries

- In scope: one selected-video-clip opacity slider, empty/locked/pending/error states, canonical command execution, projection refresh, undo/redo and journal persistence, monitor compositing, render-plan/native validation, responsive/accessibility treatment, and focused tests.
- Out of scope: position, scale, rotation, crop, blend modes, keyframes, multi-selection, audio-clip opacity, editable fields in `ProjectInspector`, and a general inspector form framework.
- Opacity affects only the clip's video pixels. It does not hide the track, mute audio, suppress captions, or remove the clip from playback-clock selection. `0` means fully transparent; `1000` means fully opaque.
- Track locking remains authoritative: a selected clip on a locked video track is visible in the inspector but its opacity control is disabled with unlock guidance.

## Existing architecture findings

- Canonical state already has the required persisted field: `ClipTransform.opacityPermille` in `packages/video-contracts/src/project-v2-entities.ts`, mirrored by `ClipTransform.opacity_permille` in `apps/desktop/src-tauri/src/video/project/types.rs`, with the intended `0..1000` bound. No project format migration or default change is needed.
- `ProjectProjection` already carries the complete canonical state (`packages/video-project/src/projection.ts`; Rust projection construction in `apps/desktop/src-tauri/src/video/project/service.rs`). A successful command therefore projects opacity without adding a parallel view-model field.
- The selected clip ID is workspace-local in `apps/desktop/src/video/VideoWorkspace.tsx`; the workspace can resolve it against the active projected sequence and retain the owning track for video-only and lock checks.
- `ProgramMonitor` already renders canonical video clips as stacked `<video>` layers. It needs one per-layer opacity value and CSS opacity; z-order, hidden-track behavior, audio state, and clock selection stay unchanged.
- Final render plans contain one `videoInputs` metadata record per clip and a deterministic `filter_complex`. Both the TypeScript compiler and the Rust allowlist validator independently construct the filter, so opacity must be represented in the render-plan contract and implemented identically on both sides.
- Project snapshots already persist transforms. Command groups, inverse commands, and the journal persist command payloads, so the new command must be mirrored in TypeScript and Rust and have a field-specific inverse.

## `SetClipTransform` stale-field audit

`SetClipTransform` is a whole-object replacement. Rust currently applies it with `std::mem::replace(&mut clip.transform, transform.clone())`. If an inspector changes only opacity by spreading a transform object captured earlier, that payload can silently restore stale `position`, `scale`, `rotation`, or `crop` fields. Revision checks reject an old project revision, but they cannot detect stale fields inside a caller-supplied transform draft paired with the current revision.

Mitigation:

- Add `SetClipOpacity { commandId, sequenceId, trackId, clipId, opacityPermille }` and make the inspector/controller use it exclusively.
- Its executor changes only `clip.transform.opacityPermille`; its inverse contains only the previous opacity. This preserves every sibling transform field through apply, undo, redo, and later inspector expansion.
- Keep `SetClipTransform` unchanged for backward compatibility and intentional atomic whole-transform replacement. Add an adjacent warning/comment that single-field UI controls must use field-specific commands rather than constructing a whole transform.
- Add a regression test that seeds non-default position/scale/rotation/crop, changes opacity, and proves all sibling fields remain byte-for-byte equal through commit, undo, redo, and recovery.

## Command, history, and projection design

### TypeScript contracts

In `packages/video-contracts/src/project-commands-v2.ts`:

- Add the discriminated `SetClipOpacity` variant with UUID IDs and integer `opacityPermille` bounded to `0..1000`.
- Keep `SetClipTransform` wire-compatible and document its whole-object semantics.
- Extend `packages/video-contracts/src/project-v2.test.ts` with valid/boundary/invalid command parsing and canonical transform-bound assertions.

### Rust canonical execution

In `apps/desktop/src-tauri/src/video/project/types.rs`, `commands.rs`, and `integrity.rs`:

- Mirror the command as `SetClipOpacity { opacity_permille: u16, ... }` with existing camel-case serde behavior.
- Include it in locked-track mutation checks.
- Reject values above `1000` and non-video target tracks before mutation; IDs must still resolve to the requested sequence/track/clip.
- Capture the clip's affected timeline range, mutate only opacity, and emit a `SetClipOpacity` inverse carrying the previous value.
- Report `Updated clip opacity` and invalidate `Preview` plus `RenderPlan`, matching transform edits without invalidating audio.
- Include the variant in command-ID integrity traversal and all exhaustive matches.

`apps/desktop/src-tauri/src/video/project/tests.rs` will cover projection, sibling-field preservation, video-only/locked/range validation, exact summary and invalidations, undo/redo, stable hashes, and journal replay after an unclean reopen. Existing project projection production code should require no change; assertions against returned/reopened projections prove the path.

## Controller behavior

In `apps/desktop/src/use-video-project.ts`:

- Add a typed `setTimelineClipOpacity({ sequenceId, trackId, clipId, opacityPermille })` controller method and a `clip-opacity` edit-operation kind.
- Read the latest `stateRef.current.projection` at dispatch time, resolve the active video track and clip, enforce integer bounds and lock state, no-op when canonical opacity already matches, and reject duplicate work while an edit is pending.
- Execute one `SetClipOpacity` command group against the latest revision; existing `applyEditResult` remains the single projection/checkpoint update path.
- Return a success boolean so the workspace can retain the projected value on success and restore the canonical value after rejection/error.

`apps/desktop/src/use-video-project.test.tsx` will assert exact payload/revision IDs, no-op and pending guards, error preservation, projection refresh, and render-readiness recomputation.

## Editing-inspector UI

Create `apps/desktop/src/video/ClipInspector.tsx` and place it in the existing right-side `.inspector-column` in `VideoWorkspace.tsx`, before the trim/export controls.

### States and copy

- Heading: **Clip inspector**; section/kicker: **Video**.
- Selected video: show the clip/track identity and an **Opacity** range control.
- No selection or selected audio clip: show a concise `Select a video clip to edit its appearance.` empty state.
- Locked track: show `Unlock this track to change clip opacity.` and disable the control.
- Saving: disable the control and expose a polite `Saving opacity` status.
- Failed command: keep the canonical value, show the controller error as an alert, and allow retry after the operation leaves saving state.

### Control semantics

- Use a native `<input type="range">` with canonical `min=0`, `max=1000`, `step=1`; its associated visible `<label>` is `Opacity` and `aria-valuetext`/`<output>` expose a percentage with one decimal place (for example `42.5%`), never the raw permille value.
- Keep an ephemeral workspace draft for immediate source-monitor feedback. Pointer changes commit on pointer release; keyboard changes commit on Enter or blur, preserving native Arrow/Home/End behavior and creating one undoable command per committed interaction rather than one command per pointer event.
- The commit captures the target sequence/track/clip IDs, so a blur caused by changing selection still updates the clip that owned the draft. Projection remains authoritative; selection/projection changes reconcile the draft, and a failed commit rolls it back.
- Add visible focus treatment, at least 44px coarse-pointer target height, forced-colors support, and responsive layout inside the existing one-column sidebar behavior in `apps/desktop/src/App.css`.

### Editing vs diagnostics distinction

In `apps/desktop/src/video/ProjectInspector.tsx` and `VideoWorkspace.tsx`:

- Retain the `ProjectInspector` component and `view.toggleProjectInspector` command ID for compatibility, but change visible/accessible copy to **Project diagnostics**, `Read-only project state`, and `Toggle project diagnostics`.
- Keep diagnostics in its current separate, conditional surface above the workbench. Do not move it into the editing sidebar and do not put editable controls in it.
- Change the sidebar accessible name from generic `Project controls` to `Editing controls`; the visible `Clip inspector` heading identifies the editing surface.

## Monitor behavior

In `VideoWorkspace.tsx`, include each canonical clip's `transform.opacityPermille` in `ProgramMonitorLayer`. While the selected control has an uncommitted local draft, substitute that draft only for the matching layer.

In `apps/desktop/src/video/ProgramMonitor.tsx`, set each canonical layer's CSS `opacity` to `opacityPermille / 1000` while retaining existing `visibility` and `zIndex`. Add a `data-opacity-permille` test hook. Final-preview mode continues to show the rendered output and must not apply the source-layer opacity a second time.

`ProgramMonitor.test.tsx` and `VideoWorkspace.test.tsx` will verify full/partial/zero opacity, lower-layer reveal, selected-layer-only draft override, projection reconciliation, and no changes to hidden/audio/caption behavior.

## Final-render design

### Shared render-plan contract and TypeScript compiler

In `packages/video-contracts/src/render-plan.ts`, add required bounded `opacityPermille` metadata to each V2 `videoInput`. V2 render plans are transient and compiler/native-app versions ship together, so no persisted-project migration is needed.

In `packages/video-render/src/compile-render-plan.ts`:

- Copy `clip.transform.opacityPermille` into every video input.
- Insert `colorchannelmixer=aa=<alpha>` after `format=rgba` in each visible clip branch, with alpha formatted deterministically from integer permille as exactly `0.000..1.000` (no floating-point/string-locale dependence).
- Keep hidden clips out of the visual branch, keep clip audio independent of opacity, and leave caption filters after video compositing.

`packages/video-contracts/src/contracts.test.ts` and `packages/video-render/src/compile-render-plan.test.ts` will cover schema bounds, exact input metadata, exact filter strings at `0`, partial, and `1000`, stacked layer order, hidden clips, and audio independence.

### Native render allowlist

In `apps/desktop/src-tauri/src/video/types.rs` and `render.rs`:

- Mirror `opacity_permille` in `RenderVideoInput`.
- Validate `<= 1000` as part of V2 input validation.
- Reconstruct the same `colorchannelmixer=aa=X.XXX` segment using integer formatting before comparing the supplied FFmpeg argument vector.
- Continue rejecting any plan whose metadata, derived filter, or supplied arguments disagree.

`apps/desktop/src-tauri/src/video/tests.rs` will prove valid partial opacity passes, out-of-range metadata fails, tampered/missing alpha filters fail, zero-opacity video may retain audible audio, and filter ordering remains allowlisted.

## Verification strategy

Focused automated checks:

1. Contract and render tests for command/render-plan schemas and deterministic FFmpeg compilation.
2. Rust project tests for field-level mutation, invalid targets, history, hashes, and journal recovery.
3. Rust render tests for metadata bounds and argument allowlisting.
4. Desktop controller/component/workspace/monitor tests for dispatch, draft reconciliation, accessibility states, and monitor behavior.
5. Type checks and lint for all touched workspaces, followed by the relevant complete package test suites.

Add a small Playwright fixture under `apps/desktop/browser-tests/` for `ClipInspector` rather than requiring a native project session. At desktop and narrow widths it will run axe, verify keyboard range changes and percentage announcements, locked/pending/error states, focus visibility, no horizontal overflow, and capture screenshots for visual inspection against the existing product's typography, panel, spacing, and focus conventions.

## Risks and controls

- **Render/native drift:** one integer formatter and exact-string tests on each side prevent TypeScript and Rust filter divergence.
- **Async draft races:** capture clip identity at commit, gate a second canonical edit while saving, and reconcile only from the newest projection; rollback uses that projection rather than an old prop.
- **Stale transform overwrite:** the inspector never emits `SetClipTransform`; regression tests preserve every sibling transform field.
- **Opacity confused with visibility:** labels and tests keep `opacity=0`, track hidden, and audio mute as separate semantics.
- **Accessibility regression from custom sliders:** use the native range element, an explicit label/output, canonical keyboard behavior, and axe/forced-colors/coarse-pointer checks.

## Steps

1. Extend the TypeScript command contract with bounded `SetClipOpacity`, document whole-object `SetClipTransform` semantics, and add contract boundary tests without changing the persisted project schema.
2. Implement and test Rust `SetClipOpacity` validation, video/lock targeting, field-only mutation, inverse generation, affected range, summary, and cache invalidations.
3. Add Rust service coverage proving projected opacity, sibling-transform preservation, undo/redo hashes, and journal recovery after reopen.
4. Extend the V2 render-plan contract and TypeScript compiler with per-input opacity metadata and deterministic `colorchannelmixer` filters, then add exact compiler/schema tests.
5. Mirror opacity metadata, bounds, deterministic filter reconstruction, and tamper rejection in the native Rust render allowlist and tests.
6. Add the controller's latest-projection `setTimelineClipOpacity` operation with no-op, lock, pending, error, and refresh tests.
7. Thread canonical and selected-draft opacity through `VideoWorkspace` into `ProgramMonitor`, apply source-layer CSS opacity, and cover partial/zero/hidden/audio/final-preview behavior in tests.
8. Build the accessible `ClipInspector` range control and workspace draft/commit/rollback flow, place it in the editing sidebar, and add focused component/workspace tests and responsive styles.
9. Relabel the existing toggleable `ProjectInspector` as read-only Project diagnostics and update accessible names/tests so it remains distinct from the editing inspector.
10. Add the ClipInspector Playwright accessibility/responsive fixture, inspect desktop and narrow screenshots, then run formatting, touched-package tests, Rust tests, type checks, and lint.