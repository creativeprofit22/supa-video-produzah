# Ownership prerequisite — native implementation verified; guardian still pending

## Update: 2026-09-15 04:21 UTC

The historical blocker below is superseded for `bounded-calibration.mjs`, not for old captures or other legacy runners. Native `OwnedLauncher.cpp` now creates a kill-on-close job, starts the exact executable suspended, assigns before resume, and retains the root process handle plus exact creation FILETIME. Assignment failure terminates the still-suspended retained process; no fallback disables containment. Node retains the launcher ChildProcess and uses only `connectOverCDP` against the fresh profile's bounded, loopback DevTools endpoint. HWND discovery requires root PID and exact creation token from that retained handle, not title.

Orderly stop/EOF/lease uses `TerminateJobObject`, drains job notifications while retaining the job, then closes it; launcher death independently triggers KILL_ON_JOB_CLOSE. Closing the job before draining suppressed exit notifications in initial tests, so this ordering was corrected. Descendant exits are recorded as confirmed by ACTIVE_PROCESS_ZERO, not invented per-process exit codes. Only the retained root has an individual exit code.

Seven ownership tests passed, including one real headed browser launch/window/disconnect/close with no audio. Evidence: `evidence/2026-09-14-p2-speed/owned-browser-verification.json`. Reused identity testing means a deliberately mismatched creation token, not an induced OS PID reuse. Real assignment-denial and abrupt launcher-death paths were not fault-injected. Installed CDP cleanup was read at coreBundle.js:42810-42884: transport close and temporary-directory cleanup, including both browserProcess close/kill aliases; not Playwright's spawned-process taskkill path.

Direct `LoopbackRecorder.exe` was precompiled from the existing C# recorder and a small Main wrapper; WGC remains a direct native executable. Neither recorder was run. The runner now uses retained ChildProcess.kill cleanup and has an unconditional fail-closed guard before asset generation/capture until the audio guardian is implemented. No muting, recording, OS-setting or app-code changes were performed. Source snapshots and installed cleanup excerpt are outside the ignored harness in `evidence/2026-09-14-p2-speed/owned-source/`.

## Historical report (preserved)

# Ownership prerequisite — blocked before launch

The installed Playwright 1.62.0 public contract supports the requested ownership API, but its Windows failure cleanup still uses PID-only tree termination. No browser was launched and no dry run or capture was performed in this attempt. This is **not ready for guardian**.

## Evidence inspected

All paths below are relative to the repository. Installed dependency prefix: `node_modules/.pnpm/playwright-core@1.62.0/node_modules/playwright-core/`.

- `types/types.d.ts:20069`: `BrowserServer.process()` returns the spawned `ChildProcess`.
- `types/types.d.ts:20078`: `wsEndpoint()` is the endpoint for `BrowserType.connect`.
- `lib/coreBundle.js:56843-56858`: browser launch is awaited and failures rethrown before a BrowserServer is returned.
- `lib/coreBundle.js:56862-56875`: the websocket listener is opened before the returned server exposes `process()`; the latter returns `browser.options.browserProcess.process` directly. `close()` and `kill()` delegate to Playwright's process cleanup.
- `lib/coreBundle.js:8911`: Playwright retains the actual spawned ChildProcess internally.
- `lib/coreBundle.js:8966-8976`: repeated graceful close or a rejected graceful-close attempt invokes internal `killProcess()`.
- `lib/coreBundle.js:8984-8988`: that Windows fallback invokes `taskkill /pid <pid> /T /F`, guarded by child flags, not retained native process/descendant handles.
- `lib/coreBundle.js:8956`: an exit handler is registered even independently of the optional signal handlers.

Consequently merely changing the caller to launchServer/process/connect and adding ChildProcess.kill() in its finally block does not establish the requested startup/error invariant: the caller does not yet receive that handle on failed startup, and server.close() itself has a forbidden fallback. Turning off signal handlers does not remove those paths. A successful dry run would not prove the failure paths safe.

## Existing harness state

Read `AUDIO-ISOLATION-SAFE-PARTIAL.md` and the actual current file `evidence/2026-09-14-p2-speed/output-capture/bounded-calibration.mjs` (there is no file literally named `currentbounded-calibration.mjs`). The runner remains unchanged and unsafe for live isolation: line 31 uses taskkill, line 47 discovers ownership from a title, and line 55 launches the recorder through PowerShell. Do not run it or enable muting.

## Bounded handoff

Resolve browser startup containment first: a reviewed Windows retained-job/handle design must cover Chromium descendants from process creation and startup failure, and must address Playwright's internal PID-only fallback without changing installed dependencies. A job alone does not remove the library's taskkill path. Do not silently monkey-patch the library or infer ownership from titles. Then implement the direct precompiled recorder path, root PID/creation/executable-bound HWND discovery, exact-child cleanup tests, and only after those pass perform the no-audio browser dry run. Guardian lease/restoration remains a subsequent task.

Verification performed: Node module resolution confirmed the installed package path; the installed public types and implementation above were read. No tests executed because no implementation was made. No OS settings, audio sessions, microphone, uploads, app code, dependencies, roadmap, or git history were changed. This report is the only file created by this attempt.
