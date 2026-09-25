# Snapshot responsiveness investigation — 2026-09-20 UTC

## Result

The remaining stall is **not established to be inside snapshot collection**. Two bounded diagnostics produced no completed sample. The launcher startup repair remains in use and worked in both attempts.

### Snapshot-entry tracing (RUNTIME)

`runs/browser-watchdog-bVpbAr/`: browser setup, observer installation, baseline capture and the full 60-second wait completed. `sample.snapshot.evaluate` remained pending. No console marker from the first statement of that function reached the worker. Therefore observer snapshotting, commit cloning, video-quality reads and observer teardown were not observed to start; absence of a console event alone cannot establish which browser/transport layer blocked execution or delivery.

Watchdog cleanup: 120,059.2567 ms, root PID 12148, creation identity 134343372540302326, launcher exit 0, job `empty: true`. OS snapshot confirms worker and browser children absent. Baseline JSON and all partial traces remain intact.

### Debugger capture (RUNTIME)

`runs/browser-watchdog-pEWggV/`: debugger attached and enabled, playback readiness completed, then the five-second warmup wait completed. The next operation, `sample.observer.install`, remained pending. An independently scheduled `Debugger.pause` request also remained pending; no paused event or JavaScript stack was obtained. This attempt stalled before the collector was installed, but debugger attachment perturbs execution, so its timing is not directly comparable with unmodified runs.

Watchdog cleanup: 120,040.4903 ms, root PID 17796, creation identity 134343374678307683, launcher exit 0, job `empty: true`. OS snapshot confirms worker and browser children absent. No missing stack or measurement has been fabricated.

### Interpretation (DEDUCED)

The pending call moved earlier, and the debugger control request also stopped responding. This is broader than a demonstrated snapshot-function defect. Renderer responsiveness, browser/CDP transport, or a lower-level browser/media/GPU stall remain candidates. No candidate is confirmed. Node-side timing/trace logging continued, but that does not prove its entire browser transport remained healthy.

Further investigation should collect OS process CPU/memory and browser control-channel liveness independently of page evaluation, using short responsiveness probes rather than repeated complete playback waits. This was not run in this pass. No app or graphics-setting change is justified by the current evidence.

## Harness changes

- Snapshot suboperation console markers are emitted only when diagnostic tracing is supplied; normal playback sample duration and assertions are unchanged.
- Optional debugger attachment and a one-shot pause capture remain available only with `P2_DEBUG_SNAPSHOT=1`; the default is off, and the input receipt now records this choice. The debugger attempt above predates this opt-in guard and had attachment enabled unconditionally.
- Debugger script-ID tracking is capped, the pause timer is cleared on normal/error completion, and external owned-job cleanup remains the final 120-second bound.
- The final opt-in guard was linted but not exercised by another workload attempt. No additional measurement was launched after the two diagnostics.

## Checks and scope

Final targeted ESLint and reporting/browser-observer harness tests passed: **15 tests, zero skipped**, execution `11b07469-bc7e-4e61-ac1c-5a3b0cc7d1e8`, exit 0. These do not establish that the workload or new debugger path completes.

Diagnostic executions: `e59cd9a1-b2fc-4bc6-8122-c31cb1dca356` and `a17299bd-56a8-42c7-b2d0-7740f96f2f34`, both exit 1 (incomplete measurement), both with confirmed cleanup. Previous evidence was preserved. No full matrix, native soak, installs, app optimizations, release acceptance or Roadmap completion. Workspace type checks and full native suite were not rerun for these two standalone JavaScript harness edits.
