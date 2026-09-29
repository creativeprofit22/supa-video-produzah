# P2 editor controls: final verification (29 Sep 2026)

Commit under test: `13d32fa31a40cc4b9a213dd2a8d1899bbd9e5d1a` (fixes in `2456978`, formatting in `13d32fa`).
Every command ran once, in sequence, on that commit; HEAD was unchanged after the last one. No reruns.
`SUPA_VIDEO_TEST_PORT=5173` was set for all of them: Windows reserves TCP 4162-4261 on this machine, including the default 4173.

| Check | Exit | Result |
|---|---|---|
| `pnpm check` | 0 | typecheck clean |
| `pnpm lint` | 0 | clean |
| `pnpm format:check` | 0 | all files formatted |
| `pnpm test` | 0 | 288 + 88 + 48 + 217 + 470 = 1,111 passed |
| Browser suite, run 1 | 0 | 122 passed / 0 failed (5.0 min) |
| Browser suite, run 2 | 0 | 122 passed / 0 failed (4.9 min) |
| `pnpm test:native`, run 1 | 0 | parallel 537 passed / 0 failed / 22 ignored / 1 skipped by name; isolated ack p95 18.64 ms |
| `pnpm test:native`, run 2 | 101 | parallel 536 passed / **1 failed** / 22 ignored; isolated ack p95 38.82 ms |
| `cargo clippy --all-targets --all-features -- -D warnings` | 0 | clean |

Native run 2 failure: `video::tests::race_actual_prepared_publication_and_completed_reuse` (cache.rs:1628, "publisher did not acknowledge upsert").
It was diagnosed in `cache-race.md`. The cause is a test timing assumption under load (the publisher arrives late but correctly), not a publisher race, and the direct cargo command fails the same way. The test now runs in the serial isolated pass, with no timeout or assertion changed, and passed 10/10 across 10 `pnpm test:native` runs.

An earlier attempt at `2456978` found two defects, fixed before this run: `scripts/test-native.mjs` wasn't formatted, and `pnpm test` hit EACCES on reserved port 4173 because the port override wasn't set. Its later results were discarded.

See `browser-timing.md` for the timing gate, the negative control and the export fix. See `durable-ack.md` for the journal handle and the isolated ack pass.
