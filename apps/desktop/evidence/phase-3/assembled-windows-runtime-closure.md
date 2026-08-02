# Phase 3B Windows assembled-runtime closure evidence

Date: 2026-08-01 (UTC)

Host: Windows 11 Pro 10.0.26100, x86_64

Repository: `E:\Projects\supa-video-produzah`

HEAD while exercised: `3fd99757c16e9932c042400dab9c946b47718ddd`

Status: **local-only evidence; Phase 3B remains blocked on successful exact-SHA GitHub Actions CI**

This is a local rerun, not a GitHub Actions result. No GitHub CI success is claimed. Committing this document and its screenshots preserves local evidence only; it does not close Phase 3B. Nothing was pushed as part of this evidence-only commit.

## Assembled executable under test

The current worktree was assembled with:

```text
pnpm --dir apps/desktop tauri build --no-bundle --ci --config src-tauri/tauri.media-tools.windows.conf.json
```

The build completed at `2026-08-01T22:59:44Z`. Build output is in `.gg/phase3b-runtime/logs/assembled-build.txt`.

| File                                                                 |       Bytes | SHA-256                                                            |
| -------------------------------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `apps/desktop/src-tauri/target/release/supa-video-desktop.exe`       |  16,811,520 | `aa12afcdbe1a255d15669bf3dfa3145ee503b4a504a2eb154ea77cd6a7044ccd` |
| `apps/desktop/src-tauri/target/release/media-tools/ffmpeg.exe`       | 101,897,728 | `1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e` |
| `apps/desktop/src-tauri/target/release/media-tools/ffprobe.exe`      | 101,692,928 | `b49ccc7c6547b141ad5a2f6ec69cc04323d7133d7704d70b331b904c63eecb07` |
| `apps/desktop/src-tauri/target/release/media-tools/manifest.v1.json` |       2,362 | `3af10878e4cca82cf33cf18f373cb21a59be31882af5d5b08b657240f4303da0` |

`pnpm --dir apps/desktop media:verify:windows` passed before the build. The executable hash was measured before the runtime scenarios and again after all packaged scenarios and verification commands; both measurements were the same. The literal UI helper `.gg/phase3b-ui.ps1` launches exactly `apps/desktop/src-tauri/target/release/supa-video-desktop.exe`, and Windows process inspection reported that same path during the interrupted-preparation run.

All packaged Rust scenarios used:

```powershell
$cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$env:SVP_MEDIA_RESOURCE_ROOT = (Resolve-Path "apps/desktop/src-tauri/target/release").Path
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
& $cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml <EXACT_TEST_NAME> -- --ignored --exact --nocapture --test-threads=1
```

The stripped `PATH` was `C:\WINDOWS\System32;C:\WINDOWS`; therefore the packaged scenarios could not discover a developer FFmpeg from `PATH`.

## Scenario results

Every documented runtime scenario was executed against the current worktree. Each exact filtered test reported `1 passed; 0 failed; 187 filtered out`. Bare screenshot filenames below are relative to `apps/desktop/evidence/phase-3/`.

| Scenario                                                                                         | Result   | UTC execution                                                                   | Exact test / operation                                                                                                                             | Current artifacts                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged tool integrity and pre-spawn replacement rejection                                      | **PASS** | `23:12:48`–`23:13:39`                                                           | `tests::packaged_media_renamed_or_replaced_executable_fails_before_spawn`                                                                          | `.gg/phase3b-runtime/logs/packaged-tool-integrity.txt`                                                                                                                                                                                                                                                |
| Packaged status, probe, preparation, and successful final render                                 | **PASS** | `23:13:46`–`23:17:22`                                                           | `tests::packaged_media_ipc_status_probe_prepare_and_render_complete`                                                                               | `.gg/phase3b-runtime/logs/packaged-ipc-complete.txt`; retained visuals `assembled-job-center-runtime.png`, `assembled-export-panel-running.png`, `assembled-export-panel-complete.png`, `assembled-export-job-center-complete.png`                                                                    |
| Packaged render cancellation and owned-partial cleanup                                           | **PASS** | `23:17:28`–`23:17:52`                                                           | `tests::packaged_media_ipc_render_cancel_cleans_partial`                                                                                           | `.gg/phase3b-runtime/logs/packaged-ipc-cancel.txt`                                                                                                                                                                                                                                                    |
| Hierarchical preparation, six restart boundaries, monotonic retry, and terminal-event uniqueness | **PASS** | `23:18:00`–`23:21:38`                                                           | `tests::packaged_phase3b_hierarchical_preparation_and_restart_boundaries`                                                                          | `.gg/phase3b-runtime/logs/packaged-hierarchy-restart.txt`; regenerated visuals `assembled-restart-proxy-running.png`, `assembled-restart-proxy-complete.png`                                                                                                                                          |
| Final-render output reauthorization, same-job restart, retry, cancellation, and cleanup          | **PASS** | `23:21:46`–`23:24:12`                                                           | `tests::packaged_phase3b_final_render_reauthorization_retry_and_cancellation`                                                                      | `.gg/phase3b-runtime/logs/packaged-render-recovery.txt`; retained visuals `assembled-export-running-before-restart.png`, `assembled-export-reauthorization-blocked.png`, `assembled-export-panel-blocked.png`, `assembled-export-panel-recovered-complete.png`, `assembled-export-retry-complete.png` |
| Cache leases, LRU budget eviction, regeneration, and explicit legacy deletion                    | **PASS** | `23:24:18`–`23:28:53`                                                           | `tests::packaged_phase3b_cache_lease_eviction_regeneration_and_legacy_policy`                                                                      | `.gg/phase3b-runtime/logs/packaged-cache-legacy.txt`; retained visuals `assembled-cache-active-leases.png`, `assembled-cache-budget-eviction.png`, `assembled-legacy-before-confirmation.png`, `assembled-legacy-confirmation-dialog.png`, `assembled-legacy-cleared-after-confirmation.png`          |
| Literal assembled-app interrupted preparation and restart recovery                               | **PASS** | running capture `23:04:55`; forced quit `23:05:09`; complete capture `23:11:17` | Launch current release EXE, import `long-recovery.mp4`, force-kill while thumbnail child is running, relaunch, reopen project, wait for completion | `assembled-restart-proxy-running.png`, `assembled-restart-proxy-complete.png`, `.gg/phase3b-runtime/logs/preparation-before-kill-db.txt`, `.gg/phase3b-runtime/logs/preparation-after-relaunch-db.txt`, `.gg/phase3b-runtime/logs/preparation-force-kill-time.txt`                                    |
| Scheduler transient start-transition requeue                                                     | **PASS** | `23:12:03`–`23:12:29`                                                           | `video::jobs::scheduler::tests::transient_start_transition_failures_requeue_and_complete_once`                                                     | `.gg/phase3b-runtime/logs/scheduler-requeue.txt`                                                                                                                                                                                                                                                      |
| Cleanup lock-prefix containment through Windows junction/reparse parent                          | **PASS** | `23:12:34`–`23:12:35`                                                           | `video::cache::tests::stale_cleanup_rejects_redirected_lock_prefix_without_touching_outside`                                                       | `.gg/phase3b-runtime/logs/cache-lock-containment.txt`                                                                                                                                                                                                                                                 |
| Same-key crash-partial cleanup before artifact rebuild                                           | **PASS** | `23:12:40`–`23:12:41`                                                           | `video::media_store::tests::artifact_guard_removes_only_same_key_crash_partials_before_rebuild`                                                    | `.gg/phase3b-runtime/logs/artifact-guard-cleanup.txt`                                                                                                                                                                                                                                                 |

No runtime scenario failed.

### Literal restart observations

The assembled UI was first captured with the preparation parent active and its thumbnail child running. The app was force-killed at `2026-08-01T23:05:09.0052025Z`. After relaunch, the same durable hierarchy completed; the interrupted thumbnail child advanced from attempt 1 to attempt 2 while the already-complete proxy child was not duplicated.

The before/after SQLite extracts are:

- `.gg/phase3b-runtime/logs/preparation-before-kill-db.txt`
- `.gg/phase3b-runtime/logs/preparation-after-relaunch-db.txt`

The following proof files are empty, which is the asserted clean result:

- `.gg/phase3b-runtime/logs/preparation-processes-after-kill.txt` — no surviving app, FFmpeg, or FFprobe process.
- `.gg/phase3b-runtime/logs/preparation-processes-final.txt` — no surviving FFmpeg or FFprobe process after completion.
- `.gg/phase3b-runtime/logs/preparation-residue.txt` — no `.svp-part-*` or `*.part.*` residue.

The real `%LOCALAPPDATA%\com.supavideo.producer` directory was backed up before this literal run and restored after it. The attempted redirected `LOCALAPPDATA` sandbox was not treated as evidence because Windows known-folder resolution ignored that environment override.

### Scheduler requeue proof

Exact command:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::jobs::scheduler::tests::transient_start_transition_failures_requeue_and_complete_once -- --exact --nocapture
```

Result: **PASS**, `1 passed; 0 failed; 187 filtered out`. The fault-injection test proves transient `mark_running` persistence failures requeue the claimed job instead of stranding it in the scheduler's active set, and that the job eventually completes exactly once.

### Cache lock-containment proof

Exact command:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::cache::tests::stale_cleanup_rejects_redirected_lock_prefix_without_touching_outside -- --exact --nocapture
```

Result: **PASS**, `1 passed; 0 failed; 187 filtered out`. On Windows the regression requires `mklink /J` junction setup to succeed, verifies the prefix is a reparse point, then proves cleanup fails closed, preserves the stale managed partial, does not create the outside lock, and leaves the outside sentinel and directory entries unchanged.

The adjacent artifact cleanup regression also passed:

```text
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::media_store::tests::artifact_guard_removes_only_same_key_crash_partials_before_rebuild -- --exact --nocapture
```

## Current verification totals

| Command                                                                                                               | Result   | UTC                   | Current total                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                                                                           | **PASS** | `23:30:51`–`23:31:30` | ESLint exit 0                                                                                                     |
| `pnpm build`                                                                                                          | **PASS** | `23:31:30`–`23:31:56` | 5 workspace projects; Vite 1,902 modules                                                                          |
| `pnpm test -- --run`                                                                                                  | **PASS** | `23:32:12`–`23:32:31` | 27 files, **204 tests passed**: contracts 54, media 26, project 8, render 10, desktop 106                         |
| `cargo fmt --all --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`                                        | **PASS** | `23:30:21`–`23:30:22` | exit 0                                                                                                            |
| `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings` | **PASS** | `23:31:56`–`23:32:04` | exit 0                                                                                                            |
| `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml`                                | **PASS** | `23:32:31`–`23:33:02` | library **171 passed, 17 ignored**; security integration **4 passed**; total **175 passed, 0 failed, 17 ignored** |
| `git diff --check`                                                                                                    | **PASS** | `23:30:22`–`23:30:23` | exit 0; only CRLF-conversion warnings                                                                             |

The full Rust suite's 17 ignored tests are explicit system-FFmpeg or packaged-runtime scenarios. The six documented packaged runtime tests above were then run individually with `--ignored`, the current release resource root, and stripped `PATH`.

Verification logs are under `.gg/phase3b-runtime/logs/`. The local hash inventory is `.gg/phase3b-runtime/evidence-sha256.txt`.

## Screenshot provenance and hashes

Only the restart screenshots affected by the scheduler-requeue work were regenerated. The other screenshots were retained byte-for-byte as visual references; current pass/fail authority for those scenarios is the corresponding 2026-08-01 packaged-test log above.

### Regenerated current screenshots

| Screenshot                                                           | Captured UTC                   | SHA-256                                                            |
| -------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `apps/desktop/evidence/phase-3/assembled-restart-proxy-running.png`  | `2026-08-01T23:04:55.3083842Z` | `be3bbc4ac8eb2102e67ca59274fc774d05a4d381d03a7508bbbcc5ce0cd86770` |
| `apps/desktop/evidence/phase-3/assembled-restart-proxy-complete.png` | `2026-08-01T23:11:17.7609664Z` | `71b281141dcc15244fd76b3e6eab2802b1d3495f90fb61380d91c29a0592a1b5` |

`assembled-restart-proxy-failed.png` is superseded historical evidence and is not used by this closure rerun.

### Retained visual-reference hashes, rechecked 2026-08-01

| Screenshot                                        | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `assembled-job-center-runtime.png`                | `dffefa5cef929e322772d035f5e1bf279b019ae529ddfd82eccd8faf6d7a51b3` |
| `assembled-export-panel-running.png`              | `68334ca5f8545ce406810dadf2d7f7fed1302ab3cee7d99932d6dfcc88ef0357` |
| `assembled-export-panel-complete.png`             | `a1476d0f5fdaeedb4ecba03803895229c1b19e093c7fd56aed773d53144af182` |
| `assembled-export-job-center-complete.png`        | `3b6651bcc5237c218c374221f314f8c4f9cb5c05213b35a9ae2d0bab39e74804` |
| `assembled-export-running-before-restart.png`     | `1da6901dac5bdf1df4f3f855d7182013f665e30b690429262619b50da93bae06` |
| `assembled-export-reauthorization-blocked.png`    | `1a615ba5c82538bdf1d26a9ea48ba22e883a6a780b213101c9f936d95a59d808` |
| `assembled-export-panel-blocked.png`              | `073836de3bf222bb80d148ae80d8fce8cd354e1f2c24571720a4fdd8309a945e` |
| `assembled-export-panel-recovered-complete.png`   | `406cb039f7cae7240572b2d9a9fefeed01fda6d97ffd36d8bcf3b4c5aa9999c6` |
| `assembled-export-retry-complete.png`             | `9d660f3bee6cbfd04b01c08f29555fbb248ac832a1444a502faf8de4c232742e` |
| `assembled-cache-active-leases.png`               | `033f05f7903597bd0c5a1bba31d7aa1dc93ad2122e79bc5c44db33edb349522c` |
| `assembled-cache-budget-eviction.png`             | `432a605d06dd3bf2b1dbcaec4700c6bea7570ec85bcf3cc2b7c249bb8e4e6dfc` |
| `assembled-legacy-before-confirmation.png`        | `2d1bb71a830e2f368ec9234b438f2856a4e067c37c9d9d11e78bc4926be8116b` |
| `assembled-legacy-confirmation-dialog.png`        | `0effe9fac48a2f7d3d5de0c42749ff893be5fd27de10cb1e8f06875b0ca3834f` |
| `assembled-legacy-cleared-after-confirmation.png` | `0c052b2f3e3cc00853fda5cba038907dfe0a3181c0fa49190bd708551f90ff7e` |

## Current local-only disposition

- **PASS:** all six packaged runtime tests.
- **PASS:** literal current-release interrupted-preparation restart.
- **PASS:** scheduler requeue regression.
- **PASS:** Windows junction/reparse lock-containment regression with no outside modification.
- **PASS:** full local verification listed above.
- **BLOCKED:** Phase 3B closure requires successful exact-SHA GitHub Actions CI for the complete closure candidate.
- **NOT CLAIMED:** GitHub CI success or Phase 3B closure.
- **EVIDENCE ONLY:** the assembled-runtime document and screenshots are committed locally; no `.gg` runtime state, implementation changes, or unrelated evidence is included.
- **NOT DONE:** push.
