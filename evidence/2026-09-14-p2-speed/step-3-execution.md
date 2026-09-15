# Step 3 — atomic native speed execution and history

14 September 2026. Step 3 is complete at the native command/history boundary. The speed control, program playback, export and full persistence/recovery matrix remain later steps; no parent Roadmap phase completion is claimed.

## Implemented behavior

- `SetClipSpeed` now executes inside the existing cloned command group, final native state validation, history transition and service journal transaction. It changes only optional speed. Source endpoints, timeline start, later clips, other tracks, markers, manual captions, mute/visibility, opacity and gain remain unchanged.
- Old/new affected ranges use the exact native helper; invalid, overflowing and inexact durations fail. Half-open endpoint adjacency is accepted; same-track extension into a following clip is rejected by final group validation. Faster speed leaves a gap, without ripple.
- Normal-speed edits normalize to omission. Same-value commands retain existing field-command history behavior (an accepted revision), rather than inventing a no-op convention.
- Private `RestoreClipSpeed` preserves the exact prior representation: null in this inverse means omitted clip speed; explicit 1/1 and non-normal rationals are retained exactly. It is strict, requires the nullable field, and is rejected in live requests and forward history in both contracts. This is necessary to restore hashes of files that explicitly stored 1/1 without rewriting their read-time representation.
- Native lock checks include both speed variants. Successful groups expose readable summary and timeline/preview/audio-mix/render-plan invalidation metadata. No new persistence service or migration was introduced.
- Direct-asset video clips only. Dedicated audio targets, sequence-source clips and clips inside referenced child sequences are rejected for retiming. Loaded-state validation applies the same restrictions.
- Matching managed-caption source identities reject retiming. Missing asset identity also rejects when managed captions exist because independence cannot be proved. A provably different source identity is allowed. This conservative rule guards an entire matching source lineage, not individual caption source spans; no caption retiming or detachment is implemented. Base-group preflight rejects a group that clears managed captions before changing an existing referenced clip's speed. Manual captions retain their exact bytes.
- `CODE`: final loaded-state context validation indexes nested references and asset/managed-source identities once, rather than scanning the whole project for every retimed clip. No runtime performance improvement is claimed.

## Gates intentionally retained

Native canonical project state may now contain supported speed edits. **The TypeScript project-admission gate still rejects non-normal speed**, so unchanged timeline/monitor/export consumers do not receive those projects. The desktop UI fixture still rejects speed execution until its timing/controller wiring is implemented; it also rejects the private restore command.

Both export compiler entry points continue to reject retimed revisions, and full TS/native render validation continues to reject the new exact timing metadata. Native split/trim operations on retimed clips are explicitly rejected until their source-boundary mapping is upgraded in step 5. No speed-bearing project was passed into the production monitor or rendered in this step.

## Current proof

Eight new native test functions include multi-case matrices, plus four new TS inverse-history cases. Existing native contract cases now execute all 151 speed percentages against a 30-frame fixture: only exact durations succeed, and each successful result's inverse restores the base state. Earlier blanket native-admission assertions were replaced with exact-duration/native-context assertions; TS playback/export rejection assertions remain intact.

New native tests prove:

- 50/100/150/200% successful revisions, exact old/new ranges and four invalidations; full-state equality except speed, including non-default opacity/gain/mute/hidden fields.
- Exact adjacency after slowing, cross-track independence, and rejection of currently unsupported retimed split/trim.
- Normal-speed omission, same-value revision behavior, exact inverse restoration of omitted/explicit-1x/non-normal speed, undo and redo hashes, and history-stack movement.
- Actual service execution against **fresh temporary projects**, exact retry results, undo/redo after a failed group, and rejection without inspector/revision changes, retry-result publication, or changes to authoritative snapshot/journal bytes.
- Service rejection cases: locked target, same-track overlap, invalid speed, inexact duration, overflow, stale revision, zero source range in a group, and a later command failure after a speed mutation in the working copy.
- Context rejections for managed captions and nested sequences through service transactions, matching loaded-state guards, direct nested/audio target rejection, and prevention of implicit caption detachment. Private inverse wire shape/live submission is tested in Rust and TS.

These are active-session transactional tests, **not** the step-4 retimed checkpoint/save/reopen/journal-only recovery matrix.

## Executed checks

| Check                                                                                                                 | Actual result                                                                                                                                       | Execution ID                           |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Scoped formatters, then `pnpm build`                                                                                  | Exit 0. Workspace dependencies rebuilt before regressions. Vite reports a 553.48 kB JS chunk warning; no bundle/runtime optimization claim.         | `d7339ada-9c21-46e2-ba11-3a9e98031c5f` |
| Contracts/project/render tests, then `pnpm check`, then `pnpm lint`                                                   | Each exit 0; 260 + 132 + 34 = 426 package tests. No TS source changes afterward.                                                                    | `7824c13b-c34f-470a-81ac-6da2f31f05bb` |
| Focused native speed-edit tests after fixture fix                                                                     | Exit 0; 8 passed, 0 ignored, 344 filtered out.                                                                                                      | `fb737c26-4e4c-470c-8bee-58a10c0155c5` |
| `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::project:: --lib`         | Exit 0; 108 passed, 0 ignored, 244 filtered out. Includes existing legacy/storage/recovery regressions.                                             | `84658714-c845-41f3-bcfb-044f0662cde5` |
| Focused desktop Vitest with `--maxWorkers=1`: mock service, inspector, workspace, monitor, controller, timeline, snap | Exit 0; 122 passed. Serial execution selected because the earlier default-parallel worker-startup failure remains unresolved; not a claimed repair. | `9564fe0b-75d6-404b-8bca-0acd768d274d` |
| Native `render_clip_timing_metadata_is_rejected_until_argv_support_is_implemented` test                               | Exit 0; 1 passed, 351 filtered out.                                                                                                                 | `5331e1c6-55df-469b-9730-7f7d01e43bfa` |
| `cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings` | Exit 0 after the preceding gate test.                                                                                                               | `5331e1c6-55df-469b-9730-7f7d01e43bfa` |
| Changed-file Prettier/rustfmt checks and `git diff --check`                                                           | Exit 0 for each. Native files were formatted without following module children into unrelated dirty work.                                           | `6b0f3621-16c5-4c96-b095-f8d225404114` |

### Failures resolved, not hidden

1. First native compile exited 101: the new context lookup compared `ProjectUuid` with `String` (`9ed4d985-e16b-4881-8fad-4da8d223fb84`). Changed it to compare the existing canonical string view; no UUID validation was weakened.
2. Next native project run exited 101: 105 passed, two new tests failed because their broad directory-reader tried to read Windows' intentionally locked `project.lock` (`a7d05b63-f19c-4845-935b-52774fd8a78a`). The corrected test checks the authoritative snapshot and journal bytes directly. No lock was bypassed, timeout changed, production behavior changed, or persistence assertion dropped.
3. Editor diagnostics briefly used the stale built command union. The subsequent workspace build, type checks and tests passed against the rebuilt dependencies.

Earlier full-tree rustfmt and default-parallel desktop startup failures remain historical unresolved findings, not passing results. The full native suite and browser suite were not run here. Speed-aware media, pitch, Windows WebView and accessibility evidence remain unverified.

## Source snapshot and preserved work

HEAD remains `b21a303c51c258d3aa63fa51217bcbb4508fef0f`. The original tracked binary diff outside speed-owned paths remains `c491466f3c174dfd82494d02cbfa8c62614e1fd52fb217edcd3eb7f028d6c22e` (`6b0f3621-16c5-4c96-b095-f8d225404114`). Unrelated dirty changes were not edited. No dependency installation, commit, publication or Roadmap Done transition occurred.

Source SHA-256 for this step (supersedes earlier hashes for matching paths):

```text
fa42c66619649223c1e20737768cafce42b8cd2b02ee9c342e78bc9e33fb7266 packages/video-contracts/src/project-commands-v2.ts
81b50742bee588e72c3e14eb393e19841f672238447043e8839dcbb99bdcdb73 packages/video-contracts/src/project-v2.ts
6e1d29b5a64f9f3954f89b36fa5d44afaefade779c3716551e3137fcab19a105 packages/video-contracts/src/clip-speed-history.test.ts
eb52e86d60469a482d683ee76f5bc8c7a214ae1a16bd643a027a4c25f40e4e1c apps/desktop/src/test-video-service.ts
9535d009fbda974549b799d1b1af2d0fe4cd7823e48fa47a5e23b5fa46c75803 apps/desktop/src-tauri/src/video/project/clip_speed.rs
ab74f87b4e3cb29a98c1afbbff25755400c039d167871b02674223eb32af68d6 apps/desktop/src-tauri/src/video/project/commands.rs
04572c4c123407008f6d2e18b4225eca447198dc2f0831b9f83fcd68319b6d34 apps/desktop/src-tauri/src/video/project/integrity.rs
4d91332105dfb0141a5fb679dd1596a0f292842055fb7bb1936e956a78091f2f apps/desktop/src-tauri/src/video/project/types.rs
a63ae371e61c8b055c07eb19a4f5410006783633066f984bc26d6ba9232db959 apps/desktop/src-tauri/src/video/project/mod.rs
690f5c3f48cac61663de65375bac8a9d78e0620f604d4df3b661fdb7d62abc9a apps/desktop/src-tauri/src/video/project/speed_contract_tests.rs
0041ba3182b98f57bca06f5ed1ebfac4f28898b5b58dd6d1ec45c8979cded2e3 apps/desktop/src-tauri/src/video/project/clip_speed_compatibility_tests.rs
bc941cabbbd0107208aa729d98b46be7de8c111c6f5540a377487dcfdd00d9a4 apps/desktop/src-tauri/src/video/project/speed_edit_tests.rs
```

The actual diff and new context validator were reviewed; formatted files were re-read. Next is step 4's real-storage recovery/save/reopen verification. Steps 4–11 and the overall speed feature remain incomplete.
