# Current results — incomplete

| Acceptance area                               | Current disposition                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Original 19 ignored tests                     | All 19 explicitly mapped; later caption addition separate; 20 historical pass logs inspected; one current gated mock-IPC rerun passed |
| Identified source/resources                   | Initial dirty-tree receipt collected; see README                                                                                      |
| Current bundled capability prerequisite       | Initial failure preserved; approved strict-check repair passed 52 assertions and source-tool verification                             |
| Isolated release executable and FFmpeg parity | Not run                                                                                                                               |
| Browser/native stress and 100 seeded seeks    | Not run                                                                                                                               |
| A6 commit counts/durations and frame counters | Production profiling callbacks proven on browser initialization/edit fixture only; playback A6 remains unmeasured                     |
| Instrumentation overhead comparison           | Not run                                                                                                                               |
| 60-minute native resource session             | Not run                                                                                                                               |
| Platform limitations                          | Explicitly recorded in platform-matrix.md                                                                                             |

Native-preview investment decision: **inconclusive; defer implementation pending measurements**, not a finding that current preview passes or fails. No optimizer, native compositor, synchronization experiment or durable-ack repair was implemented. Existing browser timing failures and native acknowledgement p95 failure remain historical failures, not attributed to React.

Steps 1–2 are complete with explicit historical freshness limits and a selected current native-test-harness rerun. Step 3 is partially implemented and verified; see harness-status.md for exact remaining work. Steps 4–7 have not run. This is an honest partial stopping point, not a concrete external blocker. No release, installer, full-suite or phase Done claim.

## Evidence-tool verification

Initial scoped ESLint failed on an unimported Node `URL` global (`9c84365b-1519-4fc7-8b47-7c4eb597bc3a`); fixed with an explicit import, not suppression. Step-1 scoped ESLint, real snapshot execution and `git diff --check` passed in `1fc18ebe-0ae1-4e8a-ad95-fe11899010cb` (exit 0). New snapshot `runs/snapshot-zsJZf4/identity.json`, SHA-256 `0c48db2365a756b885c55a9725283420fb1ba76241af796fbb822820f208b51f`, inventories 464 files. The tracked diff hash and seven source-resource hashes remain unchanged from step 1. This reporting update follows that receipt. No application behavior changed. Later step-3 checks passed nine harness regressions, desktop typecheck/lint and 64 monitor/timeline tests; see harness-status.md and its execution IDs. No historical failed gate has been relabelled as passing.

Final partial-work check `dcb3dc30-24f1-410d-8933-463a8f93d685` passed nine harness regressions, scoped ESLint and `git diff --check` after the observer timing-origin clarification. Receipt `runs/snapshot-Jc2uEp/identity.json`, SHA-256 `28cec2e69a1129d97c7c280f43102928b1b258ccc77d640089dfac799b06c662`, inventories 474 inputs. Tracked diff SHA-256 `50d06fd6624e8f1ae943d015b7820b1814b120a4e1083129b1a28c89a3ca7083`. Source-preservation comparison `ba2ffbe8-ae06-486d-9397-7eae6e5d6f30` passed: only the explicitly approved bootstrap validator and its tests changed among pre-existing inventoried inputs; all seven source-resource hashes unchanged. This final ledger paragraph follows that receipt; it does not change tested code.
