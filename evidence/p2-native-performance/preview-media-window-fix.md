# Bounded preview media loading — implemented and browser-verified

## Authorization and scope

The user explicitly authorized a focused app-level fix after the idle media-loading control demonstrated the problem, lifting the earlier diagnostic-only/no-app-optimization restriction for this work. Existing dirty work, project contents, audio/seek/transition behavior and export-engine code were to be preserved. No installs, commits, full matrix, native soak or unverified Roadmap completion were authorized or performed.

## What changed (CODE)

`apps/desktop/src/video/preview-media-window.ts` selects all active layers, the current clock layer (including gaps), and at most one nearest previous/next clip per track within approximately one second of sequence time. Overlapping active video/audio/hidden layers are retained; selection preserves their original order. The bound scales with simultaneously needed layers and track count, not total timeline length. No arbitrary cap drops active content.

`ProgramMonitor.tsx` renders only those media elements. Membership changes synchronize audio graph, gain/mute and pitch/speed setup. Disconnected media is paused, detached from its source and reset to release resources. Connected media is preserved through ordinary rerenders and React StrictMode effect replay. Released media's late play-promise failures no longer replace the new preview with a stale fatal error.

The source projection, timeline data, captions, frame mapping, clock selection, transport controls, Final mode and export engine were not replaced. Existing user changes in the monitor/tests were retained. New regression coverage tests window bounds, overlap/audio/hidden layers, sequence cadences, retiming duration, gaps, distant seeks, actual resource-release calls, stable nodes, StrictMode, and the stale-play rejection race.

## Same-fixture before/after (RUNTIME)

Windows, same installed HeadlessChrome 151.0.7922.34, 1,000-item / 30-fps fixture, native-produced pinned MP4 media, normal media responses, no playback during the resource comparison. No media was blocked in either row.

| Idle diagnostic                              |     Before (`browser-watchdog-0To9Wv`) | Final fix (`browser-watchdog-ZdYupu`) |
| -------------------------------------------- | -------------------------------------: | ------------------------------------: |
| Mounted monitor media elements at frame zero |                                    667 |                                     1 |
| Largest sampled single-Chrome private memory |       12,746,719,232 bytes / 11.87 GiB |        119,963,648 bytes / 114.41 MiB |
| Largest sampled total-Chrome private memory  |                   12,885,233,664 bytes |                     222,642,176 bytes |
| Responsiveness                               | Page timed out after 7 returned checks |               All 15 checks responded |
| Owned cleanup                                |                              Confirmed |                             Confirmed |

This is approximately **99.1% less sampled single-process private memory in this idle fixture**, not a universal memory bound or leak-free claim. Values are high-water observations from five-second sampling; Chrome subprocess roles were not recorded. Caption/clip records were not removed: the same 1,000-item canonical project was loaded.

## Real playback and distant seeks (RUNTIME)

Final build: `runs/browser-window-fix-final-oKLW4D/`, freshly built and isolated; earlier builds/receipts remain unchanged. Input/source hashes and served frontend/media hashes are retained in each run's `inputs.json` and `fixture.json`.

`runs/browser-watchdog-1YmOCZ/` completed the original five-second warmup, a **60.0121-second playback sample**, end-of-sample snapshot and normal pause. It remained in playing state at the sample endpoint and recorded real decoded-frame callbacks across changing clips. Unlike the pre-fix attempt, the collector returned and teardown completed without watchdog expiry.

Eight additional real seeks covered the beginning, middle, end and return-to-start on both video and audio tracks. All reached the intended clip with readyState 4 and media time 0.166668 seconds versus expected 0.1666667; video targets had decoded frames. Only 1–2 monitor media elements were mounted at these inspected endpoints. These checks exercise the existing app seek entry and actual media, not test-only media-time assignment. They are readiness/currentTime checks, **not presented-frame timing or audible-output proof**.

Both final runs completed with owned job `empty: true`. The independent idle resource sampler also observed rootAlive=false/processCount=0. No unrelated processes were terminated.

## Tests and verification

- First mounted-count regression failed against the old behavior: 1,000 elements instead of 1 (`vitest run src/video/ProgramMonitor.test.tsx -t 'loads only nearby media'`).
- The distant-seek/pending-play regression then reproduced a stale fatal error after media release. Execution `fc9a2cb7-bfe9-46cf-9d67-903c54732c70`. The final guard fixes that reproduced race without suppressing errors on current connected media.
- Final **87 tests passed, zero skipped** across monitor, media-window, audio graph, workspace and workflow integration suites. Includes mock-IPC export/cancellation/reopen coverage; it is not a new native export run.
- All workspace type checks and targeted app/harness ESLint passed after the final source edits. Execution `1d5778e7-ac74-422a-a0cd-1be3ba1da0d1`, exit 0.
- Existing integration tests emitted jsdom's unimplemented pause/load notices; these were not suppressed. Actual browser runs separately exercised playback and cleanup.
- Final isolated frontend build `e1409046-7a3d-4c85-a292-f262c7ab3b20`, exit 0. Existing >500-kB chunk warning remains; no unrelated bundling work was done.
- Final resource + playback/seek verification `b58a7e3c-a38b-4624-98ad-c69885be6fc3`, exit 0; approximately 92 seconds total for both bounded runs.

### Key evidence hashes

- Idle `report.json`: `02249d7b597865e21bf2fd93df6711bb6fa3c6160bd47e1629e22525095f894d`
- Idle `cleanup.json`: `db6b32ad4ed7a5a49d35dcde7ad9e40ed729ebce64b90e9d2cff22f65e8154b7`
- Playback `report.json`: `0db53916465a10195a8586683c6b9327cdebc953f1d1172d1e7379c3d89dc539`
- Playback `measurement.json`: `2ad528580f5b600a8218df9e9a210ae1592b744e69a9ea6de50d87a1d42a6024`
- Eight-seek `window-verification.json`: `e0370ff102fb13a3a9e8956bf08bc1443749bb4f7a7c8a0b5cd389cecd83cf3c`
- Playback `cleanup.json`: `a754440fab6b03d04e0affa05763f84801c601628b13c51349b50fb1345955ab`

## Limits and remaining phase work

This fix is implemented and checked in the browser/mock-IPC fixture using real media. It has **not** been rebuilt/retested as a new native Tauri release, installed, committed or released. Existing native receipts describe their older source snapshots, not this change.

The observer hit its existing 32-video lifetime tracking cap during clip churn. Raw partial decoder segments and frame gaps are retained; no whole-session zero-drop or smooth-playback claim is made. The measured fixture contains intentional visual gaps; their contribution is not separated here. No long-session memory slope, full workload matrix, 100-seek latency distribution, new native export, multi-layer native acceptance or audible-output proof was obtained. The larger P2 phase remains incomplete; no Roadmap status was marked Done.
