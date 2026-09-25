# Commit gate — 18 September 2026

## Outcome

No commits or pushes have been made. The user selected **fix failing checks first**, not an override of failed checks. The fast diff-only review returned CLEAR for the captured 73 modified tracked files and 61 untracked text files. This is not a timing-acceptance or release verdict.

The commit workflow's no-project-checks note is stale. The repository supplies quality checks. This session corrected missing explicit Node `process`/`URL` imports in `raw-observer.config.mjs` and applied Prettier to five existing evidence files. No production timing adjustment, assertion relaxation, skipped test, output-device change, microphone or whole-desktop recording was made. The subsequently authorized test-only capture and temporary GG Coder mute/restoration are recorded below.

## Current checks

- `pnpm check`: passed.
- `pnpm lint`: passed after the import correction.
- `pnpm format:check`: passed after formatting.
- `pnpm test`: passed.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`: passed.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`: passed with the default feature set; existing ignored tests were not run.
- `pnpm --filter @supa-video/desktop test:browser`: **90 passed, 12 failed** (execution `802521be-32b0-4810-8498-ae9aa33440c4`). Failures comprise two raw/final unity-PCM comparisons, eight shared live-parity comparisons, one raw-speed measurement, and the raw HTML-video timing control.

## Bounded diagnosis

1. Raw HTML video alone reproduces the unchanged one-frame failure, without React or ProgramMonitor. Execution `9c9d422d-0ae3-4c47-a993-6bbc867ac540` measured 1.61605 frames. This establishes that application code is not a necessary cause of this failure; it does not prove the application is synchronized.
2. The audio and speed files pass when run together with one worker: **11 passed**, execution `92a95baa-ff82-4976-8baa-d3c54e4ccb1c`. This supports investigating concurrency/startup sensitivity, not declaring the full-suite failures fixed.
3. Three fresh isolated raw-control runs all fail: 1.30280, 1.55553, and 1.30272 frames (execution `99a46b63-6b2e-4d2e-b288-d6d954fc0fd0`). Their retained traces are under ignored `test-results/commit-raw/`. Receipts report audio-minus-visual differences of 43.4267, 51.8510, and 43.4240 ms; baseLatency is 10 ms and outputLatency is 40 ms. No latency was subtracted. These values do not independently establish physical output timing or causation.
4. A headed raw-control run also fails at 1.39535 frames (execution `db6eac6e-8659-43da-abe1-47c3887e714d`, ignored `test-results/commit-raw-headed/`). Headless mode alone does not explain the failure.
5. Direct FFmpeg decoding of `speed-parity-30-1-1-1.mp4` detects its loud audio transient at 0.400083 s (execution `415f2725-da2c-4de7-a116-28a52f9b05cb`). Browser traces observe visual marker 42 at media time 0.4 s. This argues against a roughly 40–50 ms encoded offset in this control; it is not a full exported-media parity test.

## Remaining boundary

The observer routes media audio through Web Audio. Current evidence does not distinguish observer/browser/device delay from actual ordinary-playback output timing. Fixing application timing based only on this measurement would be speculative. Replacing the output-clock gate with a media-time comparison or adding a compensating offset would weaken the test and was not done.

The user subsequently authorized bounded, local test-only output audio and test-window capture, with no microphone, whole-desktop recording, uploads, or unrelated-session muting, and required stopping if unrelated sessions prevent isolation. Historical permission in other reports was not reused.

Read-only preflight `d15c56aa-0d31-4a94-a242-7a4e7170b151` exited 1 before recording: `ISOLATION_REJECTED Foreign unmuted or ambiguous audio session pid=11156 state=1`. Read-only process inspection `dc05abe4-063d-4cc5-bd10-5c333abf018f` identified that exact PID as Discord. No audio reader or ROI recording was started; no unrelated application or sound setting was changed. The retained ignored directory is `capture-eXzEMx`. Its lifecycle receipt confirms `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`, `closed` with `rootExit=0` and `empty=true`, and launcher exit 0.

Further preflights identified Chrome and then GG Coder's WebView session. The user closed Discord and Chrome. A bounded read-only survey (`01957746-3490-4990-8bfe-53001d663865`) identified GG Coder as the only remaining unmuted session. A manual-mute retry still failed. The user then explicitly authorized temporarily muting only that exact GG Coder session and restoring its setting afterward.

A local one-shot wrapper under `.git/` pinned the target and its two ancestor processes by PID, creation time and executable path; retained exactly one matching non-system audio session; saved its original mute state before mutation; and restored/verified that state in `finally`. It did not mute other sessions or the output endpoint. Both bounded executions below reported `GG_RESTORE verified=true restoredMuted=False`. The wrapper and recordings are not commit content.

- Calibration execution `8c74cd3b-9144-4c3b-acf3-62292bb759ba` exited 0 (`capture-KkEdhV`). The synchronized interval was [-33.037233, -5.411733] ms, inside the unchanged ±33.333333 ms gate with only about 0.296 ms margin. Deliberately +100 ms and -100 ms controls had intervals [80.238467, 109.510667] and [-123.144833, -104.334833] ms, correctly outside the gate with the right signs. Receipt inspection `42bf54f0-c549-4cd0-a2ed-733738e095ed` confirmed decoded source controls, isolation ready/stopped markers, silent pre-play packet readiness, normal audio stop acknowledgements, and clean owned-process teardown. This supports that single bounded digital calibration, not repeatability or physical speaker/display timing.
- The paired observer/no-observer experiment (`4e58e043-4e10-4b7a-95b4-eecb59eb8cde`, `capture-b8qBek`) exited 1 at its fresh calibration gate, before either comparison target ran. The synchronized interval was [-37.952633, -13.069933] ms, extending beyond the unchanged lower bound; the early/late controls passed. There were no reported device gaps, inconsistent timestamps or recording-bound violations. Owned-process teardown and GG mute restoration succeeded. This inconclusive calibration is retained, not retried until green or replaced by the earlier passing sample.

Audio isolation is no longer the demonstrated obstacle. Calibration repeatability remains unresolved, and the planned comparison has not run. No application timing fix is supported by these measurements yet. No tolerance, offset, sample-selection or safety-gate change was made. Earlier acceptance gaps remain open; no Roadmap status was modified.

## Proposed commit boundaries (not yet staged)

Keep dependent changes together: shared slow-audio compilation and native validator/tests; preview playback and cache-scope fixes with their regressions; editor-control persistence coverage; shared browser test-server infrastructure; browser fixtures and editor-control coverage; evidence tooling; evidence reports and existing formatting-only changes. Where a file contains multiple independent changes, stage reviewed hunks rather than forcing unrelated fixes into one commit. Re-evaluate the final diff before committing after repairs.
