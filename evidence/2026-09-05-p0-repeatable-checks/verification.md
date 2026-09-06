# P0 repeatable quality checks · 5 September 2026

## Later commit-scoping note

The record below is historical evidence from the original dirty-snapshot verification session. Its statements about authorization, unchanged roadmap bytes and no commits apply to that session only. At subsequent commit scoping, HEAD was `7019e0e`: caption diagnostic bounds had landed in `5b0c381`, and browser/accessibility stabilization in `7019e0e`. The user then authorized splitting the remaining Rust cleanup, JSON formatting and documentation into three commits. A historical-baseline note was added to `ROADMAP.md`; the original audit findings remain intact. Recorded execution IDs and hashes below have not been relabeled as verification of these later commits.

## Baseline and preservation

Implementation and all requested direct gates are verified below. No commit or push is authorized or performed.

- HEAD: `7771df653acecbb60d605e9ee74cb9479c3b6136`.
- Initial dirty tree: only the authorized pre-existing `ROADMAP.md` audit edits.
- Initial complete binary dirty-patch SHA-256: `25378cac12cd6eae134098538ce7c0b5ec7b8801962d64edf4322dc7eb79103d`; no untracked implementation files existed.
- Preserved audit file SHA-256: `7479f85a431908e2ef21dd9b0ab8e3a32d2cb871d19b2e13fdb551cc010ea7f6`.
- Node 22.20.0; pnpm 10.34.5; Playwright 1.62.0; cargo 1.97.1; rustc 1.97.1.
- Baseline/version executions: `0951e2b3-4b8f-4338-ad0b-c6b626ccc008`, `9a4aa3dd-70ce-4600-bad3-579fbb68e695`, both exit 0.
- Original browser trace/context and all four failing logs copied under ignored `test-results/p0-repeatable-checks/20260905-1930/original/` before browser reruns; preservation execution `f23a0046-2c3e-4635-97df-560175ccb250`, exit 0.

## Historical evidence (not current repeatability proof)

| Command           | Execution                            | Exit | Observation                                                            |
| ----------------- | ------------------------------------ | ---- | ---------------------------------------------------------------------- |
| pnpm build        | fa4f40a2-b694-4921-ac78-873681a90ba5 | 0    | Chunk-size warning remains out of scope                                |
| pnpm check        | 88afd0d4-f5a2-4301-94c4-601374e29334 | 0    | After build                                                            |
| pnpm test         | 13f8a9be-b1c2-4ff7-a83c-35f7bb09cd8b | 1    | Desktop 268 passed, 1 accessibility timeout; other packages 330 passed |
| Desktop browser   | 6d48d791-f60f-47fc-98d6-2cb876570aa9 | 1    | 45 passed, 1 missing saving announcement                               |
| pnpm lint         | cff6c66b-599d-4d5d-b1ca-c0598b2ddec3 | 0    | Independent gate                                                       |
| pnpm format:check | 86c92e4c-44f5-4bcd-9521-e822317c958c | 1    | Three NeMo JSON files                                                  |
| Rust tests        | b76b4be0-26bb-4920-af2a-479fe6877f12 | 0    | 262 passed, 19 ignored environment tests remain unverified             |
| Strict Clippy     | c0ede4f2-ca7f-477b-93cf-4f3afa3b90f8 | 101  | 52 library and 3 overlapping test-target diagnostics                   |

The earlier 599/599 unit and 46/46 browser passes remain historical observations, not repeatability proof. The earlier visibility timeout was identified below and remains a distinct observation.

## Current diagnosis and gates

All four failures reproduced before implementation edits. Source snapshot remained HEAD plus audit and the new ledger only. Complete worktree SHA-256 (sorted Git tracked + nonignored untracked paths, each UTF-8 path + NUL + raw bytes + NUL): `102de2e1722530324d98198457626532ed02d8f0c536168167ac05995f243ef3`, 409 files. Recorded after these diagnostic runs (`1549f47f-1a97-41e9-9825-a9bb53ef75ea`); future checkpoints record it before execution.

| Direct command    | Execution                            | Exit | Wall duration | Result                                                                               |
| ----------------- | ------------------------------------ | ---- | ------------- | ------------------------------------------------------------------------------------ |
| pnpm test         | f6ffde8e-0a2a-4192-a561-7655b11176ce | 1    | 60.310 s      | 598 passed, ready-editor axe test timed out at 5432 ms; visibility passed at 2848 ms |
| Desktop browser   | 5df16ea4-9dce-41e2-af53-efde3fad6102 | 1    | 51.181 s      | 45 passed, same saving status failure                                                |
| Strict Clippy     | 776615fa-9774-4159-aacc-effdf104ccf0 | 101  | 23.680 s      | Same 52 library / 3 test-target errors                                               |
| pnpm format:check | c31f8f69-6a1b-4403-b0a9-86ef008397fd | 1    | 7.764 s       | Three original JSON files plus this newly written ledger                             |

Earlier visibility evidence located and preserved: execution `f9163d4b-168a-450d-a379-fb1b08d15916` ran a redirected/wrapped pnpm test (not an acceptable fresh direct gate). Its tail omits the failure header; replay log `d3200a6c-7f29-4699-9af4-9552bf8b58cf`, lines 30–50, establishes `workflow.integration.test.tsx:244`, “round-trips video visibility through IPC and canonical projection authority,” timeout 5000 ms, desktop 268 passed / 1 failed. Exact slow await remains unknown. Reproduced browser artifacts were separately preserved before further runs.

## Browser diagnosis and regression

The reproduced trace contains a keyboard commit beginning at monotonic 8646.604 ms and ending at 8724.587 ms; the busy assertion begins at 8726.691 ms and sees true. The subsequent saving-status assertion begins at 9130.879 ms: over 400 ms after the commit completed, beyond the fixture's unchanged 250 ms timer. Trace snapshots show the completed/enabled slider. This is a test observation race, not a missing product announcement.

A 300 ms real observer delay between busy and status assertions deterministically reproduced both desktop and narrow failures: `7dcd04d0-f37b-4641-b5ef-6aa62ec911b9`, exit 1, 8 passed / 2 failed. Test-local Playwright clocks now install before navigation, pause after readiness, and advance the existing 250 ms timer only after all pending-state assertions. The same delayed-observer regression passes: `d85d8813-4f16-4533-b5c6-1a6424b8c836`, exit 0, 10 passed. Transform tests use the same seam and additionally assert busy, disabled controls, restored controls and committed values. Normal time resumes before axe analysis. Fixture duration, production code, zero retries and strict fresh-server isolation are unchanged.

Clock implementation grounding: indexed `microsoft/playwright-python/playwright/_impl/_clock.py`, lines 22–90; JavaScript ordering verified against <https://playwright.dev/docs/clock>. Upstream Python implementation is not represented as JavaScript usage evidence.

## Accessibility diagnosis and regression

Uninstrumented direct full-suite reproduction timed out at 5432 ms. Temporary phase timings at one unchanged instrumented snapshot separated DOM setup from axe scanning. Both awaited headings resolve; each scan sees one render container and real timers. No stuck setup or fake-timer leak was observed.

- Isolated ready-editor setup + scan: about 1.33 s.
- Normal full-suite run: setup 2682 ms, axe 2031 ms, total 4714 ms (passed).
- Second normal full-suite run `037d598d-e9a9-4b76-918e-fad3d517bb37`: setup 2624 ms, axe 1949 ms, total 4573 ms (passed).
- Accessibility + workflow interaction run `29f1b4cf-91c8-4bfd-9294-15a92f0e2847`: setup 909 ms, axe 646 ms, total 1555 ms; both files passed, including visibility.
- Full desktop suite at 100% workers, `fee85089-ecb0-4e45-9c96-8b258ed49f64`: setup 2363 ms, axe 2318 ms, total 4682 ms (passed). Increasing workers did not force another timeout; this negative experiment is retained.
- Scheduling only full-app accessibility after the parallel unit group: setup 1000 ms, axe 647 ms, total 1648 ms in `2d657f3e-6489-425f-a4bc-737d0a27f943`.

Parallel DOM contention consumes most of the existing five-second total budget in both setup and scanning. The narrowly scoped policy removes that competing workload rather than extending timeouts or reducing coverage. All five accessibility tests (six scans) and all configured WCAG tags remain; other unit files stay parallel. New policy regression `test-execution-policy.test.ts` failed against the original configuration (`2bbc4e9f-c724-4260-a680-b58ff43d670e`, exit 1) and passes with explicit group ordering and unchanged 5000 ms budgets. Clean-DOM/real-timer assertions also guard the scan setup. Diagnostic instrumentation was removed.

The first project-policy run inadvertently collected five Playwright files because CLI exclusions were not inherited by inline projects (`2d657f3e-6489-425f-a4bc-737d0a27f943`, exit 1). Explicitly retaining the existing browser exclusion in the unit project fixed collection; subsequent direct `pnpm test` (`13a0924b-0c2c-4fcb-b008-a016dae07884`, exit 0) passed all 600 tests (330 packages + 270 desktop). This is a diagnostic result, not final repeatability evidence.

Limitation: the original timed-out accessibility run had no phase instrumentation, so its exact interrupted await cannot be recovered. Workload contention is supported by the controlled differential, not by claiming a passing rerun proves reliability. The earlier visibility failure's exact slow await likewise remains unknown; no visibility product change was justified.

## Rust and formatting diagnosis

Nemo's runner has no production caller; its module now compiles only for tests. Transcript producer/input/fixture/publication helpers and identity-based test loading have similarly narrow test-only boundaries after caller tracing. Shared artifact/configuration types, identity derivation, validation, bounded parsing and managed key-based IPC loading remain production compiled. The existing Nemo runner and transcript tests remain intact. The test-only import warning was removed without suppressing warnings. Language-server Rust references were unavailable; source reads and repository-wide reference searches were used.

Clippy after boundaries (`d17ecedf-0fc8-494b-8ea8-0af692b61494`, exit 101) reported only the two caption lints. Caption enum variants now omit redundant Rust prefixes but explicitly preserve all 21 `CAPTION_*` serde names, covered by serialization/deserialization pair assertions. Font-weight validation uses the installed compiler's `is_multiple_of` equivalent. No caption behavior/timing change or lint suppression was added.

Rust tests initially exceeded the command runner's 120 s compilation budget (`5244c7b4-9231-45fb-9bac-cb309ecaf6af`, terminated/exit 1), then completed with an adequate foreground command budget (`83969cf4-7fdc-4ade-bbc2-96342e1d2230`, exit 0, 26.970 s): 263 passed (258 library + 5 integration), 19 pre-existing ignored environment tests. Strict Clippy (`7f7e88ba-5040-4f41-bcd4-4ef822401f62`, exit 0, 22.676 s) passed. The test build printed a localized MSVC import-library linker message; no warning policy was changed.

Only the three originally flagged NeMo JSON sources were formatted. Parsed before/after values were deep-compared against HEAD, including all provenance IDs and embedded hashes; no evidence was regenerated. Equivalence execution `0b338082-6a5c-4383-a1db-3d6a0e2a0663`, exit 0. SHA-256 over `JSON.stringify` of each parsed value:

- fixture-recipe: `bcd875e20d6d5622e20c360a4963c0a622b75f2fa24435fa76ccfc19a3dff1c7`.
- provenance-lock: `6887d4cf9d12c326179e691e4eb23c74f00021af68b8742e5cb4f7c70f582112`.
- provenance-validation-fixtures: `6df16ad0f36d80f83d7783f40eef8c665e13ef472f1a7cb59c1b89c86bea5abf`.

Repository formatting (`50f81dbf-2ab1-4706-9111-21c1a17381e8`, exit 0, 8.461 s) and Rust formatting (`c406446d-6985-4692-bed6-0359b8629342`, exit 0, 1.159 s) passed before final gates.

## First frozen series · superseded after new browser failure

This series stopped at step 9 with a newly exposed Job Center browser failure. The user subsequently approved extending scope to fix this regression and restart every gate.

The freeze included every tracked and nonignored untracked file, including implementation tests and this ledger. Every command below ran without editing that 410-file snapshot:

- HEAD: `7771df653acecbb60d605e9ee74cb9479c3b6136` (dirty-tree evidence, not a bare-HEAD pass).
- Complete worktree SHA-256: `2ac75499a0c6d9fb30ca1db0476c41ea8c843646ecbf4d6d2645117d3a4718e6`.
- Implementation SHA-256, excluding only this verification record: `1196cef2dfe72fbc8289dd92098ca84f147d3783dd8bd340c972c33e74e2db0e`.
- Freeze execution `4bedc312-6c84-49f9-8160-df51d8c67b3f`, exit 0; post-gate complete digest equality assertion `3bcf1495-e43c-42cf-bb5a-2cb7154dd466`, exit 0.
- Exact frozen bytes archived under ignored `test-results/p0-repeatable-checks/20260905-1930/frozen-source.zip`.

| Direct command                                                                                                      | Execution                            | Exit | Wall duration | Result                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---- | ------------- | ------------------------------------------------- |
| pnpm build                                                                                                          | b28d2ae3-e559-4d7a-8ca3-d046661b326f | 0    | 31.234 s      | Existing bundle warning retained                  |
| pnpm check                                                                                                          | 03961d15-0892-46d1-9401-9810aba08f75 | 0    | 20.875 s      | After build                                       |
| pnpm test · 1                                                                                                       | bab28614-8b3b-4870-9ecd-41c5466ebb6f | 0    | 52.324 s      | 600 passed                                        |
| pnpm test · 2                                                                                                       | b9ce9bb6-84cf-4487-9658-7bc3ed3351cb | 0    | 58.987 s      | 600 passed                                        |
| pnpm test · 3                                                                                                       | 1eca0c9d-530f-487e-9ede-5072302db078 | 0    | 52.054 s      | 600 passed                                        |
| pnpm --dir apps/desktop test:browser · 1                                                                            | 50423697-1508-46cb-aacb-cc738216aa78 | 1    | 51.745 s      | 45 passed; Job Center loading state absent        |
| pnpm lint                                                                                                           | c2b7041b-f60d-4ffb-b273-3a124ba1689d | 0    | 15.560 s      | No suppression added                              |
| pnpm format:check                                                                                                   | 9fcca8d0-d8ad-41bc-ad5f-9b2e283c03ac | 0    | 8.194 s       | All files                                         |
| cargo fmt --all --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check                                        | ec9ef02a-7527-4130-9f1e-f2ac320e530a | 0    | 0.901 s       | All Rust                                          |
| cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml                                | e6705cf4-6f9d-426e-85c4-346be1ac3129 | 0    | 14.466 s      | 263 passed; 19 existing environment tests ignored |
| cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings | 70d0e867-54e2-4468-946a-7f0b6ef77726 | 0    | 0.934 s       | Strict warnings                                   |

Browser runs 2 and 3 were not attempted after the new failure; lucky reruns would not explain it. The original Clip Inspector cases all passed in the full browser run. The new failure is `JobCenter.spec.ts:104`, “older-page loading preserves focus, merges equal timestamps once, and announces the count”: `Loading older jobs` was absent before its disabled assertion. The fixture completes pending pagination after 300 ms. The preserved trace shows Enter starts at 19982.441 ms, ends at 20243.170 ms, and the disabled assertion starts at 20301.917 ms (319.476 ms after Enter begins). At this checkpoint timer expiration was the leading hypothesis; Job Center was still unmodified.

New failure trace/context preserved under ignored `final-browser-new-failure/` within the run directory (`c4a513fa-c94b-48d2-9729-7813626cfaa4`, exit 0). Original and diagnostic traces remain separately preserved. Session command logs copied into ignored `logs/` in the run directory. The unit runner's existing jsdom canvas diagnostic remains visible; no scan tags or assertions were removed to silence it.

This post-run ledger update is not represented as tested frozen bytes. It corrects the test-versus-scan count and records outcomes. Its formatting is checked separately. Any implementation change restarts the full repeatability series. The user approved the requested scope extension before any Job Center edit.

## Approved extension · Job Center loading-state regression

A 350 ms observer delay deterministically consumes the fixture's 300 ms loading window. Focused direct regression: `6e407fd5-e521-4299-b99a-5aca572ae50f`, exit 1, 16.442 s, 9 passed / 1 failed. Pre-run HEAD was unchanged; complete source digest `f8b99121a155c3ff83e2c6465bf3165845da0a0882d36fcffe1c3803300a5790` (`e3e56634-e5e1-4136-af2f-4c2dc2dd7110`). Red trace preserved in `job-center-slow-observer-red/`.

The same test-local clock pattern now installs before navigation and freezes after keyboard focus is ready. It retains the real observer delay and disabled-state screenshot before advancing exactly 300 ms. All original completion, focus, deduplication, ordering, announcement, overflow and axe assertions remain; normal time resumes before layout/axe checks. Neither fixture duration nor production code changed. Focused green: `c8eeee8b-9030-4c42-98d0-07bfa90ec2b0`, exit 0, 15.449 s, 10 passed. Pre-run complete digest `47f742cfbb1ac4474f88606b2114b1f890966a5dad8145e905202be58b283916` (`cf65db8b-b103-4b5d-97af-f0ba814ccc29`).

## Restarted final series

All requested direct gates passed on one unchanged 410-file snapshot, including three consecutive complete unit passes and three consecutive complete browser passes. No retries, shell wrappers, pipelines, redirection or chained success aggregation were used for these gates. Each browser command launched its own strict-port server with existing-server reuse disabled.

- HEAD: `7771df653acecbb60d605e9ee74cb9479c3b6136`, still dirty; not proof that bare HEAD passes.
- Complete source SHA-256: `717d8b2064c77341f082c41b0c6e08178e5e81e78951f71dda1b3798035eddf2`.
- Implementation SHA-256 excluding only this ledger: `b3a227f646a8f4f1c1bcc056b2e2bfb660bd099180f17b21599a6532d68a62a2`.
- Pre-gate freeze/archive: `72148614-55a4-4dfd-9a6e-1cf4a0532ca9`, exit 0, `frozen-source-2.zip` in the ignored run directory.
- Post-gate complete digest equality assertion: `22759aaa-01cf-4d73-baf4-0db733aaaf56`, exit 0.

| Direct command                                                                                                      | Execution                            | Exit | Wall duration | Result                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---- | ------------- | ------------------------------------------------- |
| pnpm build                                                                                                          | 7fadf14b-f3f2-445f-b00e-247dacf9e5c9 | 0    | 31.979 s      | Existing chunk-size warning retained              |
| pnpm check                                                                                                          | 5fe88310-6e0f-4499-a952-3c0bb06456ef | 0    | 23.078 s      | After build                                       |
| pnpm test · 1                                                                                                       | e78bb829-a9a5-4e16-8962-a0569eb49aa9 | 0    | 56.286 s      | 600 passed                                        |
| pnpm test · 2                                                                                                       | 4cc49368-fd67-49d6-94e2-c56bd4b6198f | 0    | 56.775 s      | 600 passed                                        |
| pnpm test · 3                                                                                                       | 28d5a22d-f808-482f-a1f0-7ba4a498ba19 | 0    | 57.388 s      | 600 passed                                        |
| pnpm --dir apps/desktop test:browser · 1                                                                            | bafef4fb-c010-47f2-b354-fdd967f6224c | 0    | 45.186 s      | 46 passed                                         |
| pnpm --dir apps/desktop test:browser · 2                                                                            | 648f57d7-6b59-4da2-b383-a9130f78f037 | 0    | 45.507 s      | 46 passed                                         |
| pnpm --dir apps/desktop test:browser · 3                                                                            | 053c906f-2e55-404d-a0f6-9f05665dff4d | 0    | 44.560 s      | 46 passed                                         |
| pnpm lint                                                                                                           | 43417877-bb1e-4fad-8952-398987ef3672 | 0    | 6.979 s       | No new suppressions                               |
| pnpm format:check                                                                                                   | 3952091b-c350-4ef6-af00-ce397cc6a6bf | 0    | 7.333 s       | Whole repository                                  |
| cargo fmt --all --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check                                        | bc051e70-18a5-441c-84d3-6b372f21f395 | 0    | 0.862 s       | All Rust                                          |
| cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml                                | 8d86618b-d8f8-4719-bee5-f18f9c3eecd7 | 0    | 15.420 s      | 263 passed; 19 existing environment tests ignored |
| cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings | b1d75540-fe17-4378-8925-f7a584ca14a8 | 0    | 1.098 s       | Strict warnings                                   |

The original 599/599 and 46/46 historical successes, independent reproduced failures, earlier visibility timeout, superseded first series and final passing series remain separate observations. The extra unit test is the execution-policy regression; the extra Rust test preserves all 21 caption wire names. No tests were deleted or newly ignored.

Ledger integrity check `243cd104-6a96-4358-88fc-e2e4ada94d54`, exit 0: all 28 current-session command table rows match their actual execution exit statuses and millisecond durations. Historical rows remain sourced from the preserved audit, not relabeled as fresh results.

### Remaining limits and exclusions

- The historical accessibility and visibility failures did not record individual awaited-operation timing. Their exact interrupted awaits cannot be recovered; this ledger does not invent them. The accessibility budget contention diagnosis is supported by measured isolated/parallel differential timings and guarded scheduling, not merely green reruns.
- The 19 existing Rust environment-dependent tests remain unverified. No real NeMo production integration, GPU acceptance, cache-lifetime repair, caption-timing change, dependency update or unrelated UI work is claimed.
- Existing jsdom canvas diagnostics and build chunk-size warning remain visible and out of scope.
- `ROADMAP.md` retains its authorized pre-existing audit bytes. No commit or push occurred. Raw logs, traces, screenshots and frozen-source archives remain ignored and machine-local; this ledger is the portable conclusion.
- Only this evidence ledger is updated after the frozen gate series. Its later bytes are checked separately for formatting; no implementation file changed after the freeze.

## Verification checkpoint — 6 September 2026 (UTC)

### Revision and evidence boundaries

This checkpoint concerns revision `7478ffe00318e3383050800e4dc5918528780d75`. It supplements, rather than replaces or relabels, the historical records above. The executions below ran as separate bounded foreground commands. Their process results and execution IDs were exposed by the execution tool; PASSED/FAILED/REJECTED classifications were not.

The user subsequently supplied harness evidence from preceding reviewer digests: command-level PASSED records exist for `pnpm check`, `pnpm lint`, three `pnpm test` runs, strict Cargo Clippy, Cargo tests and `pnpm exec prettier --check .`. The supplied evidence also explicitly classifies `pnpm build` as REJECTED: “mutating, artifact-producing, or long-running package script”. These are supplied harness records, not classifications exposed by the execution tool. Linkage from those command-level records to the individual execution IDs below remains unproven. Browser and diff-check classifications remain missing; missing does not mean rejected.

### Observed process results

Every execution below exited 0. Runner-reported passes are process evidence, not independent proof of harness acceptance.

- `pnpm check` — `d9f01dc6-616f-4fba-b2a7-21544e441bd6`: five workspace checks finished without diagnostics.
- `pnpm lint` — `99213cd4-fc07-4103-a550-6be630e66fdc`: no lint diagnostics.
- `pnpm test`, round 1 — `e4b5d6d0-9eed-4f01-86ca-0d8f3a9ccbc7`: 601 passed.
- `pnpm test`, round 2 — `1f3b0820-23ef-4718-a583-e7911120c13e`: 601 passed.
- `pnpm test`, round 3 — `370ef0b6-e0ab-486b-a064-f409340f934b`: 601 passed.
- `pnpm --dir apps/desktop test:browser`, round 1 — `8869f669-98e5-4374-b93c-247677debcbc`: 46 passed, zero retries.
- `pnpm --dir apps/desktop test:browser`, round 2 — `199f2b09-1d51-4f80-8122-dec447740fa5`: 46 passed, zero retries.
- `pnpm --dir apps/desktop test:browser`, round 3 — `67bafde1-2a86-4914-af84-091735f5bf6b`: 46 passed, zero retries.
- `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings` — `3d7101ab-f293-42c9-ae0a-ea0263cc94e5`: no diagnostics; test totals not applicable.
- `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml` — `29d69b77-18be-4ee6-ac66-3f46d789b760`: 263 passed, zero failed, 19 ignored (258 library passes and five security-test passes; binary and doc-test suites contained zero tests).
- `pnpm exec prettier --check .` — `304882d9-121a-4193-a93f-be35fc494ef1`: all matched files use Prettier code style.
- `git diff --check` — `21998b0f-ffe8-4348-8540-b54aec44e8ed`: no diagnostics.
- `pnpm build` — `b7bd469e-1e83-4676-b941-1b04c5fdfd26`: successful compilation with generated artifacts; process exit 0 does not override the supplied command-level REJECTED classification or establish accepted verification.

Each unit round reported video-contracts 132, video-media 44, video-render 23, video-project 132 and desktop 270 passes; no unit retries were reported. The three unit and browser rounds total 1,941 runner-reported passes, with no reported failures. Browser runs used the existing strict `127.0.0.1:4173` port and disabled existing-server reuse; no unrelated processes were killed.

After the build, `git status --short --untracked-files=no` (`9131135e-ca85-469a-930f-8331eeacd60b`, exit 0) reported no tracked changes. That observation predates this documentation-only append and does not assert absence of ignored or untracked generated artifacts.

### Warnings and remaining acceptance gaps

- Unit runs emitted non-failing jsdom diagnostics for unimplemented canvas `getContext()`.
- The build emitted a chunk-size warning: the minified JavaScript bundle was 550.83 kB, exceeding the 500 kB warning threshold. Compilation success and accepted verification remain distinct.
- Supplied command-level harness records have not been proven to link to the listed execution IDs. Browser and diff-check harness classifications are still unavailable.
- The build remains rejected as verification under the supplied harness record; no accepted replacement build evidence is established here.
- The 19 ignored Rust tests remain unverified coverage. This checkpoint neither treats them as passes nor invents an exemption requirement.
- These evidence gaps have not been mapped to the existing P0 acceptance criteria in this checkpoint. No new requirements, broader acceptance verdict, phase closure or P0 completion are asserted.

Only this Markdown checkpoint is being appended; `ROADMAP.md` and application code are unchanged. Targeted formatting and diff checks for this append are separate from the revision's historical execution series. No commit is authorized by this checkpoint; P0 remains open.
