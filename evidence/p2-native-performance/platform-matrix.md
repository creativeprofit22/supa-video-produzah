# Platform evidence matrix

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
