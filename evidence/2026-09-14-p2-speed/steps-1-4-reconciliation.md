# Approved speed plan — steps 1–4 reconciliation

14 September 2026. User authorized reconciliation of earlier canonical steps and retry of step 5, stopping before step 6. No source, assertions, dependencies or runner configuration changed. This is not completion of speed or the editor-controls phase.

Plan: `77dce439-7822-4159-8c8a-d6ea5b50ec81`, approved snapshot `.gg/plans/approved/77dce439-7822-4159-8c8a-d6ea5b50ec81.md`, hash `e1803d381687055114e5855729faeadb0b8434beebe4a636176ac644f2815fec`.

## Snapshot and method

Binding inspection is consistent with current session `7c268fbe-a57c-4f65-bcc1-a41035d22676`. Read-only canonical metadata inspection `788c42e9-47cd-44ee-9e8c-d0a892e41cb9` confirmed pending steps and exact IDs; no Notes file was written directly.

HEAD remains `b21a303c51c258d3aa63fa51217bcbb4508fef0f`. Recomputed tracked binary diff hash `87bbc40b3fd7ea3fd14571408b80a4d30894d020b376e90ece4b88bf30730642` matches the preceding step-5 audit. Historical starting/preserved boundaries remain in README and step-5-consumer-audit.md. Untracked source was read separately; a tracked diff hash does not cover those files.

Current hashes from the same execution:

- `scripts/probe-speed-preview.mjs`: `553a70dd8c8b24091549fb7d781f35d5f7224a6137b0c0bcb6397498e45c24f2`.
- `speed_persistence_tests.rs`: `b31691ccd8be9a3b8e19d9a27068f92a81c82c032173ddb69f9c0c05017d446c`.
- `clip_speed.rs`: `9535d009fbda974549b799d1b1af2d0fe4cd7823e48fa47a5e23b5fa46c75803`, matches the step-3 execution report.
- TS `clip-timing.ts`: `d05d4ee63cdbce51a6b63ebe73c8a9a69e0db557d8eefafc649103ef7b1acf5c`, matches the original shared-helper evidence.

Approved step text and historical reports were read, then assessed against current source/tests. Full 257-line current TS clip/command schema and Rust project types diff was read from execution `97d41624-7031-4186-b562-1455a0022610`, not its terminal tail. Earlier complete command/integrity consumer diffs and native speed implementation reads from this conversation are reused. The 334-line real-storage speed test file was reread in full. No broader independent code/security audit is claimed.

## Criterion decisions

### Step 1 — satisfied

Canonical ID: `70b93f152c5f687c6b7414dcc15a37e92967b38a5e799db30337783cbb0ab667`.

README lines 3–32 record the original snapshot, named preserved dirty boundaries, package/desktop/native focused baseline executions, bundled filter help and actual browser capability probe. Those are historical baseline observations, not newly rerun original-tree tests. Current snapshot identity is recorded above.

Fresh execution `496311aa-1b9e-4360-993f-61beaa603856`, exit 0: `node scripts/probe-speed-preview.mjs` followed by bundled FFmpeg `-hide_banner -h filter=atempo`, `setpts`, `asetpts` via `&&`. Each filter reports exit 0. Atempo supports 0.5–100; approved product range stays 0.5–2. The unchanged local synthetic probe uses Chromium 151.0.7922.34, generated 440 Hz PCM and Web Audio FFT. Preserved-pitch peaks are 439.453125 Hz at 0.5/1/1.5/2x; measured rates 0.477016/1.013127/1.445736/1.991398. Disabled-preservation controls peak at 219.7265625/439.453125/660.64453125/880.37109375 Hz. Existing 1% pitch and 10% capability-only rate tolerances pass unchanged.

This establishes capability, not production ProgramMonitor, video-frame cadence, Windows WebView, hardware audio capture or preview/export parity. These remain later gates.

### Step 2 — satisfied

Canonical ID: `1ab68fd1b571f51299e9354152632738ee6997c2cbaac959bbc76bc80c0b0070`.

Current optional clip speed and required command speed use bounded reduced rational validation; Rust omits absent speed and rejects explicit null on a clip. The private inverse separately requires nullable speed to restore the exact earlier representation. Shared exact-time helpers cancel factors before division, reject inexact edit boundaries and enforce bounded products/results. Shared fixtures exercise exact/inexact, mixed/fractional rates, invalid ranges and overflow. Existing compatibility tests assert legacy snapshot bytes/state hashes, explicit normal representation, migrated source timing and omission. Current tests include those cases; later step-3/5 native execution and projection replace historical temporary admission guards without invalidating these criteria.

Historical implementation checks and failures are preserved in README and step-2-contracts.md. The preceding continuation's package execution `18a23567-0739-4ac5-b14d-a51815cd5af0` passed 261 contracts +137 project +34 render tests after dependency rebuild. Those are prior same-conversation passes, **not rerun in this reconciliation**. Current native shared-fixture/serialization/legacy tests also pass in the fresh execution below.

### Step 3 — satisfied

Canonical ID: `c6d0fd6899bec7bcb5c17c2be609e2a55ffedc571f768e0e8dae218bf99be42e`.

`clip_speed.rs` matches the recorded step-3 implementation hash. Current command service wiring retains atomic clone/validate/commit semantics, exact old/new affected ranges, readable history/invalidation metadata and private representation-preserving inverse. Existing service tests verify stale/locked/overlap/inexact/overflow/context rejection, no partial group mutation or journal publication, exact retries, inverse hashes, undo/redo and managed-caption/nested/audio guards. They passed freshly below. Current retimed split/trim support supersedes the historical step-3 temporary rejection; step-5 tests establish that change. Mock speed-command execution, preview and export remain explicitly unsupported pending later steps.

### Step 4 — satisfied

Canonical ID: `34abbc59ccdfc23782b866ebb3ebfb1ef04c5ccfe5c5fe21718d58fbd9c24010`.

The current `speed_persistence_tests.rs` contains five executed tests using actual temporary project files and the real project service, not mocked persistence:

1. Checkpoint, explicit close and journal-only reopen across omitted/explicit-1x/prior-2x states, exact retry result, saved undo/redo stacks, monotonic revisions, reset omission and exact hashes.
2. Rejected speed group leaves journal bytes unchanged, is absent after journal recovery, and does not publish a retry result.
3. Three explicit-close checkpoint failpoints retain acknowledged state/revision and recover the private inverse.
4. Automatic checkpoint failure after 25 edits exposes snapshot-pending/warning state, retains the 25 journal records, replays every edit and persists undo/redo across reopen.
5. V1 migration followed by speed edit, journal recovery and reset returns the exact migrated state/hash.

All five pass in the fresh native run. Existing normal storage/recovery and speed transaction tests pass alongside them. These are temporary-file/fault-injection proofs, not universal power-loss guarantees or user-project operations.

## Fresh native execution

`1f9da239-c609-476f-b624-84f344498665`: `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::project:: --lib`, exit 0: **115 passed, 0 failed, 0 ignored, 244 filtered out**. Test duration 9.80 seconds. Covers steps 2–4 and both retimed step-5 timing tests. This is the project namespace, not the full native suite; no broader native/performance finding is cleared.

## Step 5 and remaining boundaries

Step 5 audit and its 432 package /115 default-feature native /122 serial desktop tests plus workspace type checks are recorded in step-5-consumer-audit.md. These earlier runs remain distinguishable from this reconciliation's fresh all-features native and capability runs. No implementation change has intervened. Retrying its checkpoint is justified after supported ordered checkpoints for steps 1–4.

The historical default-parallel desktop worker-startup failure remains **unresolved**; no parallel rerun, timeout increase or runner repair was performed. The historical full-tree rustfmt failure in preserved job-store work is not cleared. Steps 6–11, production preview/export/pitch parity, real-media Windows WebView and accessibility gates remain incomplete. No speed/phase Done transition is authorized.

## Checkpoint results

Reconciliation progress saved at Notes revision 163. All five sequential `roadmap_checkpoint` calls returned `committed` using the unchanged approved plan hash and exact IDs:

| Step | Expected revision | Committed revision |
| --- | --- | --- |
| 1 | 163 | 164 |
| 2 | 164 | 165 |
| 3 | 165 | 166 |
| 4 | 166 | 167 |
| 5 | 167 | 168 |

The earlier `step-order-invalid` refusal remains historical in step-5-consumer-audit.md; it was resolved through authorized criterion reconciliation and normal ordered checkpoints, not an ownership takeover, plan rewrite or fencing bypass. **Canonical steps 1–5 are checkpointed.** Stopped before step 6; speed and phase remain in-progress.
