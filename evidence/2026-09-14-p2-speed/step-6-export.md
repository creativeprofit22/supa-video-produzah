# Step 6 — V2 speed-aware export

14 September 2026. Approved plan `77dce439-7822-4159-8c8a-d6ea5b50ec81`, SHA-256 `e1803d381687055114e5855729faeadb0b8434beebe4a636176ac644f2815fec`; canonical step 6 `0eb6c1db2124794b80298aff5a664aa95036d465a93290fd79fad40888011d87`.

**Bounded step-6 criteria satisfied.** This is compiler/validator implementation plus a synthetic filter measurement, not speed completion or production preview/export parity. Stop before step 7. No phase Done requested.

## Implementation and scope

- V2 active-sequence eligibility computes exact retimed duration using the shared helper, then retains the common-start/common-output-duration rule. Same-rate source/project, direct video assets, default gain, dedicated-audio and nested-sequence restrictions remain. Existing geometry, opacity, captions, visibility and mute semantics are preserved.
- Retimed inputs carry exact source boundaries, reduced rational speed and output duration. Omitted/explicit-1x clips retain their old metadata/argv bytes. V1 remains unchanged and its adapter still rejects retimed clips rather than dropping speed.
- Input seek and input `-t` use the **source** boundary/duration. Video trims source frame count, resets PTS, applies reciprocal rational PTS, then retains existing geometry/opacity/fps composition. Audio trims source duration, resets PTS, uses exact two-decimal whole-percent `atempo`, then trims any tail beyond output duration. Output expectation/base/output `-t` use the retimed duration.
- TS plan refinement binds source offset, timing rate and output duration to the plan expectation, in addition to strict timing shape/exact arithmetic. Rust independently repeats exact duration/speed validation, bounded rational-to-microsecond conversion, source-offset/rate checks and canonical argv/filter construction. It compares the entire submitted argument vector against that expected vector; it does not trust frontend filter strings.
- Existing owner-scoped grants, output no-clobber, staging/promotion, argument-array spawning, executable selection and process controls were not changed. Native tests reject another owner, removed timing/speed, mismatched source offsets, changed tempo/PTS/frame trim and injected extra argv. Metadata without matching regenerated arguments remains rejected.

Only five existing source/test files changed in this step: contracts `render-plan.ts`, render compiler and test, native `render.rs` and `tests.rs`. Added `scripts/probe-speed-export.mjs` and this report. No new dependencies, runner changes, test skips, blanket suppressions or weakened tolerances. Previous temporary unsupported-V2 assertions were replaced with positive supported-path and negative inconsistency assertions; V1/normal-speed baselines remain.

## Filter research and measured alignment decision

Authoritative FFmpeg filter docs were located via web search and fetched. The initial anchored fetch returned the table of contents; a read-only fetch extracted actual atempo/atrim/setpts sections in execution `4a7aa78a-5469-47ba-ba43-e0a8aab0caf6` from https://ffmpeg.org/ffmpeg-filters.html. Docs specify tempo range 0.5–100, sample skipping above 2, atrim not resetting timestamps, and reciprocal setpts examples. The product remains 0.5–2; no chaining or pitch-changing `asetrate` is used.

`node scripts/probe-speed-export.mjs` executes only the bundled Windows FFmpeg with fixed synthetic inputs and argument arrays; it writes no user media. It measures 48 kHz PCM sample count and middle-window positive-zero-crossing frequency for a 440 Hz sine, with and without upper-bound trim. A separate 30 fps synthetic video filter run counts framemd5 frames. These are filter measurements, **not full compiler→native→encoded-file or ProgramMonitor proof**.

Final execution `077573da-fc80-485d-9b10-2c86a6468512` reproduced the initial measurement `697aa40c-c602-4dfd-9129-50dfa24854c0`:

| Speed | Source frames | Output video frames | Audio before trim         | Audio after trim                      | Measured pitch after trim |
| ----- | ------------- | ------------------- | ------------------------- | ------------------------------------- | ------------------------- |
| 50%   | 30            | 60                  | 95,016 samples / 1.9795 s | same; **984 samples short (20.5 ms)** | 440.515 Hz                |
| 100%  | 60            | 60                  | 96,000 / 2 s              | same                                  | 440 Hz                    |
| 150%  | 90            | 60                  | 96,128 / 2.002667 s       | 96,000 / 2 s                          | 440 Hz                    |
| 200%  | 120           | 60                  | 95,986 / 1.999708 s       | same; **14 samples short (0.292 ms)** | 440.064 Hz                |

Decision: retain deterministic upper-bound `atrim` to remove the observed tempo tail overrun. **No padding or latency-compensation filter added.** The probe asserts the 60-frame video result, 1% pitch capability and audio upper bound; it explicitly reports deficits, not a false exact-duration pass. These short synthetic runs do not establish a maximum deficit for real content, AAC boundaries, fractional rates or the final media matrix. Step 10 must measure those paths before claiming parity or changing alignment policy.

## Fresh verification

All commands ran in the foreground to final status. Existing dependency outputs were rebuilt before downstream package/desktop checks.

| Execution                              | Checks                                                                                                             | Actual result                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `70d02cff-1c6c-402d-8fdd-b6be93863dae` | Targeted prettier/rustfmt; desktop workspace dependency rebuild; contracts and render tests                        | Exit 0: contracts **261 passed**, initial render **31 passed**. Later two additional render cases were added and rerun below.                                                                                                                                                                                                                                                                       |
| `1b90c9b6-7beb-4ec3-889b-3191ca5ae8d1` | `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::tests::render_ --lib` | Exit 0: **26 passed, 5 existing ignored, 329 filtered**. Speed metadata/argv negatives, owner checks, normal-speed/geometry/opacity/caption/no-clobber/cancel baselines and existing bundled caption tests passed. The five ignored tests require local/system tools/fixtures; they were not run or added by this step.                                                                             |
| `4ccbef45-3889-4dc9-8f5c-ab6ac31e0658` | Final render tests; `pnpm -r check`; focused desktop serial run                                                    | Exit 0: render **33 passed** including equal-retimed/unequal-source duration layers and hidden/muted restrictions; all workspace type checks passed. Desktop **41 passed in 2 files** (ProgramMonitor 34, VideoWorkspace 7). The command also named nonexistent `src/use-video-render.test.tsx`; it did not run a third suite. File discovery confirmed no matching render-named desktop test file. |
| `adbf29da-6157-4a86-a45f-7276c86a826b` | Targeted lint after probe formatting                                                                               | Exit 1: new probe referenced global console without a lint environment declaration. Fixed with explicit `node:console` import, not suppression. Because of `&&`, native/probe checks later in this command did not run.                                                                                                                                                                             |
| `077573da-fc80-485d-9b10-2c86a6468512` | Targeted ESLint; native `multitrack_render_plan` test; final probe; `git diff --check`                             | Exit 0. Lint passed; **1 native multitrack test passed**, 359 filtered; probe results above; whitespace check passed.                                                                                                                                                                                                                                                                               |

The only post-native-test source mutation was the standalone measurement script's console import. Production compiler/native source did not change after their passing checks. Contract code did not change after its 261-test pass. No earlier 432-package or 115-project pass is claimed freshly rerun for this step.

**Unresolved historical findings:** default-parallel desktop worker startup was not rerun/repaired; the 41 desktop passes are serial, not parallel proof. Broader native/performance and full-tree formatting findings remain separate. These checks do not certify the app or clear step 10.

## Diff review and preservation

Actual complete formatted scoped diff read from `3766599e-688f-4c1d-ba90-1ad3fc846605` (through EOF), not merely its capped terminal tail; new probe reread directly after formatting. Inspection included strict metadata, native independent recomputation, exact vectors, unchanged non-speed rendering and current tests. Logs include sanitization/stdout markers rather than source edits. No unrelated cleanup.

Snapshot execution `5ba7741f-b266-40b2-b4c3-8b715c67afe3` recomputed the preserved unrelated tracked diff as `c491466f3c174dfd82494d02cbfa8c62614e1fd52fb217edcd3eb7f028d6c22e`, matching the original boundary. Approved plan hash unchanged.

Final SHA-256:

- contracts render schema: `4ff4afe0c06b14ed9ee1500c3ff5ae99acc7438a56f26b3f021fcb6408b18302`
- TS compiler: `f790375ea50785201eb797d6ba87c16120d65d48b1072ed3e1c252c258634800`
- TS compiler tests: `261dcabb99ed07b6cd070402229cd6ad7ec7e7305062e3fcb082c5ac331d80a8`
- native renderer: `15115512ea351cbb4d8a90937dcc79e53475589bfd1709714620fe736831719c`
- native video tests: `46cb0745f6c39961ab090236961be40eb4be9f6a89ed424d4bcd861321cef809`
- measurement script: `97b296126fdd79e2c359be35c16e91fc6c454254f54984ad5b2a97ecaba5923f`

## Checkpoint

Progress saved at Notes revision 170 (`p2-speed-step6-export-implemented-20260914`). Supported `roadmap_checkpoint` with expected revision 170, the unchanged approved hash and exact step-6 ID returned **committed**, Notes revision **171**. Step 6 is checkpointed. Stopped before step 7; speed and phase remain in-progress, not Done.
