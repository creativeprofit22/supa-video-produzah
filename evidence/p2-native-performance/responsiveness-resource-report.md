# Short responsiveness/resource probe — 2026-09-20 UTC

## Measured result (RUNTIME)

Run: `runs/browser-watchdog-61tPwW/`. This was a short diagnostic without the playback observer, debugger attachment, or 60-second measurement wait. No performance acceptance sample was collected.

One owned Chrome process (PID 16188, creation UTC 2026-09-20T00:31:20.1949930Z) changed between OS samples 5.11 seconds apart:

| Metric                 |           First sample |            Second sample |
| ---------------------- | ---------------------: | -----------------------: |
| Private bytes          | 75,800,576 (72.29 MiB) | 8,739,553,280 (8.14 GiB) |
| Working set            |            121,282,560 |            7,331,864,576 |
| Handles                |                    264 |                    3,021 |
| Cumulative CPU seconds |                0.59375 |                25.265625 |

The sampler records executable name and ownership, not Chrome subprocess type. Do not present PID 16188 as conclusively identified as the renderer or GPU process.

At probe round 5, approximately 7.38 seconds after starting the probe:

- Browser-level `Browser.getVersion` succeeded in **3.3952 ms**.
- Page JavaScript evaluation exceeded its **2-second deadline** (2,008.9568 ms observed).
- Earlier page evaluations succeeded. The last reported JS heap was approximately 19.3 MB, but this is not a complete native-memory accounting and does not identify the allocation owner.

**DEDUCED:** The browser control connection was still responsive while page evaluation was unavailable. The simultaneous multi-gigabyte Chrome memory/handle growth is a concrete resource problem associated with this workload, rather than evidence that the snapshot serializer itself hangs. No OOM, GPU fault, precise allocator, or specific code cause has been proven.

## Relevant code path (CODE; not a causal experiment)

- `apps/desktop/src/video/VideoWorkspace.tsx:418–474` builds source layers from all prepared non-caption asset clips, without filtering inactive clips.
- `apps/desktop/src/video/ProgramMonitor.tsx:864–916` renders a media element for every source layer, assigns its source, preloads metadata and seeks on metadata load; inactive layers are hidden rather than unmounted.
- The pinned large fixture contains 334 video and 333 audio clips. This code implies 667 media elements when all those clips have prepared assets. This pass did not directly count the mounted elements; do not relabel that implication as a runtime count.

**DEDUCED:** Eager media-element allocation is a strong candidate for investigation, not yet an isolated cause. No app source or media-loading behavior was changed. No optimization is authorized by this report.

## Bounded execution and cleanup

The supervisor used a 40-second outer owned-job lease. Per-probe requests had 2-second reporting deadlines; pending CDP requests are not falsely claimed to have been cancelled. Probing stops on the first failure.

The worker closed the browser and fixture server, recorded `worker.finished`, and exited 1 to report the failed responsiveness check. The external lease did not need to expire. The launcher reported `empty: true`; the independent sampler then observed `rootAlive: false`, processCount 0. Total command time including setup and the final independent sampler observation was 17.933 seconds. Unrelated processes were not terminated.

CPU/memory sampling ran in a separate PowerShell process rooted at the observed owned launcher PID/creation identity and used the existing sampler's executable-containment and descendant-identity checks. Sampler receipt reports `ok: true`. Old receipts and partial artifacts were preserved.

## Changes and verification

- Added short paired browser/page probes and real-value/error/deadline tests.
- Added opt-in `P2_RESPONSIVENESS=1` mode, explicitly separate from sample acceptance.
- The supervisor records independent sampler output and now refuses a successful probe status when its sampler is unavailable/failed. That final reporting guard was linted; the workload was not rerun after this guard-only edit.
- Final targeted lint passed; **18 harness/reporting/probe tests passed**, zero skipped. Execution `dcba8746-9ca5-40a3-9796-c2d705bbb3dd` contains the passing test results and fixture-count inspection.
- Probe execution `d8818de2-ad66-47f4-be9f-d1285da28d83`: exit 1 (responsiveness failure), cleanup confirmed.

No full matrix, native soak, installs, app optimizations, workspace type-check rerun, release claim or Roadmap completion. The launcher startup repair remains in use.
