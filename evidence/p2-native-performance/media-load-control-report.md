# Idle media-loading control — 2026-09-20 UTC

## Result (RUNTIME)

Two sequential short runs used the same pinned browser fixture, native-produced media inputs, headless browser version, viewport, and 1,000-item project. Neither clicked Play or enabled the debugger/playback observer. The only intentional experimental difference was whether the fixture server delivered MP4 responses or held them pending.

| Observation                                 |                                    Normal delivery |            MP4 responses held pending |
| ------------------------------------------- | -------------------------------------------------: | ------------------------------------: |
| Mounted monitor media elements              |                       667 in every returned sample |                 667 in all 15 samples |
| Active visual media elements                |                                                  1 |                                     1 |
| Elements with loaded metadata               |                            243 initially, then 667 |                          0 throughout |
| Largest sampled single-Chrome private bytes |                         12,746,719,232 (11.87 GiB) |              202,027,008 (192.67 MiB) |
| Largest sampled total-Chrome private bytes  |                                     12,885,233,664 |                           329,371,648 |
| Largest sampled single-Chrome handle count  |                                              3,182 |                                   665 |
| Page responsiveness                         | 7 returned samples, then 2-second deadline failure |        All 15 returned, 2.54–13.50 ms |
| Browser control at final sample             |                                1.41 ms, successful |                   1.04 ms, successful |
| Measurement acceptance                      |                                               None | None: media intentionally unavailable |

These are five-second OS sampling high-water values, not continuously measured absolute peaks. Chrome subprocess roles were not captured; no particular process is asserted to be the renderer/GPU process.

**DEDUCED:** Delivering media and the resulting media/metadata processing is necessary for the reproduced multi-gigabyte growth in this idle comparison. Keeping the same 667 elements mounted without delivering media did not reproduce it. Mere DOM mounting, Play, React playback profiling, and snapshot serialization are not sufficient explanations for this observed failure. The experiment does not separate decoding, native buffering, app metadata-load seeks, or a browser-specific allocation problem; it does not prove that element count alone is the sole cause.

The app's current mapping of every prepared clip to a media element is documented in `responsiveness-resource-report.md`. This comparison strengthens the case for bounding media loading, but no app source was changed and no production fix is claimed.

## Preserved runs and cleanup

- Normal: `runs/browser-watchdog-0To9Wv/`; command `7a6c3327-edb6-4451-a040-70b50d9fe729`, exit 1 for failed responsiveness, 17.727 seconds including setup/sampler. Worker PID 2616, creation identity 134343384811710842.
- Held: `runs/browser-watchdog-JZelQn/`; command `819b7e1a-4f6a-4500-ab33-5a945890f057`, exit 0 for the diagnostic responsiveness check only, 22.238 seconds including setup/sampler. Worker PID 2852, creation identity 134343385054497315.
- Both workers completed browser/server teardown, then exited normally. Both launchers reported `empty: true`. Independent final sampler observations reported rootAlive=false and processCount=0. Neither 40-second external lease needed to expire.
- Raw operations, responsiveness results, input hashes, browser/media hashes, resource samples, ownership, sampler and cleanup receipts are retained. All earlier partial evidence is unchanged.

## Harness boundary and checks

`P2_MEDIA_LOAD_CONTROL=idle-normal|idle-held` is valid only with `P2_RESPONSIVENESS=1` and without debugger attachment. These controls use mounted-fixture readiness rather than playable-media readiness, explicitly labeled diagnostic-only. Ordinary session readiness, playback durations and acceptance assertions remain unchanged.

Holding applies only to validated, allowlisted loopback MP4 GET requests after existing path/host/range checks. It does not replace fixture files, edit app source, drop clips or unmount media. Held responses have a 30-second socket bound and a 2,048-request cap; normal teardown closes all fixture connections. Two actual media requests were held in this control.

Final targeted ESLint passed on all four changed harness files. **20 tests passed, zero skipped**, including refusal of unknown media-control settings and an idle-probe test proving it never requests playback. Real normal/held sessions above exercise both modes. Verification execution: `bc774123-9041-42df-9249-44d3ba0a30dd`, exit 0. Workspace type checks and full native suite were not rerun for these standalone JavaScript harness edits.

No full matrix, native soak, installs, app optimizations, release or Roadmap completion claim. App-level changes remain outside the diagnostic-only authorization.
