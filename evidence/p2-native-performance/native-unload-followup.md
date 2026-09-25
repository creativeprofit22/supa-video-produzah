# Native media-window follow-up — bounded check passed

## Outcome — RUNTIME, 2026-09-20 UTC

On the user's subsequent “go”, the unloading assertion was investigated, the evidence driver corrected, and one bounded native playback/seek run completed. No application source changed. **The scoped native check passed; broader P2 acceptance remains incomplete.** The original failed run and report are preserved unchanged.

Root cause of the earlier assertion failure: the harness used `currentSrc === ""` as a proxy for released media, but Chromium/WebView retains that string after `load()` resets media with no remaining source. The old string is not a reliable indication of live buffers. The corrected check observes actual exposed media state and events, with a negative control that fails when `load()` is omitted. This is not proof that every internal allocator/decoder resource is freed or that long-term memory is flat.

## Reproduction and hypothesis discrimination

- Minimal agent-runner command: `node --test evidence/p2-native-performance/media-unload.test.mjs`.
- Initial exploratory reproduction `f8f42d20-0e50-47bf-973c-a57b5ece9133` failed but used the browser's built-in media document, whose nested source remained. This confound was removed before drawing the conclusion.
- Corrected one-element reproduction `60af2493-b91c-46b9-8299-450ffa3928d6` failed the original empty-URL assertion in about 0.62 seconds. An ordinary explicitly sourced element, detached/paused/source removed/`load()` called, retained the prior URL after 250 ms while `readyState`, `networkState`, buffered ranges and seekable ranges were all zero. React, the 1,000-item timeline, IPC and native preparation are unnecessary to reproduce this property behavior.
- Hypotheses: stale URL reporting; delayed cleanup; retained media data. Subsequent real-media controls compare identical operations with and without `load()`. Removing/pausing/source removal alone fails the resource-state predicate; calling `load()` passes and produces `emptied`. Both controls run against actual browser media, not mocks.
- Native observations retain immediate and one-second-later snapshots plus `abort`/`emptied`/loading/error events. All ten detached elements already showed zero readiness/network/buffered/seekable values at immediate inspection and remained reset a second later; all ten emitted `emptied`. All ten still reported the old URL. This supports stale URL reporting rather than a delayed exposed-state reset or loaded media in these ten observations.
- The WHATWG [media resource location section](https://html.spec.whatwg.org/multipage/media.html#location-of-the-media-resource), fetched during the investigation, distinguishes source-attribute removal from invoking the load algorithm and describes `currentSrc` as resource-selection state. The implementation-specific retained URL conclusion is based on the actual reproductions above, not a claim of standards conformance inferred from documentation.

## Evidence-driver changes (CODE)

`media-unload.mjs` captures at most seven fixture media elements and 32 events per element, retains before/immediate/settled snapshots, then removes listeners and retained references. It does not invoke `load()`, alter sources or repair the application while observing. The driver now requires detached/paused state, no source attribute/object/child source, HAVE_NOTHING, NETWORK_EMPTY, empty buffered/seekable ranges and zero video dimensions. Previously loaded elements must emit `emptied`; truncated event evidence fails. The previous URL remains in evidence instead of being silently discarded.

`media-unload.test.mjs` exercises the same capture/inspection/predicate functions in a real browser, covering successful reset, a deliberately missing-reset negative control, and probe disposal. The original empty-string assertion was replaced only after its independent false positive was reproduced; source/readiness checks were retained and extended with event/network/buffer/dimension checks. No application assertion, timeout, loading behavior or security policy was relaxed.

## Native runtime and identity

- Execution `fab160bc-3151-4da4-a3a9-1a8e6ad0798f`, exit **0**, includes final two real-media tests, explicit ESLint and one native run, approximately 112 seconds total.
- New artifacts: `runs/native-window-IHiFW0/`; result SHA-256 `a6c76e740e909b7573b6691745ea9d9eeb96e98a882bc6b2c400e1a847551cbd`.
- Reused the freshly built, fixed-source release `runs/release-x7bGX5/receipt.json`, not a pre-fix native release. Executable SHA-256 `00a63c0fbe42e3bf8caeda7e929cbec170ee7af8c29f232bda20dc90f177cdee`; receipt SHA-256 `4847c342bfbe16b7d8148ea85fc12b80110b1cc5b3e7ea481ece2d6f2152d162`.
- Run source inventory `6ce879d26ed838fa3c3561eaad42b897c80705de9d138ededb8c3de5cf0f7a69` was unchanged before/after. Compared with the build inventory, only evidence docs/driver/helper/tests differed; no application input changed. HEAD plus dirty source identity remains as documented in `native-window-check.md`.
- WebView `153.0.4234.48`, production React with the build-only seek entry and temporary observer; real native picker/import, media preparation and persisted synthetic project reopen, not mock IPC.
- Duplicate-run preflight, OS PID/executable/creation identity, CDP listener ownership and expected Tauri page checks remain enforced by existing helpers. External Job Object watchdog 420 seconds, native lease 390 seconds; neither expired. Full identities, receipts and host metadata retained.

## Runtime results

| Check                                                         | Result                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Playback                                                      | 60.0168 seconds; still playing at endpoint, snapshot and pause completed                        |
| Video seeks                                                   | Start → middle (167) → end (333) → start; 4/4 ready/currentTime checks, decoded frames observed |
| Audio seeks                                                   | Start → middle (166) → end (332) → start; 4/4 ready/currentTime checks                          |
| Mounted media at seek endpoints                               | 1 on video endpoints, 2 on audio endpoints                                                      |
| Detached media resets                                         | 10/10 satisfied settled resource-state predicate; 10/10 emitted emptied; no event omissions     |
| Largest sampled single WebView private memory during playback | **256.10 MiB**                                                                                  |
| Peak summed native private memory during playback             | **565.24 MiB**                                                                                  |
| Sampling                                                      | 21 external five-second samples, 12 within measured playback                                    |

Native sum includes app/WebView/media tools, not the Node controller or launchers. These are sampled high-water values, not absolute maxima or a leak slope; do not compare directly against the historical 11.87-GiB/114-MiB **browser idle** measurements. CPU/working-set/handle/process counters remain in raw resource evidence.

The playback observer reached its 32-video lifetime cap again. Its 681 recorded frame callbacks have gaps p50 33.3 ms, p95 66.5 ms, p99 2,033.4 ms, max 2,050.2 ms, including fixture gaps. No complete dropped-frame total, smooth-playback acceptance, physical presentation/seek latency, audible output, A/V sync or React-commit metric is inferred. All eight seeks are functional readiness/currentTime checks, not presentation timing.

## Cleanup and checks

Native PID 21180 / creation `134343448339108460`: owned forced teardown reported `empty: true`; root was still running before teardown (259). Outer worker PID 13024 / creation `134343448325191185`: exited 0 and job reported `empty: true`. Final independent sample `02:28:53.5788574Z` reported root dead, zero processes. No unrelated processes were terminated. This is not an ordinary application-close or crash-recovery test.

- `b3c5f81e-8ba6-4f83-b2f4-e600faa60ff3`: two real-media controls passed.
- `6f1ba64d-9d25-49be-a966-cfcb5fa4aa1e`: all 17 harness/control tests passed, then lint correctly failed on a missing explicit Node `URL` import in the new test. Import fixed, no suppression.
- `fab160bc-3151-4da4-a3a9-1a8e6ad0798f`: final two affected tests passed, explicit ESLint passed for all three changed JS files, and native check passed. Other 15 harness tests were unchanged after their pass. No app checks claimed rerun, since no application code changed.

Raw artifact hashes:

- `resources.jsonl`: `96593a7f39cd763ba6547a38f04c7fc973665a534b885e5955df08e4a13ef673`
- `unloading.jsonl`: `120db287536f38c6e8171241050912ab09bed98a86ef57d621a256a86dba4e48`
- `seeks.jsonl`: `ef4c1976e5f1e2cc7096544e9ad9ed5f3b5d0a9831bb03d4ed38192a877ce376`
- `cleanup.json`: `05f08628bf7d99ab7a24769b525469ac2a1877eb9e1739f4d6981291adc213f6`

No new optimization, app rebuild, install/download, export work, commit, full matrix or 60-minute soak was undertaken in this follow-up. Broader P2 comparisons, long-session evidence and final acceptance remain outstanding. No native compositor investment is justified by the false-positive URL assertion.
