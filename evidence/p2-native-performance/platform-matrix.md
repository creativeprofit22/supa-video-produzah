# Platform evidence matrix

## Current (2026-09-27)

| Claim                                                               | Windows                                                                                                                              | macOS      | Linux      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------- |
| Host/tool inventory                                                 | Observed; see README                                                                                                                 | Unverified | Unverified |
| Current isolated release build/tool resolution                      | Passed: offline/locked `release-k0C1Ro`, `release-eIOB49`; pinned FFmpeg verified                                                    | Unverified | Unverified |
| Actual native import/preparation/Preview/Final/export/cancel/reopen | Passed on the assembled release and on the executable extracted from the MSI (`native-i1cbfs`)                                       | Unverified | Unverified |
| Codec/playback and frame counters                                   | Measured in WebView2 (Chromium decoder counters, visible-layer attributed); no physical-display or GPU-trace proof                   | Unverified | Unverified |
| Seeded seek distributions                                           | Measured (100 seeds × target × cadence); Final p95 cause diagnosed                                                                   | Unverified | Unverified |
| 60-minute owned resource session/cleanup                            | Passed 2026-09-20                                                                                                                    | Unverified | Unverified |
| Installer                                                           | MSI built offline and administratively extracted (not installed or registered); resources byte-match; runtime passed. NSIS not built | Unverified | Unverified |
| Signing                                                             | **Not signed** (Authenticode `NotSigned`; no signing identity configured)                                                            | Unverified | Unverified |

macOS/Linux need a matching native host or runner, matching packaged tools, and an interactive desktop for playback. No such access is available here, so these remain unverified; they are not blocked by anything on Windows. Public distribution and signing belong to the release-gate phase.

## Historical (2026-09-19)

| Claim                                                               | Windows                                                                                                           | macOS      | Linux      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| Host/tool inventory                                                 | Observed 2026-09-19; see README                                                                                   | Unverified | Unverified |
| Current source bundled tools                                        | Hashed; initial validator failure repaired with approval; source verification and one gated mock-IPC rerun passed | Unverified | Unverified |
| Current isolated release build/tool resolution                      | Not run                                                                                                           | Unverified | Unverified |
| Actual native import/preparation/Preview/Final/export/cancel/reopen | Not run in this phase                                                                                             | Unverified | Unverified |
| Codec/GPU/playback and frame counters                               | Not measured                                                                                                      | Unverified | Unverified |
| Seeded seek distributions                                           | Not measured                                                                                                      | Unverified | Unverified |
| 60-minute owned resource session/cleanup                            | Not run                                                                                                           | Unverified | Unverified |
| Signing / installed app / installer                                 | Unverified; no installation authorized                                                                            | Unverified | Unverified |

macOS/Linux testing needs a matching native host or runner, matching packaged tools and an interactive desktop for playback. No such access has been established here; this does not block Windows inventory or evidence tooling. Missing historical logs alone would not be an external blocker. Historical Windows debug mock-IPC evidence is not release-runtime proof. Public-distribution permission is separate and not granted by this phase.
