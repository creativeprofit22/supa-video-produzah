# Bounded calibration integration: blocked before live activity

This attempt did not integrate or enable capture. The unconditional capture guard remains intact. Parent matrix must not run.

## Safety blockers found in current helpers

- `../output-capture/LiveGuardian.cs:104-107` checks lease, root lifetime and endpoint, but does not periodically read back foreign session mute state. Session creation notifications alone do not detect an existing foreign session being unmuted. There is no isolation-health event or heartbeat contract.
- `../output-capture/LiveGuardian.cs:109-120` begins restoration autonomously after stop/lease/failure, without waiting for audio/WGC reader-stop confirmation. Wiring its existing READY/ACK interface alone cannot establish the requested reader-stop-before-restoration ordering on those paths.
- `../output-capture/audio-guardian.mjs:12-15` exposes READY and final ACK/exit, not pre-restoration isolation loss. It resolves exit with a verified ACK even for a nonzero code; callers must not mistake that for capture success. A rejected exit without ACK does not provide an active restorer/recovery interface.
- `../output-capture/bounded-calibration.mjs:71` currently waits at most two seconds for recorder cleanup before closing the browser. This is not proof that readers have stopped, and cannot be retained in the integrated lifecycle.

These require a guardian/lifecycle protocol change and new failure-injection tests, not simply removal of the guard. No verified replacement was completed in this attempt. No claim is made that these gaps are impossible to fix.

## Actual counts and privacy

- Live control executions: 0 of requested 3; captures: 0; retries: 0.
- Visual timestamps: 0 of requested 6; audio groups and uncertainty intervals: not measured. No calibration pass or sign/bounds claim.
- Sessions muted by this attempt: 0; restoration requests: 0; restoration ACKs: 0. No new original-mute readback was performed. Earlier proof results are not this attempt's verification.
- Owned browsers, guardians and capture readers launched: 0; corresponding owned exits: not applicable. No restoration is pending from this attempt.
- No microphone, playback, upload, dependency/OS upgrade, application-code modification or commit. Old reports/captures preserved. No OS-crash/power-loss recovery claim.

## Verification actually performed

Read CONTEXT.md, AUDIO-GUARDIAN-EVIDENCE.md, current bounded runner, guardian and owned-browser JS helpers, native guardian lifecycle, and owned-browser proof/review records. Ran `node --check` separately for bounded-calibration.mjs, audio-guardian.mjs and owned-browser.mjs in one command; all passed (2026-09-15 04:40:48 UTC). No compilation, native test, fake-child cleanup test or live run was performed. Those prerequisite gates remain incomplete.
