# P2 comparison matrix and native soak — collection complete, acceptance not passed

## Outcome (RUNTIME, 2026-09-20 UTC)

The authorized verification batch completed three matching workload matrices and one 60-minute active native soak. **P2 is not Done.** React update/commit targets are missed on the larger workloads, seek timeouts remain, and exposed decoder counts require visible-layer attribution before they can establish the approved dropped-frame target.

Only evidence code/tests changed. No application optimization, install/download, export-engine change, commit or release was made. Existing dirty application work and historical evidence were preserved. Synthetic reference exports were produced by the existing native export helper solely to exercise Final mode.

### Collected

- Native profiling build: all six workload/cadence rows, eight applicable mode groups, three measured 60-second samples per group (24 total), 100 seeded seeks per group (800).
- Native production React build: the same 24 observed samples/800 seeks, plus **24 observer-free 60-second playback controls**.
- Browser profiling control: same 24 observed samples/800 seeks, same native fixture projections and real prepared assets.
- Native soak: **60 active minutes**, 60 playback/pause/seek cycles and six native project-close/reopen cycles, with 60 seconds each of initial idle, warmup and final idle. 776 external five-second resource samples, 720 during the active hour.

“Passed” in the legacy workload ledger and new controller indicates the collection workflow completed, not that every sample/seek or P2 threshold passed. In particular, the ledger allows recorded seek failures. The first completed controller receipt lacks an index pointer because child stdout is not forwarded by the owned launcher; the actual on-disk index was subsequently resolved and verified. Later controllers use an explicit fresh receipt pointer.

## Sources, builds and receipts

Application-source inventory comparison passed across both native builds and through soak teardown. HEAD plus dirty inputs, not HEAD alone, identifies this work. Only evidence code/docs differ across the recorded source snapshots.

| Role                                         | Receipt / index under `runs/`                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Fresh native profiling build                 | `release-MypVlC/receipt.json`                                                                                   |
| Fixed-source native production build         | `release-x7bGX5/receipt.json` (same previously verified fixed-source build; not the historical pre-fix release) |
| Native profiling workload index              | `workloads-native-profile-OgQYqs/index.json`                                                                    |
| Native production workload index             | `workloads-native-uninstrumented-6FTCuT/index.json`                                                             |
| Browser profiling workload index             | `workloads-browser-profile-nB2a2Q/index.json`                                                                   |
| Native profiling external resources/cleanup  | `bounded-comparison-KL86l2/`                                                                                    |
| Native production external resources/cleanup | `bounded-comparison-dP67sQ/`                                                                                    |
| Browser external resources/cleanup           | `bounded-comparison-uMlzLY/`                                                                                    |
| Soak operations/resources/source/cleanup     | `native-window-Ka5qIA/`                                                                                         |
| Fresh browser build                          | `browser-comparison-20260920-a/`                                                                                |

- Profile receipt SHA-256: `e884ab4bc94c00e7a4f3d5300575609af442c903dabc0aed87fa3a4c3cb6a93d`; executable `58c42347e3df3d5e02fb8709b7e1639e06e62ffb6a21c3392deeabe9d97d9bfb`; build source digest `2e65bf566242fd4e171742529311773d296fda7b20fb22a1ebfc77a5c98534bc`.
- Production executable SHA-256: `00a63c0fbe42e3bf8caeda7e929cbec170ee7af8c29f232bda20dc90f177cdee`.
- Production index SHA-256: `a389a5d8e598d8abade6735cf330dfb406da2a437c48eee28aac67a9e65fdf35`.
- Browser index SHA-256: `83f57362e19ddd3f02573ba6d34bb8801ed43d9366b832244778f9a39010417c`.
- Soak result SHA-256: `7f232eae7f2b6c15228fdc985cff6a17c2e41c4c5c70aaa0f63fbd4a05666be2`; source inventory digest `cc9059949c49e89b4106fbd52d178741ce3df17f19bf7031ea915214ff66bfb7` matched before/after.
- The fresh native build used existing offline/locked isolated assembly and resource verification. Browser build had the existing >500-kB bundle warning, not a build error. No dependency/toolchain was installed.

## Observer correction (CODE + RUNTIME)

The old observer bounded **lifetime** elements at 32, so playback lost coverage as clips changed. It now bounds **live** element references at 32, assigns monotonic IDs, removes listeners/frame callbacks from detached nodes and preserves their counter segments without retaining the DOM nodes. Event-buffer and lease caps remain enforced. A real-browser regression exercises 40 sequential elements and verifies 39 retired records, one live reference, no tracking-cap hit and teardown.

All **72 observed matrix samples** had no lifetime/live tracking-cap hit and no omitted events. This removes the specific previous coverage loss. It does **not** turn summed per-element counters into physical visible-frame measurements: the monitor has preloaded/hidden media and multiple active layers, decoder resets and intentional gaps. Raw samples and segments remain available to audit those distinctions.

## Comparison results

Three samples per row, following five-second warmup. Reference asset mode pairs and both 30/1 and 30000/1001 cadences completed.

### Native profiling React targets

| Workload            | Cadence    | Workspace commit-duration p95 across three samples | Timeline p95 across three samples |
| ------------------- | ---------- | -------------------------------------------------- | --------------------------------- |
| Reference Preview   | 30/1       | 1.7–4.7 ms                                         | 0.5–0.9 ms                        |
| Reference Final     | 30/1       | 3.3–6.3 ms                                         | 0.6–1.1 ms                        |
| Reference Preview   | 30000/1001 | 2.8–4.9 ms                                         | 0.7–1.1 ms                        |
| Reference Final     | 30000/1001 | 1.8–5.3 ms                                         | 0.4–1.0 ms                        |
| 1,000 items Preview | 30/1       | **9.5–13.7 ms**                                    | **5.4–7.7 ms**                    |
| 1,000 items Preview | 30000/1001 | **10.7–13.2 ms**                                   | **6.2–8.9 ms**                    |
| Two layers Preview  | 30/1       | 2.5–4.6 ms                                         | 1.2–2.0 ms                        |
| Two layers Preview  | 30000/1001 | 1.9–6.2 ms                                         | 0.7–2.3 ms                        |

The approved ≤8-ms workspace and ≤2-ms timeline targets are not met by the 1,000-item rows. Native workspace commits run roughly 53–60/sec and timeline commits roughly 29–30/sec in this matrix, above the ≤10/sec ordinary-playback cadence target. Browser 1,000-item workspace p95 was 4.9–7.3 ms and timeline p95 3.1–4.6 ms: browser-only evidence would conceal part of the native cost.

### Real seek-to-frame callback measurements

| Group, at each cadence and target | Outcomes per 100 seeded seeks                                    |
| --------------------------------- | ---------------------------------------------------------------- |
| Reference Preview                 | 100 successful                                                   |
| Reference Final                   | 100 successful                                                   |
| 1,000 items Preview               | 20 successful, **4 timeouts**, 76 intentional gap/no-video cases |
| Two layers Preview                | 87 successful, **13 timeouts**                                   |

The outcome pattern repeats across all three targets at both cadences. Gaps are unavailable presentation samples, not failed video presentation and not successes. Actual timeout cases remain failures/unresolved; no timeout was extended or excluded to improve results. These aggregate runs do not yet determine whether each timeout is an application seek failure or observer attribution/no-op behavior. The prior eight functional readiness seeks remain separate evidence.

Reference seek p95 (Preview / Final): native profile **138/289 ms** at 30 fps, **141/283 ms** at fractional cadence; native production **142/276 ms**, **141/289 ms**; browser profile **278/428 ms**, **272/444 ms**. Final therefore misses the approved 250-ms p95 target. Larger-workload successful-only percentiles are retained in raw indexes but must not conceal timed-out requests. These are real seek-entry→rVFC intervals, not physical display latency.

### Frame/decoder observations and limits

Reference native production observed counter totals over three samples: 30-fps Preview 0/5,402 dropped, Final 0/5,401; fractional Preview 2/5,397, Final 0/5,395. Native reference rVFC interval p95 was about 33.4–33.5 ms. These are exposed browser counters and frame callbacks, not an A/V sync or display capture.

The large/two-layer rows expose materially different totals: native production 1,000-item counters report 1,141/5,569 and 1,160/5,564 dropped; two-layer counts report 7,412/20,421 and 7,584/13,131. **Do not report these ratios as user-visible dropped-frame rates.** They combine media elements/layers, including hidden/preloaded resources. Layer/counter attribution and reset auditing are still needed before applying the visual 1% target. Raising the old cap alone would not have solved this interpretation issue. Native production 1,000-item frame-gap p95 ranged 50.0–66.6 ms, including intentional fixture gaps.

### Observer-free controls

External native process CPU-time deltas were computed only for matching PID+creation identities within each sampled playback window, divided by elapsed wall time. Values are core-equivalents, **not whole-machine utilization**. Values below are medians of three sample estimates; memory is the median of each window's median summed private memory.

| Native production group      | Observer on/off CPU cores | Observer on/off private MiB |
| ---------------------------- | ------------------------- | --------------------------- |
| Reference Preview 30         | 0.405 / 0.374             | 403.9 / 417.2               |
| Reference Final 30           | 0.436 / 0.491             | 513.5 / 597.9               |
| Reference Preview fractional | 0.541 / 0.388             | 375.9 / 400.8               |
| Reference Final fractional   | 0.423 / 0.605             | 525.4 / 590.0               |
| 1,000 items 30               | 0.503 / 0.632             | 538.1 / 520.3               |
| 1,000 items fractional       | 0.748 / 0.559             | 528.1 / 540.8               |
| Two layers 30                | 0.621 / 0.497             | 494.3 / 481.5               |
| Two layers fractional        | 0.436 / 0.435             | 462.2 / 520.0               |

Control order is not randomized: observer-free samples follow observed playback and seeks in the same native session. Warm caches, thermal/scheduling variation and accumulated session state confound causal overhead. Differences are not consistently positive; **no stable overhead bound or negligible-overhead claim is justified**. These controls establish actual runtime sampling without the observer, not that the observer costs zero.

## 60-minute native soak

Production React; no browser observer installed during the active hour. Each of 60 cycles seeks through six distributed video positions, plays for 45 seconds, checks transport/media state, then pauses for the remainder of its minute. Every tenth cycle closes the synthetic project via the real native command, reloads only the isolated frontend to discard its old project state, and reopens through the OS picker. This is **six project lifecycle cycles in the same native app, not six OS app restarts**. Initial fixture preparation, the short playback/seek/unload verifier, idle and warmup precede the active hour.

- Active elapsed: **3,600,001 ms**, all 60 endpoint checks responsive and playing, all six reopens confirmed.
- Initial/final idle are 60 seconds each; final idle follows the sixth close/reopen. Playhead/media state differs from the initial post-seek idle, so they are not identical-state heap snapshots.
- Native resource sums include app, WebView and pinned media tools; exclude Node, diagnostic launchers and console hosts. Working-set sums can double-count shared pages.

| Resource       | Initial idle median | First 5 active minutes median | Last 5 active minutes median | Final idle median |
| -------------- | ------------------: | ----------------------------: | ---------------------------: | ----------------: |
| Private memory |           400.2 MiB |                     503.4 MiB |                    548.9 MiB |         371.1 MiB |
| Working set    |           595.9 MiB |                     682.1 MiB |                    726.2 MiB |         577.3 MiB |
| Handles        |               3,963 |                         3,973 |                        4,008 |             4,024 |

Peak sampled active private memory: **630.0 MiB**. Least-squares active private-memory slope: **+0.485 MiB/minute** across all 720 samples, including six project reopen resets. Active memory and handles grew modestly; memory fell after the final reopen/idle. This is not an OOM recurrence, but **not proof of flat memory, no handle retention, or leak-free uninterrupted use**. Reopen cycles can release resources that uninterrupted editing would retain. No export pressure was added during the active soak.

## Ownership, deadlines and cleanup

All runs refuse duplicate owned workloads, use the hash-verified Windows Job Object launcher, and verify native executable/PID/creation identity and loopback CDP listener ownership before attachment. Native page identity is checked after attachment. Every workload's native/browser session cleanup receipt remains in its index. Application exit after forced owned cleanup is not an ordinary-close/persistence test.

- External comparison lease: 75 minutes; each native workload session: 45 minutes. Soak external lease: 75 minutes; native session: 70 minutes. External process sampling continues independently of page responsiveness. Existing bounded cleanup drain/fallback retained; none expired.
- Native profile outer worker PID 22312: exit 0, Job Object empty; final sample zero processes (`03:30:56.1455270Z`, 442 samples).
- Native production outer worker PID 18748: exit 0, job empty; final sample zero (`04:34:11.0409966Z`, 739 samples).
- Browser outer worker PID 4568: exit 0, job empty; final sample zero (`05:05:37.7632199Z`, 377 samples).
- Soak native app PID 13380 / creation `134343544872537099`: owned forced cleanup empty; outer worker PID 11552 / creation `134343544860522477`: exit 0, job empty. Independent final sample zero (`06:12:41.9737528Z`).
- No unrelated processes were terminated. All partial/error artifacts were retained.

## Verification and encountered harness defects

- The first comparison controller attempt (`4d516c39-ce17-4f3d-84a0-1a64c876d18b`) referenced nonexistent `owned.exited` instead of `owned.exit`. It failed before useful collection; `finally` cleanup confirmed an empty job in `bounded-comparison-n3ahOQ/cleanup.json`. Corrected to the existing helper contract; subsequent native matrix ran to completion.
- Profile build and observer checks passed in `ed6f71a6-329a-4699-aa6f-f6b1bdf99942`; native profile matrix and final controller lint passed in `703860a1-ceaf-4bc7-a52b-e3afd62ccb46`.
- Production/browser matrices and browser build passed in `d97466bc-cf44-4d7e-9641-d4f7c5ff965a`.
- Final **18 harness/real-media/observer tests**, explicit lint on all six changed evidence JS files and the native soak passed in `b613e9bb-bf31-4472-b723-589835cdad46`.
- Desktop type checks, **71 monitor/window/timeline tests**, targeted application ESLint and evidence diff-whitespace check passed in `2d86a350-31e7-43b9-b784-3b8e6e277309`. No application edits were made afterward.
- A read-only ad-hoc summary initially used the wrong cleanup-object nesting and failed (`df7bf7a6-c8cc-4e61-9e8c-975b163a2f43`); corrected analysis `34ccd88e-35f0-40bd-bf31-16869e6f86df` produced the soak numbers above. It did not change/re-run the workload.

## Remaining decisions and work

1. Trace and reduce the measured native large-timeline React commit cadence/cost; do not substitute a native compositor without causal evidence.
2. Resolve the reproducible seek timeout observations, separating application failure from wrong/no-op media attribution; Final seek latency currently misses its target regardless.
3. Attribute decoder counters to visible layers and audit resets before claiming the dropped-frame target. No physical presentation/A/V sync or GPU-utilization proof was collected.
4. Do not call the resource criterion leak-free: positive active memory/handle growth and the effect of project reloads remain explicit. Ordered overhead controls do not establish a stable instrumentation overhead bound.
5. P2's broader timeline/accessibility/guard/decision-record criteria must still be assessed against current evidence. This report does not replace or mark the whole approved plan complete.
