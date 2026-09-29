# P3 · Agent proposals and approvals — evidence (2026-09-29)

Phase `d8678665-904d-4bd7-a4b2-7a4bf2eedd95`. Infrastructure built and tested; **production agent mutation stays off** (`agentProposals` switch, enabled only by `SUPA_VIDEO_AGENT_PROPOSALS=1`).

## What exists

- Producer interface with provenance (`packages/video-project/src/proposal-producer.ts`); every proposal records `producer { id, version, kind, parameters }`.
- Proposal schema v2 (producer + non-speech gap cuts); v1 still parsed and upgraded as "user selection".
- Rules: `silence-gap` (word-timing pauses, padded) and `filler-words` (conservative per-language list, exact token, repeated-token guard).
- Pure lifecycle: statuses and transitions, scope, expiry (TTL with injected clock + revision drift), partial approval re-derived against the current base, bounded repair then stale.
- Native: validation (schema, producer, project, base revision, command policy, scope, locked tracks), durable pending-proposal store beside the journal (atomic write + hash, tampered store set aside), audit records, journal `proposalAudit` on the commit record (absent for ordinary edits, so old record hashes are unchanged), pre-apply checkpoint, "restore to before proposal" as ordinary redoable undo steps, crash reconciliation from the journal.
- IPC: status, list, submit, apply (full/partial), reject, restore — all fail closed when the switch is off.
- Review UI: producer label, per-cut checkboxes, timeline bands (solid = will cut, dashed = kept), apply/reject, out-of-date notice, recent history with restore.

## Gates (this session)

| Gate | Result |
|---|---|
| `pnpm check` | pass |
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm test` | pass (contracts 288, media 48, render 88, project 213, desktop 451). The earlier parallel failures were load-induced timeouts in full-app tests (5/5 reproduced) and were fixed in `2529099` (3/3 passed after). |
| `cargo fmt --check` | pass |
| `cargo clippy --all-targets --all-features -D warnings` | pass |
| `cargo test --features tauri-ipc-test` | pass (481 + 5, 22 ignored pre-existing) |
| Playwright: ProposalsPanel, TranscriptPanel, MultitrackTimeline, VideoWorkspace | 33 passed |

Screenshots: `proposals-review.png` (desktop), `proposals-320px-200-percent-text.png`.

## Criteria

- **Criterion 1 met**: the required Phase 2, 4 and 5 capabilities are done with current evidence. P2 editor controls (Phase 4) closed at roadmap revision 237 (`evidence/2026-09-29-p2-editor-controls-close/`), and P3 transcription and audio (Phase 5) is done.
- Criteria 2 and 3: see "What exists" and the gate table above. Real Tauri app with the switch on (`01-proposals-native-scenario.md`): propose, partial apply, restore, stale, reject and pending-after-restart all pass (6 of 6 runs). An earlier intermittent "close ignored" failure turned out to be the harness closing Tao's hidden message window instead of the app window. That's fixed in the harness; there's no app bug.

## Known limits

- The `agentProposals` switch stays **off by default**. Production agent mutation is only enabled with `SUPA_VIDEO_AGENT_PROPOSALS=1`. This is a deliberate default, not a gap.
- The real-app scenario ran on a debug build with the switch on. The production build and installer weren't exercised.
- AI producer is out of scope (separate draft `2ceb2ea5-…`).
