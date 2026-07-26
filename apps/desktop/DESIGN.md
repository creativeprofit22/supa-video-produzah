# Desktop Design Contract

## Design read

- **Surface:** resizable, Windows-first desktop application UI.
- **Audience:** creators shortening one local clip with pointer, keyboard, or assistive technology.
- **Single job:** choose one source, set an exact kept range, and export a verified MP4.
- **Risk:** draft trim and durable undo are reversible; degraded recovery, long renders, cancellation, and overwrite are consequential and expose explicit status or confirmation.
- **Content:** one real source, one controlled proxy, one thumbnail track, exact frame values, immutable revision/hash identity, journal and recovery health, export progress, and long local names or destinations.
- **Platform:** Tauri WebView at a 480 by 360 native minimum, with 320 CSS-pixel reflow support, keyboard and pointer input, reduced motion, and Windows forced colors.
- **Constraints:** offline-first; source and final output paths stay outside the asset protocol; only product-owned cache paths become media URLs; no component framework or second icon family.

## Thesis

Extend the existing compact dark media workbench rather than introduce a new theme. The program monitor is the first visual anchor, the one-track timeline is second, exact trim controls are adjacent, and Export remains the primary consequential action. Flat bordered surfaces keep hierarchy legible around video without glass, gradients, hover lift, card proliferation, or decorative motion.

The product-specific signature is the exact-frame review rail: monitor, half-open kept range, frame playhead, persisted trim controls, and verified output facts remain visible as one editing decision chain.

## Reuse map

| Role     | Reused implementation                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| Type     | Self-hosted Geist Variable for interface text and Geist Mono for frame values, revisions, rates, and media facts      |
| Icons    | Lucide React only, with visible labels for unfamiliar actions                                                         |
| Color    | Existing near-black page, neutral media surfaces, acid-green action/focus accent, isolated danger and success markers |
| Geometry | One shared 1440px rail, responsive logical gutters, 10px panel radius, 8px control radius, 1px neutral borders        |
| Buttons  | Existing primary, secondary, danger, pending spinner, disabled, hover, press, and focus-visible anatomy               |
| Status   | Neutral bordered status surfaces with icon plus text; errors add a danger edge and recovery copy                      |
| Motion   | Named 100ms and 160ms productive transitions; no `transition: all`; reduced motion removes spinners and transitions   |

## Component and state model

- `VideoProjectOpener`: loading, tool-ready, missing-tool, tool-check failure, project pending, cancellation, malformed/open/save failure.
- `VideoWorkspace`: active project name, source status, save state, stable New/Open order, and operation errors without private paths.
- `AssetPanel`: empty, resolved, missing, relink-required, preparation pending, preparation failure, and retry.
- `ProgramMonitor`: controlled proxy, verified final preview, play/pause, frame seek, trim boundary clamp, missing media, media error, and retry.
- `SingleClipTimeline`: controlled thumbnail, missing thumbnail, kept-range projection, frame playhead, pointer seek, and two native range alternatives.
- `TrimInspector`: exact numeric frame inputs, validation, unchanged state, save pending, save failure, Apply, bounded Undo, and Redo.
- `ExportPanel`: idle, destination pending/error, starting, running, cancelling, cancellation failure, cancelled, failed/retry, collision dialog, success, and saved-output preview warning.
- `ProjectInspector`: hidden by default; in-flow revision number/ID/hash, last command/group, snapshot revision, journal health, and the last open's recovery status, recovered revision, replay count, formatted discarded-tail size, sanitized message, and legacy-history outcome. It keeps a visible Close, wraps long values, and exposes no private paths or raw journal data.
- Recovery warnings: `degraded` stays visible outside the inspector because later edits may have been lost. A V1 migration with `legacyHistoryReset` also stays visible because the reset is irreversible. Clean, recovered, and recreated-journal detail remains diagnostic in the inspector.

Draft trim, selection, playhead, prepared media, and render state are ephemeral. Apply Trim sends one strict native command group and activates only the returned projection. Undo and redo are new durable monotonic revisions rather than cursor movement.

## Keyboard and media behavior

- Space toggles prepared-proxy playback.
- Left and Right seek one frame; Shift with Left or Right seeks ten frames.
- Ctrl/Cmd+Z invokes persisted undo; Ctrl/Cmd+Shift+Z invokes persisted redo.
- Ctrl/Cmd+Alt+D toggles the in-flow Project Inspector and Close returns focus to its invoker.
- Shortcuts are suppressed while an input, textarea, select, button, link, video control, or editable element owns focus.
- Native number and range inputs provide complete non-drag trim operation.
- Playback starts at trim-in if parked outside the kept range and pauses at trim-out.
- Presentation seconds are derived from exact frame/rate values and never become project authority.
- Only `proxyPath`, `thumbnailPath`, and verified `previewPath` are passed to `convertFileSrc`. Source and final export paths remain display-only evidence.
- Output collision uses native `<dialog>` semantics, initial focus on the safe action, Escape/cancel, modal background behavior, and focus return to Export.

## Responsive rules

- **1100px and wider:** monitor-led two-column workbench with timeline beneath the monitor and the project controls in the adjacent inspector.
- **760px to 1099px:** the same task relationship uses a tighter monitor/inspector ratio and wrapped project actions.
- **Below 760px:** one semantic column in DOM order: project, optional inspector, monitor, timeline, source, trim, export; inspector facts use two columns.
- **Below 480px:** inspector and panel headings/actions stack, diagnostic facts and exact fields become one column, transport remains reachable, and dialogs use full available width.
- Logical inset, margin, padding, and border properties support RTL. Long names and paths use wrapping rather than truncating essential evidence.
- Coarse pointers raise compact controls to 44px. Reduced-motion and forced-colors modes retain state meaning without decorative effects.

## Support and verification matrix

| Area                                       | Automated evidence                                                         | Manual/real evidence                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Persistence and stale operations           | Controller, IPC, Rust replay, lock, failpoint, and hash tests              | Native service create/commit/undo/redo/close/reopen exact-hash recovery passed                               |
| Playback and frame boundaries              | Program monitor tests                                                      | Current-HEAD controlled-proxy play/pause and prepared-media recovery passed                                  |
| Trim, save, undo, redo                     | Controller, component, and full workflow tests                             | Current-HEAD exact `[5, 50)` Apply/Undo/Redo plus unsaved-draft discard guarding passed                      |
| Export, collision, cancel, terminal states | Controller, App, component, Rust, and FFmpeg integration tests             | Current-HEAD verified export/reopen passed; earlier unchanged collision/cancel/process-cleanup proof remains |
| Accessibility semantics                    | Axe 4.12.1 coverage in opener/editor/inspector/recovery-warning states     | Inspector Close focus/return, long hashes, 320px reflow, and native-window review passed                     |
| Responsive composition                     | CSS breakpoint and semantic-order implementation                           | Desktop, 1280×800, 480×360, 320 CSS-pixel equivalent, and 200% captures passed                               |
| Security/media containment                 | Strict IPC contracts, cache-only component tests, Rust path/security tests | Current-HEAD controlled proxy, relink/source-regrant, and redacted recovery states passed                    |

## Production-contract checklist

| Contract                                                                    | Status                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Native semantic controls, landmarks, headings, labels, progress, and dialog | Passed by source/component tests, axe, and real keyboard/dialog flow         |
| Save-before-activation and recoverable async failures                       | Passed                                                                       |
| No drag-only edit                                                           | Passed through numeric and native range controls                             |
| Visible keyboard focus and 24px minimum targets                             | Passed source rules, component tests, and rendered focus review              |
| 44px primary and coarse-pointer targets                                     | Passed CSS contract and rendered review                                      |
| Shared rail and semantic responsive order                                   | Passed desktop, minimum-window, 320px-equivalent, and 200% captures          |
| Reduced motion and forced colors                                            | Passed explicit CSS contracts and color-independent text/icon states         |
| Long/localized/RTL content resilience                                       | Passed logical-property/wrapping contract and narrow/200% stress evidence    |
| No raw private diagnostics or uncontrolled media URL conversion             | Passed by adapter, component, integration, and real recovery evidence        |
| Runtime performance                                                         | 2.9 ms p95 durable command acknowledgment; 656 ms generated 10k journal scan |

## Evidence status

Phase 2 local gates pass on baseline `a0a636995a453789b46640512aa9bccb4ed89c31`. Sanitized evidence under `apps/desktop/evidence/phase-2/` includes native opener captures, inspector desktop/narrow/320px captures, exact-hash recovery facts, test counts, and performance measurements. No external CI run exists for the uncommitted implementation worktree.
