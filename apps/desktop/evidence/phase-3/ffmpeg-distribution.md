# Phase 3 FFmpeg distribution baseline evidence

**Date:** 26 July 2026
**Implementation base:** `7ad26432e6ffa36e63f1fc85349345179c31fd72`
**Supported bundled target:** `x86_64-pc-windows-msvc`
**Toolchain ID:** `ffmpeg-8.1.2-gyan-essentials-windows-x86_64`
**Distribution review:** `pending` — public release remains mechanically blocked

## Pinned identity

- Provider artifact: Gyan FFmpeg `ffmpeg-8.1.2-essentials_build.zip`, built 27 June 2026.
- Archive length: `109728040` bytes.
- Archive SHA-256: `db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec`.
- FFmpeg source commit: `38b88335f99e76ed89ff3c93f877fdefce736c13`.
- `ffmpeg.exe`: `101897728` bytes, SHA-256 `1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e`.
- `ffprobe.exe`: `101692928` bytes, SHA-256 `b49ccc7c6547b141ad5a2f6ec69cc04323d7133d7704d70b331b904c63eecb07`.
- Provider notice SHA-256: `9172433fb251059a58d2ff11ba8c6132e04819136ed96e809563911ff0d13816`.
- GPL text SHA-256: `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`.

The archive length and digest match the GitHub release API. The two executable digests were measured only after archive verification and are compiled into the application through `manifest.v1.json`.

## Capability proof

The staged and installed build reported exact version `8.1.2-essentials_build-www.gyan.dev`, required build flags `--enable-gpl`, `--enable-version3`, `--enable-static`, `--enable-libx264`, `--enable-libx265`, and `--enable-libzimg`, plus all production capabilities:

- encoders: `libx264`, `aac`, `mjpeg`;
- muxers: `mp4`, `image2`;
- filters: `scale`, `fps`, `pad`, `tile`, `setsar`, `zscale`, `tonemap`.

The bootstrap script rejects any source/provider/archive identity drift, invalid distribution-review state, archive size/hash mismatch, malformed manifests, duplicate/missing executables, corrupt ZIPs, traversal/link entries, executable hash mismatch, version mismatch, build-flag/capability drift, unsafe staging paths, and partial staging. Its adversarial harness passed **51 assertions**, including the shared PowerShell/Rust mutation corpus. A second verify-only run passed without modifying staged binaries.

## Runtime trust boundary

- The manifest is embedded in the signed Rust application with `include_str!`.
- Production status, probe, preparation, and render commands consume one managed `MediaToolchain`; none accepts executable paths from the webview.
- The resolver selects only the exact Windows x86_64 target, canonicalizes the resource root, rejects non-regular files, symlinks/reparse points and containment escapes, checks file lengths, and streams SHA-256 verification before exposing absolute program paths.
- Capability inspection uses the existing no-shell `process-wrap` supervisor with bounded output, timeout, Windows Job Object cleanup, and redacted failure categories.
- Unsupported targets and missing/tampered/incompatible resources fail closed. Production never searches `PATH`.

Rust resolver/manifest tests passed exact, missing, tampered, wrong-target, traversal, symlink/reparse, malformed schema/hash/URL/review, duplicate capability, invalid version, and missing-capability cases. Rust and PowerShell consume the same explicit provenance/review mutation corpus and produced the same 36 case outcomes. Production-shaped IPC returned only `source`, `toolchainId`, short versions, readiness, and typed problem states; executable paths and build configuration were absent.

## Package and stripped-PATH proof

Local Tauri release assembly succeeded for the production executable, MSI, and NSIS with the explicit media overlay.

- executable SHA-256: `2ffc08140898e5bcbc3394b18ac0b056c91464715293c3ecaaec6f5ffd25c430`;
- MSI SHA-256: `3b34040e25677e5045b3e0aefe7c0f53af611d31ff23eeddbe60950460c1d067`;
- NSIS SHA-256: `145f158dae7715e24e9b0da945016d69d20c22814772b0a16a8d03239888f6d4`.

MSI administrative extraction and NSIS installation each contained exactly the two executables, compiled manifest copy, third-party notices, source-offer record, GPL text, and provider notice at deterministic `media-tools/` destinations. [`installed-media-tools-sha256.txt`](./installed-media-tools-sha256.txt) records the installed payload hashes.

With `PATH` reduced to Windows system directories, installed `ffmpeg.exe` and `ffprobe.exe` passed version/hash checks and the installed GUI remained running after eight seconds. The representative native capture [`bundled-tools-ready.png`](./bundled-tools-ready.png) shows the packaged runtime reporting only short version `8.1.2` and the stable toolchain ID.

The local installers were intentionally unsigned; Authenticode signing and certificate verification require protected release secrets. CI now performs the same package/hash/stripped-`PATH` checks after signing. Public release is blocked before certificate import while review remains pending.

## Packaged cold-start decision

**Build/runtime startup gate: passed.** The release budgets are first visible window p95 at or below 2,500 ms, media-tool ready status p95 at or below 15,000 ms, every `WM_NULL` responsiveness probe returning within 500 ms, and the loading state plus enabled New/Open project actions being observable in every run. The 2,500 ms window budget matches the desktop production UI performance floor while the separate 15-second readiness budget covers cold verification of both 101 MB executables without blocking project-only work.

The rebuilt MSI was administratively extracted to a fresh location on a 2017 Intel i7-8700 machine with 24 GB RAM, a SATA HDD, and Microsoft Defender antivirus plus real-time protection enabled. Each of 10 runs used a fresh WebView2 user-data directory and an elevated, Microsoft-signed Sysinternals [RAMMap](https://learn.microsoft.com/sysinternals/downloads/rammap) `-Et` standby-list purge. [`packaged-startup-windows.json`](./packaged-startup-windows.json) records the machine, artifact/tool hashes, thresholds, all samples, and summary.

- process start to first visible window: **879.8 ms median / 1,593.8 ms p95**;
- process start to ready status: **7,326.4 ms median / 12,199.8 ms p95**;
- responsiveness: **0 failed probes**, worst probe **26.4 ms**;
- resolving-state UI and enabled New/Open actions: observed in **10/10 runs**.

Setup now registers `MediaToolchainState` in the resolving phase immediately, runs initialization through `tauri::async_runtime::spawn`, moves canonicalization and hashing into `tokio::task::spawn_blocking`, and shares one watch-backed resolution across status, probe, preparation, and render commands. The latch-based test `tests::toolchain_setup_registers_resolving_state_without_waiting_for_blocking_resolution` passed, proving setup returns while resolution is blocked and later transitions to ready. CI runs the same 10-sample cold-cache gate on the assembled Windows executable and uploads the JSON trace.

## Rendered UI review

The opener preserves the existing shared rail, typography, Lucide icon family, panel geometry, action order, focus rules, forced-color path, reduced-motion path, and narrow single-column reflow. Ready state shows only short version `8.1.2` and the wrapping stable toolchain ID. Missing, damaged, incompatible, timeout, and generic failures retain New/Open access and provide one repair-oriented retry action.

Small-component quality-floor review scored **2/2** for hierarchy, consistency/flow, responsive behavior, state completeness, accessibility, and content authenticity. The only new visual element is a plain monospace toolchain identity row; no decorative treatment was added. Automated 320 px, 200% text, keyboard order/focus, forced-colors semantics, long identity, and Axe checks passed, followed by native packaged-runtime capture review.

## Verification gates

| Gate                                                          | Result                                                                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Root build, TypeScript checks, ESLint, Prettier               | Passed                                                                                                                                        |
| TypeScript tests                                              | 138 passed across contracts, project, render, and desktop                                                                                     |
| Chromium responsive/accessibility tests                       | 3 passed at desktop and 320 px/200% text; Axe and forced-colors checks passed                                                                 |
| Opener state/accessibility tests                              | 11 passed; Axe found zero applicable violations in ready and all problem states                                                               |
| Rust all-feature suite                                        | 121 passed; 11 environment/assembled-package integrations skipped by default                                                                  |
| Explicit bundled FFmpeg integrations                          | 8 passed: IPC probe, display normalization, HDR tone map, preparation/reuse/repair, AV/video-only render, collision, cancellation and cleanup |
| Packaged production-IPC integrations with stripped `PATH`     | 3 passed: replacement fail-closed, status/probe/prepare/render complete, and cancellation cleanup                                             |
| Rustfmt and all-target/all-feature Clippy `-D warnings`       | Passed                                                                                                                                        |
| Bootstrap adversarial tests and verify-only staging           | 51 assertions passed; shared 36-case validator corpus and staged identity verified                                                            |
| Windows Tauri `--no-bundle` assembly with overlay             | Passed                                                                                                                                        |
| Packaged cold-start and readiness benchmark                   | Passed 10/10; visible 879.8 ms median / 1,593.8 ms p95; ready 7,326.4 ms median / 12,199.8 ms p95; zero responsiveness failures               |
| Resolving-state latch test                                    | Passed; setup returned before the blocking resolver and later transitioned to ready                                                           |
| Windows MSI and NSIS assembly with overlay                    | Passed                                                                                                                                        |
| MSI administrative extraction                                 | Passed; complete deterministic media payload present                                                                                          |
| NSIS install and installed-resource hash verification         | Passed                                                                                                                                        |
| Installed tool version/capability checks with stripped `PATH` | Passed                                                                                                                                        |
| Installed GUI launch with stripped `PATH`                     | Passed                                                                                                                                        |
| `git diff --check`                                            | Passed                                                                                                                                        |

## Legal gate

The selected static build is provider-declared GPLv3 and includes `libx264`, `libx265`, and other libraries. GPL/source availability and codec-patent clearance are separate questions. No legal approval is claimed.

`distributionReview.status` remains `pending`, with reviewer/date/reference unset. GitHub release automation requires `approved` and all three evidence fields before importing signing material or building public installers.
