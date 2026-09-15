# Windows supervisor: bounded diagnostic, 2026-09-13

## Outcome

The historical intermittent timeout remains unresolved. One unchanged default-parallel full suite and one temporarily instrumented default-parallel full suite passed. No failing stage trace was captured, so neither result establishes the timeout's cause or a fix. P2 checkpoint/cancellation remains unfinished. The independently assessed P1 cache/caption phase was marked Done with explicit user authorization (Roadmap revision 146); this diagnostic is not the basis of that earlier completion.

No deadlines, assertions, ignored tests, production behavior or dependencies were changed. Temporary test-only timing was removed. No existing dirty file was edited; the two temporarily instrumented source files were clean before this work and were restored byte-for-byte within the tracked-tree fingerprint.

## Revision and execution scope

HEAD: `b21a303c51c258d3aa63fa51217bcbb4508fef0f`, Windows x86_64/MSVC, existing dirty tree.

The fingerprint is SHA-256 of sorted tracked paths, each followed by a space and that file's SHA-256, joined with LF. It excludes untracked files and ignored build/tool artifacts. It identifies source contents, not OS load or the complete runtime environment.

- Baseline inspection `01aa5c26-1eed-439b-b4b7-7b63343b52c5`, exit 0: `d0efb9236796f7263281274474d8aa45b6f99dee9416a76de2890af79f0b7a1a`.
- Instrumented snapshot `85cedeb3-9741-419a-871a-324643f1ce63`, exit 0: `97c30ef9500151cbde6dfc35b30f98335d55f660935c3affdab35762553c2f43`. Its complete sanitized foreground log preserves `git diff --binary`, including the existing tracked dirty patch and the temporary diagnostics.
- Restored inspection `9f18d5ac-3f7a-4e3f-a25f-796d9fc21c87`, exit 0: baseline fingerprint matched exactly after the restored test. No diff remains in `video/process.rs` or `video/tests.rs`; a source search found no diagnostic tag.

Existing dirty tracked files: ROADMAP.md; native Cargo.toml; video/jobs/{mod,scheduler,store}.rs; use-media-jobs.test.tsx; video/JobCenter.{tsx,test.tsx}; dependency-triage rust-dispositions.md; evidence/p2-checkpoint-cancellation.md; security/dependency-exceptions.json. Existing untracked evidence/supervisor-timeout-unresolved.md was not edited. This new report is the only retained file addition from this diagnostic.

## Direct commands and independent exits

All commands ran from the repository root, in foreground with a 600000ms command budget. That external command budget did not change the test's three-second outer watchdog or the process's 1500ms execution timeout. No test-thread override was supplied.

Full command:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --nocapture
```

| Run | Execution ID | Independent Cargo exit | Result |
| --- | --- | --- | --- |
| Baseline, unchanged sources | `766a04a2-52d3-4a75-913c-c86d96193ce8` | 0 | 304 library tests passed, 20 pre-existing ignored; 5 security integration tests passed. Library duration 94.93s. |
| Temporary stage timing, otherwise same command | `8ad1e56f-0564-4a7a-b96f-b5f4a1222eb3` | 0 | 304 library tests passed, 20 pre-existing ignored; 5 security integration tests passed. Library duration 113.10s. |
| Restored original source, focused test | `660f55ce-4985-40ff-9917-49f8691c41aa` | 0 | 1 selected library test passed, 323 filtered, 0 ignored. Test duration 5.80s includes the post-run descendant-survival observation. |

Restored focused command:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml supervisor_timeout_terminates_grandchild_and_releases_inherited_pipes -- --nocapture
```

Complete sanitized execution logs remain under the host's `.gg/foreground/<execution-ID>.log` directory. Numeric exits above are the direct foreground command results, not a trailing echo or wrapper status. The restored build printed the existing non-failing linker-output warning.

## Captured stage timing

Instrumented source changed only test compilation: log monotonic elapsed time around spawn/setup and inline the same timeout cleanup sequence (kill-and-wait, stdout join, stderr join) to observe its stages. The outer test logged its timeout result before retaining the original expectations. These timing logs perturb scheduling; this is not an uninstrumented reliability result.

From execution `8ad1e56f-0564-4a7a-b96f-b5f4a1222eb3`, log lines 333–388:

| Stage | Elapsed from supervisor spawn instrumentation |
| --- | --- |
| Spawn entered | 1.3 microseconds |
| Spawn returned | 894.3118ms |
| Reader setup complete | 894.3782ms |
| Execution timeout selected | 2.3956998s |
| Termination/reaping complete | 2.405114s |
| Stdout join complete | 2.40518s |
| Stderr join complete | 2.40524s |

Outer measurement: `2.4054829s`, result `Ok(Err(Timeout { operation: "helper_tree_timeout" }))`. The test subsequently passed its readiness and descendant-survival assertions.

Observed spawn duration was approximately 894ms. Execution timeout through completed pipe joins took approximately 9.54ms. The whole supervised operation completed approximately 595ms inside the unchanged three-second outer deadline.

## Interpretation and limits

- RUNTIME: both full runs passed; the instrumented passing run spent substantial time in spawn, not cleanup. The restored focused test also passed.
- CODE: the outer watchdog includes spawn/setup, while the process execution timer is established after spawn/setup. A delay before that inner timer can consume the outer budget.
- UNVERIFIED: startup delay is not established as the cause of the historical failure. No current failure was reproduced and no failing-stage trace was captured. No causal fix or new regression is claimed.
- The original supervisor failure in evidence/supervisor-timeout-unresolved.md remains evidence. Its outer watchdog expired before downstream assertions; it did not prove a surviving descendant or specifically identify a blocked pipe.
- Cancellation acknowledgement is distinct from eventual durable cleanup. Passing gated-worker cases do not bound OS storage stalls or authorize terminal cancellation before cleanup.
- The complete baseline and instrumented full suites were not rerun again after restoration; the restored focused test and exact tracked-tree fingerprint establish restoration, not a new full-suite execution.

Next evidence needed is a trace of an actual failing execution under the relevant parallel conditions, with the unchanged watchdogs and identified source snapshot. More passing reruns alone do not close P2.
