# P2 — checkpoint failures and bounded cancellation

Date: 2026-09-09 UTC. Platform exercised: Windows x86_64 / MSVC, local temporary directories. Scope: A4/A5, phase `9d04ff00-8a71-4802-91f4-6e39db8ac0c7`.

## Status and limits

Implementation and serial verification are complete. Default-parallel timing verification is **not clean**: new cancellation watchdogs and an existing retry-delay test failed intermittently during competing durable-storage benchmarks. No test was ignored, deleted, or given weaker timing assertions to obtain a green run. The full serial release library run passed 298 tests; 20 pre-existing optional system-FFmpeg tests remained ignored. Do not present the serial result as proof that parallel timing failures were fixed.

Roadmap progress submissions were rejected by the host contract: it requires absent optional fields (`verification.reason`, `blocker`, `required_external_action`), while the exposed tool schema requires those fields. No successful phase progress/Done transition is claimed. This document preserves the execution evidence independently of that reporting failure.

## CODE — changes

### A4

- Real close uses the existing checkpoint implementation and three existing failpoints through a per-service, test-only seam; no process-global failure setting.
- Session-map membership and project lock are retained until checkpoint succeeds. A closed-session guard rejects writers that acquired a handle before successful close. Lock order remains map before session.
- Explicit errors preserve inspector access and allow retry, including after replacement.
- Owner-scoped and whole-service closes try every selected session, retain failures, report each failure without private paths, and return an error when any checkpoint fails.
- Native lifecycle cleanup reports sanitized stderr diagnostics and a best-effort `video-cleanup-failed` event. Grant revocation and job cleanup still run. An event during exit is not guaranteed to reach a window or be acknowledged.
- Deliberate simplicity: checkpointing holds the service map lock, so another session lookup can wait behind disk I/O. The current scope does not introduce a more complex per-session closing protocol.

### A5

- A five-second default deadline is shared across cancellation acknowledgement; tests inject 40ms. Owner cleanup shares one deadline across roots and still attempts subsequent roots after a pending result.
- Family requests are persisted transactionally, then all relevant scheduler tokens—including a running root—are signalled before waiting. No-op repeated persisted requests do not re-emit a later unrelated event.
- `CancellationPending` maps to “Cancellation requested; cleanup has not finished.” No new public state exists. The Job Center explicitly allows only this sanitized message through its otherwise generic failure display.
- Queued-worker cleanup callbacks run before ownership is relinquished. Cancellation-only reconciliation checks persisted requests, scheduler ownership and descendants in a transaction before settling ancestors. It runs after actual worker settlement, not via an orphaned polling task.
- Shutdown times out while borrowing the stored join handle. Timeout retains that handle and live leases; retries can finish after the gate opens. Owner cleanup does not release leases on a pending error.
- Existing process supervision, kill-on-drop, process groups/job objects, schema and dependencies are unchanged.
- Deliberate simplicity: reconciliation scans a job's descendants for each ancestor. Very large/deep job trees would warrant a measured, indexed aggregation design, not a second cancellation state machine.

## RUNTIME — red reproductions

The initial service/session and scheduler behavior was unchanged except for isolated test seams and fixtures when the reproductions ran.

Execution `930a3294-59e8-49a2-9ddc-8e9fcef9901f` ran these commands with `--lib`:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features --lib close_failure_retains_session_and_lock_for_retry
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features --lib nonsettling_worker_bounds_acknowledgement_without_terminal_cancellation
```

Both failed on their intended assertions: failed close no longer had an accessible session; nonsettling cancellation exceeded the watchdog. The cancellation fixture opened its cleanup gate before asserting the red result.

The original planned no-default-features command without `--lib` also exposed an unrelated binary-feature mismatch: `main.rs` calls the library's desktop-only `run`. Library-only tests avoid that binary build; native `desktop-runtime` compilation was separately verified. The process tests live under `video::tests::supervisor*`, not `video::process`, so the real matching filter was used rather than claiming a zero-test run as evidence.

The frontend timeout test initially failed because the Job Center showed only generic failure copy. Existing error/pending wiring otherwise passed. The implementation change is limited to exposing the known sanitized message. A subsequent TypeScript check caught numeric widening in the new mock's schema version; matching the existing literal `1 as const` pattern fixed it. The final check and both suites passed in execution `4a3f8915-cf1b-4c89-8f93-2271f1c580dd`: `pnpm --filter @supa-video/desktop check && pnpm --filter @supa-video/desktop test src/use-media-jobs.test.tsx src/video/JobCenter.test.tsx && git diff --check && git status --short`.

## RUNTIME — current verification

All command paths below are relative to the repository root. Execution IDs refer to the host's recorded foreground command executions.

| Execution | Command | Result |
| --- | --- | --- |
| `f236769f-5132-453e-881d-7392d6427567` | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features --lib video::project:: -- --test-threads=1` | 83 passed; 0 ignored |
| `e535f841-7d86-428c-b762-3fe2d820c66a` | `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features --lib video::jobs:: -- --test-threads=1` | 35 passed; 0 ignored |
| `7c880545-9b55-49b4-80f1-af370d2324fb` | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features --lib supervisor -- --test-threads=1` | 4 passed, including child/grandchild cancellation and reaping |
| `055a3e8c-2cec-443a-8fed-a87c6d27cecd` | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features --features tauri-ipc-test --release --lib -- --test-threads=1` | 298 passed; 20 pre-existing ignored; 225.42s test time |
| `90f4cec8-6148-4847-842c-478cfebc34ad` | `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --features desktop-runtime && cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check && git diff --check && pnpm --filter @supa-video/desktop test src/use-media-jobs.test.tsx src/video/JobCenter.test.tsx` | Native compilation, formatting and whitespace checks passed; 20 frontend tests passed |

The full release library run includes the real lifecycle checkpoint-error event test and existing native IPC authorization/grant-cleanup regressions. The frontend environment printed its existing canvas implementation notice; neither suite failed.

## RUNTIME — covered failure matrix

- Explicit close: before temp sync, after sync before replacement, and after replacement; inspector access and actual file lock retained on failure; retry succeeds and removes the session/lock.
- Bulk close: both owner-scoped and all-session close, two failed sessions mixed with a healthy one; all attempted, failures surfaced, healthy session removed.
- Recovery: drop the failed service before reopening to release its actual lock; compare exact revision/hash, state and undo history. Assert one replayed journal record before replacement, zero after successful replacement, and validate recovered snapshot integrity.
- Concurrency: a separately acquired writer handle is gated until close succeeds and is then rejected.
- Lifecycle: inject a real checkpoint failure, observe the sanitized event, retain inspector access and confirm grant cleanup still ran.
- Nonsettling worker: real temporary partial file, explicit cancellation signal, release gate and cleanup counter. The caller returns pending; job remains nonterminal with no terminal cancellation event before cleanup. Gate opening removes the partial and yields exactly one terminal cancellation event.
- Family: two gated children, with and without a separately running root; repeated cancellation requests; running-root cleanup alone cannot terminalize a parent while children remain live; final cleanup settles the family without another UI action.
- Owner/shutdown: two running jobs with a real cache lease; pending owner cleanup signals both, pending shutdown keeps the handle and lease, and a retry after actual cleanup releases them.
- Frontend: refresh retains nonterminal cancellation-requested state and its timeout message; retry/cancel controls remain unavailable while cleanup is pending.

## RUNTIME — failed/incomplete verification retained

- Full debug IPC-enabled runs exceeded foreground time limits while exercising bundled media tests. These are incomplete runs, not passed evidence.
- The first optimized build/run exceeded its foreground budget; a subsequent cached full serial release execution completed. No timeout is counted as success.
- Default-parallel jobs runs intermittently exceeded the new 500ms caller watchdog or two-second post-release cleanup watchdog. An existing retry-delay one-second test also failed in a parallel full-release run.
- Diagnostic execution `f35eebdb-064f-4c68-b97f-0703e7bc16b0` measured cancellation transaction open/begin at about 1.45ms and completion at 791.25ms, beyond the caller's 500ms test watchdog. Other diagnostic runs observed cleanup storage calls around two seconds. Signals and partial cleanup also completed in those runs; no evidence establishes forced terminal cancellation before cleanup.
- Temporary diagnostic instrumentation was removed. Repeated requests were batched and live-worker reconciliation avoids pointless write transactions, but these changes did **not** establish reliable default-parallel timing. Serial verification retains the original timing assertions and isolates them from concurrent storage benchmarks.

## Acceptance evidence and remaining uncertainty

1. Checkpoint criterion `92b194de85e478444496d4ee6f5d9926931e6fbd4d4e59883f99aa1036dd4acb`: project execution plus the lifecycle test in the full IPC-enabled execution establish the tested replay/retry/reporting behavior. They do not establish committed edit loss or universal power-loss survival.
2. Cancellation criterion `1c3693e6c0805a94ed6a380a156ef663703c3a22e29fdf98f2a92b5794b53c10`: serial jobs execution establishes bounded acknowledgement with a nonsettling worker and truthful late cleanup. Default-parallel wall-clock verification remains qualified by the storage timing failures above.
3. Regression criterion `a9dcb4b89a41fcf5864e3dccd3fda1e086d423f09afeff64e5acb278932e7804`: current project, supervisor and full release executions pass under serial test scheduling. Optional system-tool tests and other operating systems were not newly verified.

The deadline bounds acknowledgement waiting, not an OS filesystem stall, stalled runtime or every preceding durable write. A worker that never acknowledges cleanup remains nonterminal; the implementation does not abort it, release its ownership, or pretend cleanup happened. Forced application exit can still interrupt cleanup. Real crash/power-failure behavior beyond the injected checkpoints remains unverified.

## External comparison — CODE only

The current Apalis monitor corpus (`apalis-core/src/monitor/mod.rs`, lines 445–480) was searched and read before editing. Its explicit error reporting and bounded shutdown informed the design; terminating a wait is not used as proof that independently spawned workers cleaned up. The approved plan's atomic-write comparison was not reimplemented: this patch uses the existing snapshot/journal code.

Installed Tokio 1.53.1 source (`tokio/src/runtime/task/join.rs`, cancellation-safety documentation) was resolved and read. It documents cancel safety for borrowing a join handle. This supports retaining the handle across timeout; the actual retained-handle/lease retry behavior is established by the test, not by the source comparison alone.
