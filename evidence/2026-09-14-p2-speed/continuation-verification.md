# Speed continuation — implementation and verification status

14 September 2026. User authorized continuing the entire approved speed plan, not stopping after each step. Plan `77dce439-7822-4159-8c8a-d6ea5b50ec81`, hash `e1803d381687055114e5855729faeadb0b8434beebe4a636176ac644f2815fec` unchanged. **Steps 7–9 criteria are satisfied; step 10 and final plan closure are not.** No speed/phase Done claim.

## Implemented and bounded verification

- **Step 7:** exact percentage draft, presets, resulting sequence duration, Apply/Reset, saving/errors, locked/context rejection, stale draft reset, canonical controller and mock execution/invalidation. Native remains authoritative. Original-group caption lineage protection is retained in mock preflight. Canonical integration checks Apply/Reset/Undo/Redo and zero commands while drafting. `step-7-inspector.md` records initial 138 focused passes and 1 integration pass. A later real keyboard test found lost focus after adoption; `focus-apply.md` records red reproduction and fixed selection-scoped one-shot restoration, no pointer focus stealing. Its final 7 browser/11 unit/type/lint checks pass. No transform/opacity policy change.
- **Step 8:** layer playback rate and preserved pitch, fractional source/sequence mapping, independent media clock, exact source offsets, follower mapping, handoff, pause/end/source/final behavior, and explicit unsupported states. Source audition/final media remain 1x. Two actual regressions were fixed at shared causes: decoded-frame cadence made the clock stale (`clock-root-cause.md`), and browser microsecond truncation put fractional seeks on the previous frame (`seek-boundary-fix.md`). No tolerance was widened. Final real browser playback suite is 6/6. Actual Windows WebView final clock/pitch observations pass all four speeds; see `step-10-webview-final.md`. This is not a claim that the separate live A/V output-capture gate passes.
- **Step 9:** 7 browser checks cover keyboard, actual post-Apply/error focus, no-command drafts, one Apply, reset/fixture undo, revision/selection changes, locking/saving, errors, 320px, 200% text, long names, forced colors/RTL and scoped axe scans. Parent visually inspected `step-9-narrow.png` and `step-9-text-200.png`: no control clipping, wrapping/actions/focus visible. Real canonical history is separately covered by integration/native persistence, not attributed to the fixture's mock Undo. No WCAG-wide certification or assistive-technology audit claimed.

## Actual export and shared-media proof

New native tests execute production TS compiler output through normal grant validation and the native executor using bundled FFmpeg. Generated sources encode frame IDs and a synchronized burst plus 1kHz tone. The matrix is 50/100/150/200% × 30/1 and 30000/1001, source-in frame 30, 60 output frames. Checks decode actual video frames and PCM, probe stream durations, compare the burst/frame timing, and reject a deliberate pitch-shift control. All eight matrix rows pass unchanged one-frame cadence/A/V/end limits and 1% pitch limits. Maximum measured export cadence delta is one frame at 50%; the largest shown burst offset is 16.8ms. Real browser shared-source/export seek comparisons pass all eight cases after the boundary fix.

The two new native media tests were initially authored as opt-in tests by a helper. Parent removed both new `ignore` attributes and reran them normally; **no new ignored tests remain**. Windows-only compilation reflects the Windows bundled-tools fixture. Requirements are provisioned bundled tools plus built TS workspace packages, not a validator/executor bypass. Existing unrelated ignored tests remain unchanged.

## Fresh final executions and provenance

| Execution | Result |
| --- | --- |
| `34be96a5-0814-4a22-b621-8725ad36f135` | `pnpm -r check && pnpm test`: exit 0, **775 tests** (261 contracts, 33 render, 44 media, 137 project, 300 desktop). Ordinary configured desktop execution, not the serial fallback. This preceded the final focus-only fix; its affected checks were rerun below. |
| `4bfda7a0-48eb-4937-abeb-f8e91ef13bff` | Targeted formatter, whole `pnpm lint`, probe syntax check, **115 native project tests** and actual native production-compiler media matrix: exit 0. A previous lint failure for newly authored JS/CJS ambient globals was fixed with explicit Node imports/globalThis, not suppressions. |
| `cb779cd8-b8e4-4fd3-8320-70e4687be81c` | Final real ProgramMonitor browser **6/6** and inspector browser **7/7**, exit 0. Inspector rerun again after final focus fix as recorded in focus-apply.md; browser playback production was unchanged afterward. |
| `6b0ba97e-5945-418f-b1b3-53f4d8d0c563` | Shared actual preview/export decoded-seek tests **8/8** after boundary fix, unchanged frame assertions. |
| `d6ab0aab-661b-40d4-a916-9b4f81e4f6ee` | Actual isolated Windows WebView final probe: all four rate/pitch/clock gates pass. Gate evaluation `83974d15-b985-4e1b-806a-e45c65154223` exit 0. |
| `3241c136-ce34-4278-8daf-d6e48aeb40e4` | Ordinary debug app build without probe `TAURI_CONFIG`, exit 0, restored the regular binary. Isolated probe and dev server stopped by exact owned process IDs; no package configuration relaxed. |
| `c7ddc51c-6238-4ced-accc-649117152292` | After removing new ignores: **3 native speed tests passed, 0 ignored, 359 filtered**, including both actual media tests and the metadata/argv test. Canonical speed workflow **1 passed, 20 filtered by `-t`**, then `git diff --check` passed. The 20 filtered tests were not disabled in source. |

The old default-parallel worker-startup failure remains historical. It did **not** recur in the current complete configured `pnpm test`; that does not establish a causal repair or universal repeatability. No worker policy/timeouts were changed in this continuation. Broad native/performance/other-platform findings are not cleared by scoped passing results.

## Unresolved live A/V capture gate — do not mark passed

`ProgramMonitorSharedParity.spec.ts` retains the unchanged one-sequence-frame live A/V assertion. The initial measurement had 12 failures out of 16 live preview/final cases. The rig changes the signal path to `HTMLMediaElement -> AudioContext -> AudioWorklet -> output`, then compares mapped audio output clock with rVFC expected display time. Authoritative API investigation and its limitations are in `av-measurement-diagnosis.md`; no unmeasured latency subtraction was adopted.

A minimal **raw HTML video control with no React, ProgramMonitor, seeking or retiming** was added and executed against the exact native 1x output. `6c06924c-14fb-4ac6-b8f6-53e4692b2d7f`, exit 1, measured **47.40ms / 1.422 frames**, also failing the unchanged gate. This establishes that the measured failure does not require the application. It does not prove whether capture-path latency, browser output scheduling, or both are responsible, and does not prove the original unmodified playback path passes. The failing rig/control are preserved for diagnosis, not deleted, skipped, offset-corrected or treated as product proof.

Available-tool catalog search found no synchronized native output-capture tool. Bundled FFmpeg device enumeration `88af9251-36f7-411c-a723-e2253cf6258b` supports dshow/gdigrab but not a WASAPI loopback input. Device listing `4dd2025c-1779-4e22-bacd-8f5feaf6aee9` lists webcam/microphones, **no loopback recording source**. No microphone recording or desktop/system audio capture occurred. Device identifiers are not copied into this report.

Historical permission request (subsequently approved; see follow-up below): authorize a local test-window/system-audio capture method (not microphone; other apps' audio must be closed), or provide an already calibrated equivalent capture. That permission is material because loopback can include other applications' audio. A local loopback implementation/calibration remains work; authorization alone would not establish the gate. No external upload, dependency installation or recording consent is inferred from the current tests.

Until an unmodified-output measurement is validated and the matrix passes, **step 10 is incomplete and step 11 cannot close the plan**. Save/reopen/history has native proof, but no single all-in-one captured reopened-project/mixed-layer session is claimed. All remaining broad-media cases must be reconciled before completion, not silently replaced by the passing single-clip matrix.

## Preservation and review

HEAD unchanged: `b21a303c51c258d3aa63fa51217bcbb4508fef0f`. Final original preserved-work diff fingerprint remains `c491466f3c174dfd82494d02cbfa8c62614e1fd52fb217edcd3eb7f028d6c22e` (`544344f7-240b-4eab-8bb9-dee3b1e2e992`). No commit/push or data/project deletion. New generated MP4s and trace archives are ignored; markdown and intentional proof remain reviewable. Whole local evidence directory is not a release artifact.

Parent reread the complete 983-line final core-consumer diff `015ceb77-6d86-4a6f-bf72-49eeafe6c7e5` in contiguous ranges 1–310/311–620/621–930/931–EOF, plus new helpers and native shared-media test source. Focus and media-seek fixes have separate actual red-to-green tests. No exhaustive application security/performance audit is claimed.

## Roadmap response

Progress saved at Notes revision172 (`speed-continuation-steps7to9-verified-20260914`). Supported ordered checkpoints for steps7/8/9 each returned **committed**, revisions173/174/175 respectively, using the unchanged approved hash. No checkpoint for10/11, no speed or phase Done. Current implementation is preserved. The user subsequently authorized local output capture; the permission blocker is resolved, but calibration/platform blockers below remain.

## Authorized capture follow-up

Local default-render WASAPI recording and exact-HWND Windows Graphics Capture were built and exercised after explicit authorization. No microphone or upload was used. See [output-capture-final.md](output-capture-final.md) for actual runs, API/source provenance, failures, script verification and owned-process cleanup.

The WGC run recovered 480 visual frames/three flash onsets, but system loopback contained four transients for the three-transient source. Parent analysis `6779cd5a-e5a4-4b67-9473-218c36c510bf` shows the extra sound lasts about210ms with peak0.94, unlike the expected100ms/0.51 source bursts. It was not silently dropped. API clock sanity also remains uncalibrated: acquisition/readback can precede compositor SystemRelativeTime by roughly31ms (`47e5249d-3ca3-4515-ada0-45578a10d9cd`). No delay subtraction or A/V pass is justified by those observations.

The next attempted isolation method is unavailable under the official OS contract: this host is Windows10Pro **19045.6466**, while Microsoft's per-process loopback sample/API requires **20348+**. Installing another SDK would not change that operating-system requirement. No unsupported activation, OS upgrade, muting of unrelated apps or security-control bypass was attempted.

A supported recording host with validated window/audio timing (or equivalent calibrated captured evidence) is needed to finish the outstanding matrix honestly. All owned recorders, browsers and servers are stopped. Production implementation was not altered by local capture research; whole lint and all eight local harness syntax checks passed afterward. Steps10/11 and speed/phase completion remain blocked, not passed. Supported Roadmap update `speed-output-capture-platform-blocker-20260914` committed at Notes revision176 with status **blocked**, preserving completed checkpoints1–9. Required external action is a supported recording host/calibrated capture evidence; no OS upgrade authorization or relaxed acceptance was inferred.
