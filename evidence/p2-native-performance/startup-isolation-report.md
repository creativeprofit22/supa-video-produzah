# Worker startup isolation — 2026-09-20 UTC

## Result (RUNTIME)

One bounded diagnostic attempt: `runs/browser-watchdog-MbqzzU/`.

The minimal Node bootstrap ran and read the diagnostic module successfully (7,480 bytes). Its last completed marker is `bootstrap.read-worker` at 00:01:48.558Z. Its pending operation is `bootstrap.import-worker`, begun at 00:01:48.559Z. No marker from the diagnostic module itself was produced. The unresolved interval includes module loading/linking/evaluation and initialization before the first worker marker; this does not identify a particular dependency or prove an application/browser defect.

The bootstrap captures argv and cwd, plus before/after/error markers before loading project modules. A separate fixture test demonstrates that this bootstrap can import a simple real ESM file under the same owned launcher. The failure is not a universal inability to start Node, read a module, or import ESM.

## Ownership and cleanup (RUNTIME)

Worker PID 15836, creation identity 134343361085222512. The external 120-second lease fired while the worker was active. `cleanup.json` records 120,047.9465 ms elapsed at 00:03:48.540Z, launcher exit 0 and owned job `empty: true`. The immediate OS snapshot in that receipt confirms the worker and launcher absent. Only the diagnostic's own job was terminated; unrelated development processes remained intact.

No browser startup or playback sample was observed. No second workload attempt, full matrix, native soak, installs, or app optimization was performed. Previous receipts and partial evidence remain unchanged.

## Changes and checks

- Added `worker-bootstrap.cjs`, evaluated with Node `-e`, so startup markers precede any project-module imports.
- The supervisor retains a separate bootstrap summary alongside the worker summary rather than inventing worker markers.
- Added a real owned-process ESM-bootstrap regression test.
- Initial lint rejected CommonJS `require` calls. Replaced only those built-in acquisitions with Node 22's synchronous `process.getBuiltinModule`, without suppressing lint rules. The bounded diagnostic above used the earlier bootstrap, whose hash is pinned in its input receipt; the current variant was verified by the real minimal-ESM bootstrap test, not another workload attempt.
- Final targeted ESLint passed on bootstrap, supervisor and native harness tests.
- Final reporting/native suites: 12 passed, zero skipped, including owned teardown, forced lease expiry, Node startup marker, and real ESM import.
- Final checks: execution `bc980a22-02a8-4177-a081-992498085fd1`, exit 0.
- Diagnostic: execution `d61c0d76-5968-4757-a7b5-ec02c409d43a`, exit 1 (correct incomplete-measurement status), total 121.170 seconds including supervisor setup/reporting.

Workspace type checks passed in the prior repair pass; they were not rerun for these standalone JavaScript harness changes. No claim of root-cause repair or performance acceptance.
