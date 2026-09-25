# Corpus-led timing investigation — 18 September 2026

## Reproduction, not a production fix

The existing real browser case `30/1 100% preview live PCM pitch and aligned transient` failed unchanged in execution `e17781d4-a899-4d4c-a3c5-7e39242e3fca`: 1.38009 sequence frames against the unchanged one-frame limit. Its receipt reported 28,800 tone samples at 48 kHz, approximately 998.368 Hz, decoded visual frames, audio display time 4665.403 ms and visual display time 4619.4 ms. The difference was 46.003 ms. Web Audio reported baseLatency 10 ms and outputLatency 40 ms. These reported latencies were not subtracted, and do not independently establish causation or physical presentation timing.

Cartcut revision `486948af`, `apps/app/src/features/track/frameSource.ts:139–173`, documents no-op seek event and paused-video frame-callback hazards. That is reference evidence, not proof of an application defect here: this failed run contained video frames and sufficient tone samples, rather than hanging waiting for a paused callback. No speculative production seek or clock change was made.

## Explicitly authorized output isolation

- Read-only preflight `c0ee3934-21fc-4030-abb0-66e8664184ae` rejected Discord PID 11156 before recording (`capture-cw1P3h`).
- User authorized temporary Discord output muting with restoration. Execution `5e22afae-a60b-4598-89df-e654fc2dbad4` muted that verified session, rejected another Discord session, and verified restoration. No recording was started (`capture-8Qnx6D`).
- A complete read-only enumeration found two Discord sessions, Chrome, and GG Coder's WebView session. Their executable paths and process creation times were checked; GG Coder parent ancestry was verified. The user then explicitly authorized temporary output muting for these three applications with restoration.
- Execution `cfcd86eb-e7dc-41ba-a8da-aa6b62af8841` retained and muted three still-existing matching sessions. Chrome's previously enumerated session was no longer present. The bounded calibration proceeded through isolation into capture (`capture-QeI06c`), but failed during the late control with `Exited before READER_CAPTURE_STOPPED`. The late reader logged readiness and initial packets, but no normal capture-stop acknowledgement. This incomplete run is not a calibration pass, and production capture was not authorized from it.
- The existing process wrapper applies a 4000 ms total lifetime watchdog to the audio reader, while a 3-second capture starts only after reader readiness, guard readiness, visual readiness, and the explicit capture command. This is a lifecycle-budget contention candidate, not yet a proven timing fix; watchdogs and capture lengths were not changed.
- The wrapper's finally block verified restoration to `False` for all three original mute states. Independent read-only execution `92185f1d-df43-4c0e-81dc-31210fadff39` confirmed both Discord sessions and GG Coder were unmuted afterward; Chrome's session remained absent. No microphone, volume level, Handy setting or unrelated session was changed.

## Status

No application fix or passing live timing calibration is established by this investigation. Earlier failed and inconclusive evidence remains failed/inconclusive. No acceptance tolerance, test assertion, native durability rule, process budget or Roadmap status was changed. The next technical problem is obtaining a complete calibration within the existing bounded capture lifecycle, before attributing an observed output offset to production playback.
