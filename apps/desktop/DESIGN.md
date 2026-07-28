# Desktop Design Contract

## Design read

- **Surface:** resizable, Windows-first desktop application UI with an app-level production ledger.
- **Audience:** creators shortening one local clip who also need to understand durable preview/export work, failures, and cache pressure.
- **Single job:** edit and export one local clip while keeping blocking media work observable and recoverable.
- **Risk:** draft trim and durable undo are reversible; degraded recovery, cancellation, retry, cache pressure, legacy deletion, and overwrite are consequential and expose explicit status or confirmation.
- **Content:** one real source, exact frame values, durable parent jobs with child stages, recovery notices, managed/legacy cache usage, and long safe summaries.
- **Platform:** Tauri WebView at a 480 by 360 native minimum, with 320 CSS-pixel reflow support, keyboard and pointer input, reduced motion, and Windows forced colors.
- **Constraints:** offline-first; private paths, process output, and database details stay outside Job Center DTOs; only product-owned cache paths become media URLs; no component framework or second icon family.

## Thesis

Extend the existing compact dark media workbench rather than introduce a new theme. The app-level Job Center is an in-flow production ledger directly below the global header, so opening it never obscures the monitor or blocks project access. Flat bordered surfaces, semantic edge markers, and native progress keep hierarchy legible without glass, gradients, hover lift, card proliferation, or decorative motion.

The product-specific signature is a durable media decision chain: ordered parent work reveals proxy/thumbnail child stages, exact progress, valid recovery actions, and the cache resources that can block those jobs. The existing exact-frame review rail remains the editor's primary signature.

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
- `JobCenter`: app-level and project-independent; initial loading, empty, active parent jobs, proxy/thumbnail child stages, cached completion, blocked authorization, retry delay, cancellation pending, cancelled, failed/retryable, complete, restart/database recovery, event disconnect, cache pressure/pinned pressure, and legacy empty/present/clearing/failure states. Only valid Cancel/Retry actions are enabled.
- Recovery warnings: `degraded` stays visible outside the inspector because later edits may have been lost. Job and cache recovery warnings stay visible in Job Center because blocked work or rebuilt local metadata requires review.

Draft trim, selection, playhead, prepared media, and render state are ephemeral. Apply Trim sends one strict native command group and activates only the returned projection. Undo and redo are new durable monotonic revisions rather than cursor movement.

## Keyboard and media behavior

- Space toggles prepared-proxy playback.
- Left and Right seek one frame; Shift with Left or Right seeks ten frames.
- Ctrl/Cmd+Z invokes persisted undo; Ctrl/Cmd+Shift+Z invokes persisted redo.
- Ctrl/Cmd+Alt+D toggles the in-flow Project Inspector and Close returns focus to its invoker.
- The app-header Jobs control exposes its expanded state and unsettled count. Opening focuses Job Center Close; closing returns focus to Jobs.
- Job Center uses semantic headings, an ordered parent list, nested child-stage lists, native progress, and one aggregated polite live region that excludes progress ticks.
- Legacy cleanup uses native `<dialog>` semantics, safe initial focus on Keep legacy cache, Escape/cancel, modal background behavior, and focus return to the cleanup trigger.
- Shortcuts are suppressed while an input, textarea, select, button, link, video control, or editable element owns focus.
- Native number and range inputs provide complete non-drag trim operation.
- Playback starts at trim-in if parked outside the kept range and pauses at trim-out.
- Presentation seconds are derived from exact frame/rate values and never become project authority.
- Only `proxyPath`, `thumbnailPath`, and verified `previewPath` are passed to `convertFileSrc`. Source and final export paths remain display-only evidence.
- Output collision uses native `<dialog>` semantics, initial focus on the safe action, Escape/cancel, modal background behavior, and focus return to Export.

## Responsive rules

- **1100px and wider:** Job Center uses a ledger-led two-column grid with cache health adjacent; the editor remains monitor-led below it.
- **760px to 1099px:** Job Center becomes one column, followed by the tighter monitor/inspector ratio and wrapped project actions.
- **Below 760px:** Job Center headings and child stages stack; the editor uses one semantic column in DOM order.
- **Below 480px:** the brand wordmark yields to its accessible icon label; Job Center actions, cache facts, progress, inspector headings, and dialogs become one column.
- Logical inset, margin, padding, and border properties support RTL. Long job names, IDs, cache facts, project names, and paths wrap rather than truncate essential evidence.
- Coarse pointers raise compact controls to 44px. Reduced-motion removes progress animation/transition; forced colors preserve borders, state text, selected toggle, progress, and dialog meaning.

## Support and verification matrix

| Area                                       | Automated evidence                                                                                   | Manual/real evidence                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Persistence and stale operations           | Controller, IPC, Rust replay, lock, failpoint, and hash tests                                        | Native service create/commit/undo/redo/close/reopen exact-hash recovery passed                               |
| Playback and frame boundaries              | Program monitor tests                                                                                | Current-HEAD controlled-proxy play/pause and prepared-media recovery passed                                  |
| Trim, save, undo, redo                     | Controller, component, and full workflow tests                                                       | Current-HEAD exact `[5, 50)` Apply/Undo/Redo plus unsaved-draft discard guarding passed                      |
| Export, collision, cancel, terminal states | Controller, App, component, Rust, and FFmpeg integration tests                                       | Current-HEAD verified export/reopen passed; earlier unchanged collision/cancel/process-cleanup proof remains |
| Accessibility semantics                    | Axe 4.12.1 coverage in opener/editor/inspector/recovery-warning states                               | Inspector Close focus/return, long hashes, 320px reflow, and native-window review passed                     |
| Responsive composition                     | CSS breakpoint and semantic-order implementation                                                     | Desktop, 1280×800, 480×360, 320 CSS-pixel equivalent, and 200% captures passed                               |
| Security/media containment                 | Strict IPC contracts, cache-only component tests, Rust path/security tests                           | Current-HEAD controlled proxy, relink/source-regrant, and redacted recovery states passed                    |
| Job Center and cache lifecycle             | Component/Axe plus Playwright state, focus, reflow, overflow, forced-color, and reduced-motion tests | 1280×800, 480×360, 320 CSS px at 200% text, and forced-colors captures under `evidence/phase-3/`             |

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

## Phase 3B rendered critique

Final rendered score: **23/24**. Brief specificity, hierarchy, composition, consistency, material logic, states, responsiveness, accessibility, motion, authenticity, and distinctiveness score 2; typography scores 1 because Windows font fallback layout shift was not separately measured. The first pass exposed 320px progress/action overflow and forced-colors Axe false positives; the revision constrained every job row to its grid track and runs Axe before forced-color emulation while separately asserting forced-color state geometry. The unnecessary decorative idea removed was per-job icon ornamentation beyond the single redundant state icon and semantic edge marker.

## Evidence status

Phase 2 baseline evidence remains under `apps/desktop/evidence/phase-2/`. Phase 3B Job Center evidence under `apps/desktop/evidence/phase-3/` includes 1280×800, 480×360, 320 CSS px at 200% text, and forced-colors/reduced-motion captures. Desktop TypeScript checks, all 89 focused/full Vitest tests, all 8 Chromium browser tests, Axe checks, focus return, legacy-confirmation flow, and horizontal-overflow assertions pass locally. Field performance and assistive-technology screen-reader output remain unverified; no claim is made for external exact-SHA CI.
