# Launcher startup repair and recovered measurement trace — 2026-09-20

## Confirmed repair

**RUNTIME:** Loader tracing narrowed the startup stall to initialization following `node:process` loading. A minimal ESM fixture containing only a `node:process` import reproduced the failure with the old launcher under a five-second external lease. The same fixture passed with the rebuilt launcher, first in 151 ms and again in 94 ms during final checks.

**CODE:** `OwnedRun.cpp` previously created the child without explicitly assigning its standard handles. It now assigns a valid read/write NUL handle to child stdin/stdout/stderr and uses `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` to restrict inheritance to that handle. Launcher control input and identity/cleanup output remain separate. The child still starts suspended, is assigned to the job before resume, and retains kill-on-close and bounded lease/drain cleanup.

**DEDUCED:** The old child standard-handle setup caused the Node import startup stall. The exact Node/Windows internal blocking call was not captured. This repair does not explain the separate browser snapshot stall below.

Child console output is intentionally discarded; evidence must use the structured files. Empty launcher stderr does not imply absence of child errors. No app source or packaged release was changed.

## Pinned replacement launcher

Receipt: `runs/launcher-6bddff38882644cfb9a5ee567098e082/receipt.json`.

- Source SHA-256: `8942ba8513a75c3cebd6400fd0c55f0128fef16ab328a15109e85fdc0c49e2db`
- Executable SHA-256: `32e0fc5595767eeaddf106cc9b1a34a12bb9f79c00a7f1bec375f6a6220799d3`
- Built using already installed MSVC/SDK; no download/install.
- The diagnostic runner now pins this receipt. Historical commands/receipts retain their original launcher identity; they were not rewritten or promoted to current acceptance.

## Real bounded verification and remaining stall

Run: `runs/browser-watchdog-rH1L8O/`.

**RUNTIME:** Worker startup, browser import, fixture opening, playback readiness, warmup, observer installation, baseline capture, and the full 60-second measurement wait completed. Last completed operation: `sample.measure.60s` at 00:15:15.067Z. Pending operation: `sample.snapshot.evaluate`, begun at the same timestamp. The worker remained waiting until the external 120-second lease expired. No final snapshot or completed playback sample was saved; the completed wait alone is not valid performance evidence.

The exact snapshot suboperation remains unresolved. This run does not distinguish observer snapshot work, React commit cloning, browser/CDP responsiveness, or result serialization.

Worker PID 12952, creation identity `134343368449054881`. Cleanup at 00:16:04.930Z recorded 120,057.0859 ms elapsed, launcher exit 0 and owned job `empty: true`. Immediate OS observation showed worker, launcher and Playwright processes absent. Only the supervisor and the pre-existing unrelated dev-server processes remained. All previous partial evidence is preserved.

Bootstrap loader tracing is capped at 2,000 events. Optional dependency resolution exceptions (`bufferutil`, `fsevents`) are not paired with error markers in this diagnostic hook and appear as pending in the bootstrap summary; they are not evidence of a live stall. The authoritative current pending operation comes from the worker's uncapped, small per-operation trace. The raw trace is retained rather than retroactively corrected.

## Verification and provenance

- Old-launcher minimal import regression: execution `1b24b3ba-cde1-41d7-ae3c-0c09d149e90b`, failed after five-second lease.
- Replacement launcher build: `e815bba9-ff19-4092-b4af-6e0900ffd40d`, exit 0, MSVC `/W4`.
- Same regression with replacement: `2facd709-ae27-4580-af21-0572971909b4`, exit 0.
- Real single-sample attempt: `d6cdb624-a0d6-425d-9f3b-d01010a00617`, exit 1 (incomplete sample), cleanup confirmed.
- Targeted lint and all harness/reporting/native suites: **21 passed, zero skipped**, execution `9ec3ad57-8b69-48cf-af6e-83dfd4f417b1`, exit 0. Covers explicit teardown, forced lease expiry, real Node startup and `node:process` import, identity rejection, and real browser observer behavior.

Stopped after post-repair bounded verification. No full matrix, native soak, installs, app optimization, release claim, or Roadmap completion. Workspace type checks were not rerun for these standalone C++/JavaScript harness changes; the prior repair's passing checks remain historical.
