# Bounded diagnostic repair pass — 2026-09-19 UTC

## Outcome

**RUNTIME:** One 1,000-item browser measurement attempt was launched under the external 120-second Windows Job Object lease. It remained before the first worker marker and was terminated by the watchdog. No playback sample or browser-start receipt was produced. The exact startup operation remains unresolved; do not attribute this to the application, renderer, or media decoder.

The requested stopping boundary was honored: no second measurement attempt, matrix, native soak, installs, app optimizations, or Roadmap completion update.

## Repairs and limits

**CODE:** Browser and measurement imports are now dynamic and traced after a worker-bootstrap marker. Existing per-await playback and browser cleanup markers are retained. Built-in imports, the launcher/report helper imports, and initial path validation still precede that marker; their completion was not observed in this worker. This does not claim tracing before all JavaScript module initialization.

**CODE/RUNTIME:** Missing, empty, and truncated worker traces now produce an explicit report instead of the prior ENOENT reporting crash. Reporting distinguishes successful cleanup from successful measurement and exits nonzero for missing or incomplete measurement evidence. An existing matching Node diagnostic blocks a duplicate launch. Cleanup errors are captured separately.

**RUNTIME:** A separate three-second launcher regression proved a simple Node worker could write its startup marker and then be reaped by the same external watchdog mechanism. This rules out a universal inability to start Node under this launcher; it does not establish why the full ESM worker failed to reach its marker.

## Last operation, pending operation, cleanup

Run: `runs/browser-watchdog-kQ1JwH/` (all previous run directories preserved).

- Last confirmed pre-stall operation: owned worker creation, PID 20484, creation identity `134343356381843287`, also observed through the OS in `ownership.json`.
- Pending/unobserved: `worker.startup.before-first-marker`; no exact JavaScript await is known.
- Cleanup receipt at 23:55:58.212Z records 120,059.1248 ms elapsed, launcher exit 0, worker still active before cleanup (`259`), and owned job `empty: true` after termination.
- Immediate OS observation confirms worker and launcher absent; the supervisor remained temporarily to write the report. The pre-existing development-server processes were left intact.
- `report.json` was written successfully, reports `traceStatus: missing`, `measurementCompleted: false`, and `cleanupConfirmed: true`. The command correctly exited 1, rather than treating cleanup as measurement success.

## Verification

- `node --test evidence/p2-native-performance/diagnostic-report.test.mjs`: initial red result (missing new helper), then six passing regressions for missing/empty/truncated/nested/error/completed evidence.
- Native harness suite with existing pinned launcher/media receipts: **5 tests passed**, including explicit teardown, lease expiry, and the new Node-startup-marker test. Execution `95aa89c2-56f9-43c2-b735-747a179962d4`, exit 0.
- Harness and reporting suites: **15 tests passed**, including the real browser observer test. No skips.
- ESLint with the evidence configuration over all six files touched by this repair/instrumentation: passed, including `browser-session.mjs`, whose editor diagnostic had timed out previously.
- `pnpm check`: all five workspace package checks passed.
- Combined verification execution: `c974c852-0d6f-46b3-b586-a471dbcc4d1f`, exit 0.
- Bounded sample attempt: `02e19d5c-e8df-483f-8a73-fbef273e17f7`, exit 1, 121.218 seconds total including setup/reporting. This is failure evidence, not acceptance.

Not run: complete workspace test suite, full workload matrix, native soak, installer/release verification. No application source was changed in this repair pass.
