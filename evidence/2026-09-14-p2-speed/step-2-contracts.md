# Step 2 complete — speed contracts, render metadata, native duration

14 September 2026. This closes the approved plan's **contract/exact-time foundation step only**, not the editor-controls phase or the speed feature. No speed editing, non-normal program playback, or retimed export has been enabled.

## Changes

- TypeScript and Rust recognize strict `SetClipSpeed` with the existing field-specific command IDs/targets and required bounded reduced rational speed. Both test every integer percentage from 50 through 200 and reject the shared 17 invalid speed payloads, missing speed and extra fields.
- Native command execution and the desktop fixture explicitly reject this command pending step 3. Native lock-target classification includes it. No failed command advances state/revision or gets a successful command result.
- `RenderVideoInputV2.timing` is an optional **atomic bundle**: exact `sourceIn`, `sourceOut`, required `speed`, and exact retimed `outputDuration` (including its output frame rate). Omission keeps legacy V2 plans unchanged; null is invalid. Both languages verify the mathematical duration at the metadata decoding boundary and reject missing/unknown fields and tampered output duration.
- TypeScript full-plan validation and native production argv validation reject any new timing bundle, even normal-speed metadata, until step 6 consumes it. Existing non-normal project-admission gates remain. The existing `sourceInMicroseconds` field is retained for legacy plans; step 6 still needs to bind it and all new timing metadata independently to compiled filters/argv. No timing metadata may be silently ignored.
- Commands and integrity/overlap checks now use one native `project_clip_timeline_duration` helper. The duplicate integrity rescale implementation was removed. Split/source-offset conversion remains later step-5 work; this checkpoint does not claim every timing consumer has been upgraded.
- Shared 21-case duration fixtures now exercise the native ProjectClip duration entry point and both render metadata contracts. Coverage includes normal/bounds, 51%, mixed/fractional frame rates, cancellation before division, zero/reversed/mismatched ranges, inexact boundaries and overflow. Native integration verifies 60 fps source → 30 fps timeline adjacency, overlap rejection, inexact-boundary rejection and moved affected ranges.

## Verification performed

Workspace dependencies were rebuilt **before** downstream regression tests. No dependencies, toolchain settings, test assertions or timeouts were weakened.

| Command/check                                                                                                         | Observed result                                                                                                                                                                                                  | Execution ID                           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `pnpm build`                                                                                                          | Exit 0; all workspace dependencies and desktop frontend built. Vite warned about a 553.33 kB JS chunk and CSS plugin timing. Not runtime performance proof.                                                      | `92f984eb-0b1f-4b34-aabd-751c32b9720c` |
| `pnpm --filter @supa-video/contracts --filter @supa-video/project --filter @supa-video/render test`                   | Exit 0; 256 contracts, 132 project, 34 render tests passed.                                                                                                                                                      | `2316ddc9-060b-4e7f-944b-86d9c8cd4d93` |
| Final `pnpm --filter @supa-video/contracts test`, `pnpm check`, `pnpm lint` after the test-only lint fix              | Each exited 0; 256 contract tests. No production TypeScript source changed after the workspace build.                                                                                                            | `4dbd4993-1911-4a1e-a0df-577986060a08` |
| `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::project:: --lib`         | Exit 0; 100 passed, 0 ignored, 244 filtered out. Includes existing legacy/hash/storage/recovery regression tests. Not retimed persistence proof.                                                                 | `e42c5de7-a02f-44b5-bf42-3942a2429335` |
| `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::tests::render --lib`     | Exit 0; 25 passed, 5 ignored, 314 filtered out. New native metadata-rejection test passed. Five existing bundled normal-speed caption-boundary media tests also ran; none establishes speed/pitch export parity. | `8eb67a80-1dc1-450d-b2e3-eb21d1c02c7b` |
| Focused desktop run: mock service, snap, inspector, workspace, monitor, controller, timeline                          | **Exit 1.** Mock service's 6 tests and snap's 5 tests passed; five DOM workers timed out before starting. Do not interpret the 11 passes as a successful run.                                                    | `964cfa6e-f820-445a-9372-3447b69bb213` |
| One diagnostic run of the five affected DOM files with `--maxWorkers=1`                                               | Exit 0; 111 passed. No test or timeout changes. This establishes serial test results, not that default parallel startup is repaired.                                                                             | `8a0c283a-c23a-4eb5-a348-8d54c33b1c97` |
| `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings` | Exit 0.                                                                                                                                                                                                          | `003c5db4-c429-4ebb-924a-7013f685c413` |
| Scoped Prettier, scoped rustfmt `--check --config skip_children=true`, `git diff --check`                             | Each exited 0. No unrelated native job-store formatting changes.                                                                                                                                                 | `0e4c34c0-05fb-4ec9-bff2-fce34e285567` |

### Failures and diagnostics retained

- First native project test compile exited 101 because my new render test used an unqualified `json!` macro (`c2cd0453-8a0b-475a-b68a-68ceb5273a91`). Qualified it as `serde_json::json!`; subsequent native project/render tests and Clippy passed.
- First lint exited 1 for an unused destructured variable in the new TS test; type checks in that invocation passed (`db9892a8-ebf7-45d8-aacd-3b93f4da2567`). Replaced the test's field-removal setup with a cloned object and explicit deletion; assertions unchanged. Final checks passed.
- Editor diagnostics initially saw the old built command union before the rebuild; full build/type checks verified the updated export. A new render test referenced an undefined local rate; corrected it to the compiled plan's expected rate before the successful build/tests.
- The default-parallel DOM worker startup failure remains unresolved; a single serial diagnostic passed. No unrelated test-runner reliability repair is claimed or attempted.
- The earlier full-tree rustfmt failure on pre-existing job-store formatting remains recorded in README; only changed-file formatting was checked here.

## Source and preservation

HEAD: `b21a303c51c258d3aa63fa51217bcbb4508fef0f` (unchanged).

The tracked binary diff outside the speed-owned paths still hashes to the original `c491466f3c174dfd82494d02cbfa8c62614e1fd52fb217edcd3eb7f028d6c22e`. Execution `3e202e14-e88c-43cf-bc00-d185b0582ea0` records that check and the fingerprints below. Pre-existing tracked dirty work remains untouched. Generated build outputs are not staged or committed; no git history operation was performed.

Current SHA-256 of this continuation's source files (supersedes earlier fingerprints for matching paths):

```text
1cff3d0ffff5d84e1ae7a0efed652569e624538f665e0716ada0576b3103fe72 packages/video-contracts/src/project-commands-v2.ts
e25a85eb3752ee1ec8c3a929666879f9de405c74bcd88c7e5cb09a748849d777 packages/video-contracts/src/render-plan.ts
0b1f6238299c80c7f8a82e553838b8f061d30fc584557ae6db1bad6cdabedab4 packages/video-contracts/src/clip-speed-contract.test.ts
e2350cf9362de41dcec06622dc89b752ea5772987537671bdcbdf9e9d348e724 packages/video-contracts/fixtures/clip-speed-command.json
ffb6ca3908fb66e89de147e5792ca23fac5fa4c62b6a97e073cbaeb2e092fcbb packages/video-render/src/compile-render-plan.test.ts
4f7a233ebceaf53b3ec2bd781fbadc0e45c45df7dcfd174d295ee5898da8b4e5 apps/desktop/src/test-video-service.ts
28483f41c113e4bb0769f6d2a5a8c40e4b4e3a721fa17b2262f288b20a5018e9 apps/desktop/src/test-video-service.test.ts
d3a59022bf0929ba4952a98a5b65fb18d3ed8f97ef85611582329ecd8b065872 apps/desktop/src-tauri/src/video/project/clip_timing.rs
550dfb0e38434e33791388d7e3337f7fd476fcf36af57f4ba5f6c3a58e24a630 apps/desktop/src-tauri/src/video/project/types.rs
3f2fca32c4efcdda71e1faacae3d13f95fa58af535f926864939d4206f0606d2 apps/desktop/src-tauri/src/video/project/integrity.rs
90886ee920ac4bf51dbc926569016e923181bd88ad0f191a233532991d2a5bf9 apps/desktop/src-tauri/src/video/project/commands.rs
c81ef1aba87c87fecc7667efa4c3b7745f74c96a92a8ce61fadbe717beba9b50 apps/desktop/src-tauri/src/video/project/mod.rs
9ef45d7574e5619f615c9d613f98ab14b468c66dc7678908d9fc9badd552cfb7 apps/desktop/src-tauri/src/video/project/speed_contract_tests.rs
85f043dd559867c13c434d5c7f736da3b44fa27a46f787c4c2d0a5bd8b28196d apps/desktop/src-tauri/src/video/types.rs
520ccb0d296eab3380edfd9c8dc8e0f291ca3c74504f37d07a5b6d21f1475797 apps/desktop/src-tauri/src/video/render.rs
0f701d560ccd006cd0d4fd8d55d90138477ba47e82a3b562adb105d1ebf848da apps/desktop/src-tauri/src/video/tests.rs
```

The final production diff and formatted tests were re-read. Language-server reference lookup failed for the native duration helper; its direct imports/calls and regression tests were inspected instead. No claim of a successful language-server trace is made.

## Next boundary

Step 3 is next: atomic speed execution, inverse/history/affected ranges and contextual caption/nested guards. Existing temporary admission gates must remain effective for unsupported UI/preview/export consumers; replacing them requires the corresponding planned support, not simply deleting tests. Steps 3–11 are not complete. Full workspace/browser/native suites, Windows WebView, speed-aware real media, pitch/export parity and native accessibility remain unverified. No whole-phase Done status is authorized or claimed.
