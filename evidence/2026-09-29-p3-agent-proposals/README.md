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

## Not done / open

- **Criterion 1 not met**: production agent mutation remains disabled because Phase 4 (P2 editor controls) is still needs-attention (live timing, human keyboard and assistive-technology checks).
- Real Tauri app with the switch on (`01-proposals-native-scenario.md`): propose, partial apply, restore, stale, reject and pending-after-restart all pass. **The app close is intermittently ignored (4 of 11 runs)**: native window destroy fails with `failed to send message to the webview`. The cause isn't identified and it isn't fixed.
- No manual screen-reader test of the review panel.
- AI producer is out of scope (separate draft `2ceb2ea5-…`).
