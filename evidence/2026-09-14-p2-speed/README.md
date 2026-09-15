# P2 speed — implementation evidence (in progress)

## Scope and starting snapshot

Only the approved speed slice is authorized. No completion of the editor-controls phase is claimed.

Starting HEAD: `b21a303c51c258d3aa63fa51217bcbb4508fef0f`.
Starting tracked diff SHA-256: `c491466f3c174dfd82494d02cbfa8c62614e1fd52fb217edcd3eb7f028d6c22e` (Git binary diff bytes, execution `04c1634a-8590-4cae-9e3b-e62a462d2d41`).

Preserved existing modified boundaries: ROADMAP.md, Cargo.toml, native cache.rs and jobs/{mod,scheduler,store}.rs, use-media-jobs.test.tsx, JobCenter.tsx and its test, dependency triage rust-dispositions.md, p2-checkpoint-cancellation.md, security/dependency-exceptions.json. Existing untracked September 13/14 diagnostic evidence and supervisor-timeout-unresolved.md remain untouched. Initial status is captured in execution `50fafd0a-11b2-4fa6-a031-0035d2697561`.

## Step 1 baseline — 14 September 2026

- Bundled FFmpeg `-h filter=atempo`, `setpts`, and `asetpts` each exited 0; execution `1706fcec-f68c-440a-ad5d-b643770cf909`. Installed atempo supports 0.5–100; this slice remains limited to 0.5–2. Filter presence is not export parity proof.
- Contracts/project/render baseline command exited 0: 141 + 132 + 26 tests; execution `228ae437-0577-4072-9648-dad2f67e5340`.
- Focused desktop baseline: ClipInspector, VideoWorkspace, ProgramMonitor, use-video-project, MultitrackTimeline and timeline-move-snap: 116 passed, exit 0; execution `11fdb150-18ce-4f6f-bbe8-c8b351cf108d`.
- Native project baseline: `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::project::tests --lib`: 80 passed, 0 ignored, 247 filtered out, exit 0; execution `2c3c0674-1a2c-46a3-9c3f-7261c5d97c6f`. This is not the full native suite or a repair of historical intermittency.

## Browser pitch capability probe

`node scripts/probe-speed-preview.mjs`, execution `08ac2ca5-afc5-4d41-b7fc-8f77fcc45493`, exit 0. Chromium 151.0.7922.34 decoded actual bundled-FFmpeg-generated 440 Hz PCM WAV. The production ProgramMonitor was not involved.

Method: HTMLAudioElement routed into Web Audio analyser (32768-point FFT), dominant frequency after one second of actual playback; no microphone or private media. Frequency tolerance 1%; startup-inclusive elapsed media/wall clock ratio tolerance 10% for this capability probe only, not final A/V parity. Samples are taken inside the tone, away from the source tail.

| Requested speed | Measured rate, pitch preserved | Peak Hz, pitch preserved | Peak Hz, preservation disabled |
| --------------- | ------------------------------ | ------------------------ | ------------------------------ |
| 0.5             | 0.476279                       | 439.453125               | 219.7265625                    |
| 1               | 1.009281                       | 439.453125               | 439.453125                     |
| 1.5             | 1.496754                       | 439.453125               | 660.64453125                   |
| 2               | 1.989468                       | 439.453125               | 880.37109375                   |

Pitch error with preservation: approximately 0.1243%. Disabled-preservation controls demonstrate sensitivity to pitch shifting at non-normal speeds. This establishes browser capability, not Windows Tauri WebView support, decoded video frame evidence, hardware audio capture, or production preview/export parity. Those remain unverified until later planned steps.

## Step 2 — initial foundation checkpoint (historical)

This checkpoint predates the serialization continuation below; its results and source fingerprints are retained as historical observations, not current downstream verification.

Implemented standalone bounded speed validation, whole-percentage parsing, edit-time normal-speed omission, cross-cancelled exact duration and bidirectional relative offset conversions in TypeScript and Rust. Both reuse existing rational-time validation; edit boundaries reject inexact results and display sampling explicitly floors. TypeScript uses BigInt, with the same checked u128 product ceiling as Rust, and both reject results beyond the existing safe-integer contract.

A shared 21-case JSON fixture covers omitted normal speed, 50/150/200%, mixed and fractional frame rates, invalid speeds/ranges, overflow, large-factor cancellation, and an exact result that would fail an intermediate normal-speed rescale. TypeScript additionally exercises all 151 supported percentages and strict parsing. The loaded ProjectClip schema, command union and render metadata have intentionally NOT yet been extended: this foundation does not allow a speed-bearing project to reach unchanged playback/export consumers.

Current checks:

- `pnpm --filter @supa-video/contracts test` and `pnpm check`: both exit 0, 187 contract tests including 46 new timing tests; execution `35dd58c7-ed0a-4781-af92-12a96800c9d3`.
- Project/render regression tests: 132 and 26 passed, execution `0929fa78-6661-42cc-a108-d5519ff9fafa`, exit 0. The subsequent contract import change was type-only.
- Native project namespace: 88 passed, including four new timing tests; 243 filtered out, 0 ignored, exit 0; execution `a2067e2f-85fa-4b6b-82d7-9b334d039817`.
- First `pnpm lint` failed with seven errors in newly added files: one type-only import and six browser/Node global references in the probe. Fixed without suppressions. Rerun exit 0, execution `5fa6dde8-99ed-4402-8697-b7138a477eaf`.
- `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`: exit 0, execution `fade0cba-7aa9-4dd3-8770-65e469b44643`.
- Full `cargo fmt --all --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`: exit 1, execution `bddcd75c-7644-4d64-9797-1563605264ed`. Differences were reported only in the preserved pre-existing `video/jobs/store.rs` changes, which were not reformatted. This is a current failed check, not a pass or an external blocker.
- Probe rerun after the global-reference edits: exit 0, execution `48b19ba4-73d2-4986-87a1-c08cfda883a8`. Preserved-pitch rates measured 0.469249, 1.005339, 1.491627, 1.996031; all preserved peaks remain 439.453125 Hz. Disabled-preservation peaks remain 219.7265625, 439.453125, 660.64453125 and 880.37109375 Hz. Original table above remains the original run, not substituted evidence.

## Partial source snapshot

HEAD remains the starting HEAD. Execution `b5734e7d-2fc3-4bad-ad90-ec2681b49535` confirms the binary diff of all pre-existing tracked changes still has the starting hash. No existing dirty tracked file changed during this work.

SHA-256 of authored/modified source files, excluding this evolving report:

```text
d05d4ee63cdbce51a6b63ebe73c8a9a69e0db557d8eefafc649103ef7b1acf5c packages/video-contracts/src/clip-timing.ts
6ba935510142d64be0efdd6593708e6a273f74d8c117a3e6aaf11e4e61dd59af packages/video-contracts/src/clip-timing.test.ts
c6422d13570f01e2d5e2331ce463a6e9d275e344804146a99fdce023e6c5c6a5 packages/video-contracts/fixtures/clip-speed-timing.json
8478624e55407f4e79fc53c5f309306521bb65a0b9aeec7a8aa339a2f28a48e3 packages/video-contracts/src/index.ts
38c3082797c42fce220d641ab75ba5d598f2558b81199bd0f81fc907390aa5d6 apps/desktop/src-tauri/src/video/project/clip_timing.rs
ba25122c84e326a9f5d473e80e628f291e65418ed40f1d4dffeca75a18e631b5 apps/desktop/src-tauri/src/video/project/mod.rs
bd09696ab5059723ec111e6301dc6c88b2a2c2f5cff58549c698a3e22c9ea1c5 apps/desktop/src-tauri/src/video/project/integrity.rs
553a70dd8c8b24091549fb7d781f35d5f7224a6137b0c0bcb6397498e45c24f2 scripts/probe-speed-preview.mjs
```

## Step 2 — serialization continuation, 14 September 2026

**Implemented and tested:** optional `ProjectClip.speed` in TypeScript and Rust. Omission remains omission (including V1 migration); no read-time defaults or normalization are injected. Explicit 1/1 is preserved when read, while the edit-normalization primitive returns omission on normal-speed restoration. Legacy V2 fixture canonical bytes and stored state hashes remain unchanged. Restoring omission returns the original hash. This is not yet SetClipSpeed command/history proof.

**Fail-closed boundary:** serialization understands bounded speeds, but TypeScript project admission and native state/snapshot validation reject non-normal speed until canonical editing, preview and export consumers support it. Both render entry points are tested to reject retimed revisions rather than silently discard speed through V1 adaptation. An explicit normal-speed render plan is unchanged. Native InsertClip rejection leaves the base snapshot hash unchanged. These gates must not be removed merely to make later command tests pass; unsupported consumers must remain unreachable throughout integration.

**Coverage:** 27 new TypeScript compatibility cases, seven native compatibility tests and four export-boundary regression cases. Shared fixtures cover 17 invalid wire values (null, zero, negative, fractions, unsafe integers, out-of-domain and unreduced ratios, wrong types, missing and unknown fields) and a real-shaped legacy V1 clip. Non-normal 50/51/150/200% clips round-trip through the TS clip schema and native snapshot serialization with source endpoints/start unchanged. Native admission still rejects these snapshots. No retimed user project was opened or saved.

### Current executed checks

All passing results below use rebuilt workspace dependencies, not stale `dist` exports.

| Check                                                                                                                            | Actual result                                                                                                                                     | Execution                              |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `pnpm build`                                                                                                                     | Exit 0; workspace packages and desktop frontend built. Vite warns about a 551.66 kB JS chunk and plugin timing; not a runtime performance claim.  | `02b887f6-25c0-453e-992d-2e43cc005c45` |
| `pnpm --filter @supa-video/contracts --filter @supa-video/project --filter @supa-video/render test`                              | Exit 0; 214 contracts + 132 project + 30 render tests passed.                                                                                     | `63e99872-4950-48e8-b9ce-3ea6465ede15` |
| `pnpm check` then `pnpm lint`                                                                                                    | Each exited 0, including browser TypeScript config.                                                                                               | `66561fad-f155-44c2-96a3-b42f7f115039` |
| Focused desktop Vitest: ClipInspector, VideoWorkspace, ProgramMonitor, use-video-project, MultitrackTimeline, timeline-move-snap | Exit 0; 116 passed. Unit regression evidence, not actual playback.                                                                                | `6770892b-004b-4452-9688-6227a2be8bb0` |
| `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::project:: --lib` after formatting   | Exit 0; 95 passed, 0 ignored, 243 filtered out. Includes existing real-storage legacy/recovery regression tests; not retimed save/recovery proof. | `3e23bf48-ac2d-4e3c-9ff2-514f50da0383` |
| `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`            | Exit 0.                                                                                                                                           | `7a00f881-5115-455b-a7cb-4b1a9fd5cbea` |
| `git diff --check`                                                                                                               | Exit 0.                                                                                                                                           | `c1d4441e-5df9-4bd1-940b-478c4192484a` |

Scoped Prettier and rustfmt checks on this continuation's changed files each exited 0 (`5c836e44-1b32-4f86-b35f-517fb61f5456`). The report was re-read after formatting. This scoped result does not replace the earlier failed full-tree rustfmt result.

### Failures found and resolved in this continuation

- First package regression execution `6ee0b0dd-2d3e-48f5-a3e7-7880cb49cc7e` exited 1: the new explicit-normal render test hit old strict contracts because downstream imports resolve to built `dist`, not the changed source. Contract-source tests passed, but that run is not passing downstream evidence. Rebuilt the actual workspace; no validator or assertion was weakened. Prior foundation-only downstream checks likewise did not establish integration of the new helper exports.
- First build `6e0acd28-36df-4ff6-bae9-b440d8e6ca4a` exited 2: the new test passed `{ speed: undefined }` to an exact-optional type. Changed the test to omit the property. Subsequent build, type checks and regression suites passed.
- The earlier full rustfmt failure on preserved `video/jobs/store.rs` remains recorded above; unrelated dirty code was not reformatted. This continuation does not relabel that full check as passed.

### Updated source snapshot

HEAD remains `b21a303c51c258d3aa63fa51217bcbb4508fef0f`. Execution `c1d4441e-5df9-4bd1-940b-478c4192484a` reconfirmed the pre-existing tracked diff hash as `c491466f3c174dfd82494d02cbfa8c62614e1fd52fb217edcd3eb7f028d6c22e`; original dirty changes remain untouched. Earlier helper/probe files were not edited in this continuation. Generated build outputs remain outside git.

Current SHA-256 for files added/changed in this continuation (supersedes earlier fingerprints for matching paths):

```text
b401b57502d31dcc60b3521b59a5969fc2dcbbe8f0cb3e25bfc691dbc444c899 packages/video-contracts/src/project-v2-entities.ts
ddabdd320be292fd06a257578e10aeed23971e26929839a3f7982fd9001af41d packages/video-contracts/src/clip-speed-compatibility.test.ts
73257f9ba5c03285f693c7a883191160e67dbf2d1a65a9e305e2312495f748bc packages/video-contracts/fixtures/clip-speed-invalid.json
ea30e5f58ef3359ea9c95e77c59b0d44fd87718ed43c263aa0d7d9e2145cd75e packages/video-contracts/fixtures/clip-speed-legacy-v1.json
abe86c1cff405c4ca509e4c72ff1cfa5d63848a23847efa9df43b1de2d86e8be packages/video-render/src/compile-render-plan.test.ts
229568795e069f392a67e468e6dc314b52e67bc904b257c706cd51fc9f2ef671 apps/desktop/src-tauri/src/video/project/types.rs
e1ce4aee13675bf490efee86568bd1e39b76585a640f2112e1e38935e841c1d7 apps/desktop/src-tauri/src/video/project/integrity.rs
b95736fc5725abeba4e4aeee14964a16dd30ad7ba100a5c98a6c3ef5d5cd54c5 apps/desktop/src-tauri/src/video/project/migration.rs
49d4392b47a9fa1154db05ea5de2acde53292813a350cd957b021e9a420477b2 apps/desktop/src-tauri/src/video/project/mod.rs
f34985f3a05bb3d59e3f84d876d8d46ae01a9d989eb99c22f3a362e19c2561b1 apps/desktop/src-tauri/src/video/project/tests.rs
348af39037e6fc45a9084dcec06202d411176a82db84a153dbd9bda93aaf3518 apps/desktop/src-tauri/src/video/project/clip_speed_compatibility_tests.rs
```

## Remaining

**Steps 1–3 are complete at their bounded implementation checkpoints.** Step 2's historical contracts/metadata evidence is in [step-2-contracts.md](./step-2-contracts.md). The current native execution/history implementation, tests and source fingerprints are in [step-3-execution.md](./step-3-execution.md).

Native SetClipSpeed now uses the existing atomic transaction and undo/redo paths. The TS project-admission and export gates remain closed to unsupported speed-bearing consumers; native retimed split/trim is also gated until step 5. No UI speed control or speed-aware playback/export has been enabled.

Step 4 is next; steps 4–11 remain incomplete. Retimed checkpoint/reopen/journal-only recovery, Windows WebView, speed-aware media export, program-monitor parity and accessibility evidence remain unverified. The latest affected suites passed, including 122 serial desktop tests; the earlier default-parallel startup issue is not claimed fixed. Full workspace/browser/native suites were not run for step 3. No new dependency, commit, publication or parent-phase completion occurred.
