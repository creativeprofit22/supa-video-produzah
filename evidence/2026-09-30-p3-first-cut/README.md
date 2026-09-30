# P3 evidence: reviewable first-cut production (source Phase 8)

Every result here comes from an automated run on 2026-09-30. Nothing was checked by hand.

## Prerequisites (Phases 5, 6, 7)

- Transcription and audio: `evidence/2026-09-28-p3-transcription-audio/`
- Approvals (proposal review, apply, restore): `evidence/2026-09-29-p3-agent-proposals/`
- Rights-safe acquisition (receipts, policy, release gate): `evidence/phase-7/`

## Fixture runs: `run-fixtures.mjs`

Command: `pnpm --filter @supa-video/produce build && node evidence/2026-09-30-p3-first-cut/run-fixtures.mjs`

The script runs each versioned fixture (`packages/video-produce/fixtures/v1/`) twice. It writes the proposal and compiled command group (`*-proposal.json`) and `summary.json`, and exits non-zero if any check fails.

| Fixture | Beats | Covered | Unresolved | Duration vs plan | Two runs identical |
|---|---|---|---|---|---|
| explainer (Spanish script, English/German media names) | 9 | 7 | 2 (map, "ciudad" must-show) | 27.8 s = 27.8 s | yes |
| podcast (German A-roll transcript) | 5 | 5 (3 A-roll, 2 cutaways) | 0 | 18.2 s = 18.2 s | yes |

The explainer's rights audit rejects the media it should, and none of it appears as a shot or alternative:

- unknown license (`use-blocked`)
- NC under commercial use (`use-blocked`)
- withdrawn upstream (`upstream-withdrawn`)
- stale evidence (`refresh-stale`)

The podcast fixture's unknown-license microphone clip is likewise never offered.

## Automated tests covering the criteria

- `packages/video-produce` (vitest, 80 tests) covers:
  - rights hard filters: unknown, NC/commercial, withdrawn, changed, stale, receipt mismatch, missing receipt
  - must-show and must-not-show (including translations), orientation
  - reuse limit, near-duplicate windows, duplicate imports offered once
  - provider and visual-cluster diversity
  - multilingual normalization (es/de/fr/pt)
  - explanations on every offered shot
  - determinism: same bytes, shuffled inputs, config-version sensitivity
  - coverage and duration
  - model beat-plan rejection and clamping
  - compiled timeline invariants
  - golden explainer and podcast outputs
- Native apply→undo (`cargo test --lib first_cut`, 2 tests): the golden compiled groups are committed through the real Rust transactional path (`commit_transition`). The snapshot validates, existing tracks and markers are unchanged, and one `undo_transition` restores the original state and state hash.
- Desktop (vitest):
  - `ProducePanel.test.tsx` (6): plan, review, override, apply, stale-revision block, podcast.
  - `workflow.integration.test.tsx`, "first-cut production workflow" (2): explainer and podcast plan → review → apply through `video_execute_project_group` → undo restores state.
  - `accessibility.test.tsx`: axe, zero violations on the empty and the reviewed panel.

## Not included

- No screenshot. The Produce panel needs an open project from the Tauri backend, and no headless Tauri launch is available in this environment. The DOM-level workflow and axe tests above exercise the same component.
