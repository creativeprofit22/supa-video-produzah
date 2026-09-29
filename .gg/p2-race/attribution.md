# Race-test attribution (step 3) — 2026-09-29 18:21–18:40Z

A = `pnpm --dir apps/desktop test:native` (wrapper). C = `cargo test --locked --all-features -- --show-output`
from `apps/desktop/src-tauri` (the original "after" command). Order ABBA: A C C A A C C A.
`TMP_RACE_TIMING_LOG` set; the diagnostic measures time from publisher-thread spawn to the gate.
`late_ms` = the publisher reached the gate after the 10 s wait (measured with an extra 60 s wait that exists only in the diagnostic).
The race test stops at the first failing case, so later cases in a failed run have no row.

| Run | Mode | Race | Late arrival (case, ms) | Max on-time gate ms | Parallel pass | Tests >60 s | Other failures |
|---|---|---|---|---|---|---|---|
| 1 | A | FAIL | ThumbnailTile fresh, 12573 | 7043 | 127.97 s | 9 | — |
| 2 | C | FAIL | Proxy fresh, 12071 | 238 | 139.53 s | 10 | slow_audio_onset::render_silent_onset_production_compiler_actual_parity (ffprobe ToolUnavailable) |
| 3 | C | FAIL | Proxy fresh, 22120 | 81 | 150.39 s | 13 | — |
| 4 | A | FAIL | ThumbnailTile fresh, 21424 | 8981 | 128.81 s | 10 | — |
| 5 | A | FAIL | ThumbnailTile fresh, 27817 | 7758 | 152.96 s | 12 | supervisor_timeout_terminates_grandchild_and_releases_inherited_pipes |
| 6 | C | FAIL | ThumbnailTile fresh, 15886 | 7201 | 115.28 s | 9 | — |
| 7 | C | pass | — | 5550 | 122.81 s | 9 | — |
| 8 | A | FAIL | ThumbnailTile fresh, 11554 | 3820 | 111.95 s | 8 | — |

A: 4/4 fail. C: 3/4 fail. There were no `never` rows: in every failure the publisher did reach the gate, just after 10 s.
Only fresh (non-reserved) Proxy/ThumbnailTile cases were late. These cases run the fake encode pipeline before the gate.
On-time gates also got close to the deadline (up to 8981 ms).

**Decision (step 4):** A and C fail at comparable rates, and late arrivals show up under both.
The verdict is "timing assumption under load, not caused by the split". The wrapper is not implicated, so the fix proceeds.
