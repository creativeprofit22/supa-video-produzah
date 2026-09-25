# Parent review: capture-meSM0r — 18 September 2026

## Decision

**Qualified for this single bounded digital calibration set under the existing rules.** Execution success and interval qualification were independently checked. This is not production Preview/Final acceptance, proof of repeatability, physical speaker/display timing, or permission for another capture. Earlier failed/inconclusive sets remain unchanged.

CONTEXT.md was read. No new capture, audio/session change, production timing test, tolerance change, or latency subtraction occurred during this review. The analyzer's original candidate result was preserved rather than rewritten.

## Independent recomputation

Read-only Python execution `dc7b1c6a-08e5-4542-a599-93b2ea337aab` parsed the retained WAV data chunks, packet CSVs, full visual-frame CSVs, clock files, and play/stop receipts. It did not invoke or reuse the analyzer's calculated event selections. Rational arithmetic was used for timestamps; results were compared with the original JSON only after computation and agreed within 0.000001 ms.

The existing [qualification rules](../2026-09-14-p2-speed/output-capture/analyze-bounded.mjs) use absolute stereo PCM amplitude >0.005, sound grouping gaps >0.1 s, and +/-1 ms onset uncertainty. The visual bracket is the min/max of all six timestamps on the previous-dark/current-bright frames. The signed interval is `[audio onset - 1 ms - visual max, audio onset + 1 ms - visual min]`. No timestamp was discarded or offset subtracted.

| Control | Audio packet / sample (zero-based) | Visual rows | Recomputed audio-minus-visual interval | Rule / decision                                 |
| ------- | ---------------------------------- | ----------- | -------------------------------------- | ----------------------------------------------- |
| Sync    | 96 / 161                           | 60–61       | [-3.630133333, +30.363566667] ms       | Entire interval inside +/-33.333333333 ms: pass |
| Early   | 83 / 161                           | 58–59       | [-117.035133333, -87.314033333] ms     | Upper endpoint below -33.333333333 ms: pass     |
| Late    | 108 / 161                          | 65–66       | [+76.258166667, +105.653166667] ms     | Lower endpoint above +33.333333333 ms: pass     |

Each control has exactly one detected audio event and one dark-to-bright edge. Visual brackets in seconds were sync [4119.7767882, 4119.8087819], early [4127.0144673, 4127.0421884], and late [4123.6814875, 4123.7088825].

Raw evidence: [sync PCM](capture-meSM0r/sync/audio/loopback.wav), [sync packets](capture-meSM0r/sync/audio/packets.csv), [sync frames](capture-meSM0r/sync/visual/frames.csv); [early PCM](capture-meSM0r/early/audio/loopback.wav), [early packets](capture-meSM0r/early/audio/packets.csv), [early frames](capture-meSM0r/early/visual/frames.csv); [late PCM](capture-meSM0r/late/audio/loopback.wav), [late packets](capture-meSM0r/late/audio/packets.csv), [late frames](capture-meSM0r/late/visual/frames.csv).

The [source-control receipt](capture-meSM0r/controls.json) records 60 frames per asset, a flash at 0.8 s, and decoded audio differences of +0.020833, -99.979167 and +100.020833 ms for sync/early/late. This review read that generation receipt; it did not independently decode the compressed source assets again. Captured PCM and visual samples were independently recomputed as above.

## Safety and lifecycle review

- **Isolation:** the [initial guard](capture-meSM0r/ReadOnlyGuard.exe.log) and all three per-control guards report `ISOLATION_READY` then `ISOLATION_STOPPED`, with no rejection/invalidation. These are retained guard observations, not a new current-session survey. [Capture status](capture-meSM0r/capture-status.json) says isolated. Its `mutationCalls: 0` refers to the capture/guard, not the explicitly authorized external temporary mute.
- **Normal shutdown:** [sync reader](capture-meSM0r/sync/CompletionLoopback.exe.log), [early reader](capture-meSM0r/early/CompletionLoopback.exe.log), and [late reader](capture-meSM0r/late/CompletionLoopback.exe.log) all contain ordered packet readiness, `AUDIO_STOP_ACK`, and `READER_CAPTURE_STOPPED`. Their visual logs contain `WGC_DONE`. Stop-marker acknowledgements are true and hard-deadline-before-ack flags false. Audio stopped before visual close for every control.
- **Duration:** audio/visual seconds: sync **3.0067544 / 3.0913850**, early **3.0122849 / 3.0771528**, late **3.0082150 / 3.1219344**. These include stop overhead and satisfy the unchanged strict <=6-second rule. The configured native recording loop remains three seconds; this report does not call the measured durations exactly three seconds.
- **Packet/timestamp integrity:** no device-position gaps, no timestamp-error flags, no later discontinuities, and no prohibited timestamp ordering. Each sole discontinuity is packet zero, entirely before the pre-click lower bound, satisfying the existing first-packet exception.
- **Known timestamp uncertainty:** 160 sync, 176 early and 163 late visual rows have compositor timestamps later than CPU readback. This existing uncertainty is retained; all six boundary timestamps were included. Qualification follows the existing conditional-control method, not a newly proven clock interpretation.
- **Owned cleanup:** [lifecycle](capture-meSM0r/lifecycle.json) confirms zero remaining owned processes, `closed` with `rootExit: 0` and `empty: true`, and launcher exit 0 with empty stderr. The helper launch protocol awaited reader, visual, and guard exits; the top-level execution returned 0.
- **Audio restoration:** [saved restoration receipt](../../.git/gg-audio-restore-76c5024e-697c-41e8-ad6b-05d9a90340c5.log) records `originalMuted=False` and `restoredMuted=False verified=true` for the pinned GG Coder session (PID 17160, creation FILETIME 134341802053458033). Execution `e8e84f99-bc4a-4bca-811e-5c9feee0572b` also reports verified restoration. The reviewed one-shot wrapper checks that session volume is unchanged; it made no volume-setting calls. Discord was not changed. This is historical restoration evidence, not a fresh audio read. The `.git` receipt and ignored raw capture files are local evidence and must remain available to reproduce this review.

## Checklist scope and next case

Only **complete and qualify fresh calibration** is satisfied by this review. The [original results](capture-meSM0r/results.json) remain `candidate-pass-parent-review-required`; this document supplies the separate parent decision.

The next single unresolved matrix case is **30/1 fps, 50% speed, browser Preview live timing**, with the existing one-frame criterion and qualified controls for any future authorized capture. The historical 30/1, 100% Preview/Final pass does not establish this case. No production case was run or marked passed here.
