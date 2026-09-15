# Native event monitoring implemented; single calibration attempt failed closed

## Outcome

No matrix advance. Invoked the unchanged sync/+100/-100 ms control runner ONCE in new private directory `../output-capture/bounded-2026-09-15T05-00-58-416Z`. All three generated/decoded source controls passed. Static WGC ROI preflight then rejected `Private HWND identity/visibility changed; refusing capture` (exit 1, before WGC_READY). No retry, playback, loopback capture, live guardian startup, or real mute occurred. Consequently captured onset counts and six-time-hull intervals are unavailable, not passing or zero-valued measurements. Calibration controls captured: 0/3; guardian registrations/events/changes/restoration ACKs this attempt: 0/0/0/0. Existing six-time hull, audio +/-1 ms, thresholds, and strict <=6 s gates were not changed. Browser job and guardian lease settings are <=60 s.

Source decode: 60 frames, three bright frames, one flash and one sound per control. Actual decoded audio-minus-video offsets: sync +0.020833333333247772 ms; late +100.02083333333334 ms; early -99.97916666666673 ms (`controls.json:1`). These are source offsets, NOT captured calibration intervals.

## Cleanup and settings

`cleanup.json:12` records the failed ROI reader; `cleanup.json:72` onward records exact owned-process exit confirmations. Browser job reports empty/rootExit 0 at `cleanup.json:122`; launcher exits 0 at `cleanup.json:127`. No guardian was launched, no settings were changed, no restoration is pending, and no guardian was force-killed. Afterward, native read-only GetMute enumeration observed two sessions, one originally muted, matching the pre-attempt counts (`post-run-getmute-counts.json:1`). Zero settings changed by this invocation therefore require restoration; this is not a new native mute/restore proof. Prior private recovery journals are retained untouched; this attempt created no live recovery journal because it failed before guardian startup.

## Implemented

- Installed SDK audiopolicy.h:143-184 read directly. Exact IAudioSessionEvents vtable, BOOL marshalling and GUID; HRESULT-checked per-foreign-session registration followed by readback; callback strongly retained on exact session; unregister checked/retried before restoration (`SessionEvents.cs:5`, `LiveGuardian.cs:77`, `LiveGuardian.cs:127`).
- Own SetMute carries a unique context for starting/restoring writes. External false->true remains sticky invalid even when polling sees true. Last observed external mute choice is preserved rather than overwritten during restore; changed-original observations invalidate acceptance. Polling/HEALTH remain fallback. No guarantee covering every OS race, callback delay, COM hang, crash or power loss is claimed.
- Shared lifecycle integrates normal reader ACK -> restoration ACK -> eventual browser-job close. Abnormal failure requests restoration immediately while stopping reader processes; guardian never joins force-killed reader collection. Capture guard removed only after integrated fake-child checks passed (`capture-lifecycle.mjs:1`, `capture-lifecycle.test.mjs:4`, `bounded-calibration.mjs:74`).

## Verification actually executed

- `build-guardian.cmd` through Node execFileSync(cmd.exe): both guardian executables compiled; final **14 compiled mock/native-identity tests pass**, zero real mutation calls. Includes transient false->true, own context, registration HRESULT failure, readback exception/mismatch, preserved user change.
- Recompiled SessionRestorationCoreTests.exe from final source with installed x64 csc; **10 transaction tests pass**.
- `node --test guardian-protocol.test.mjs capture-lifecycle.test.mjs safety-runner.test.mjs`: **10 protocol + 3 integrated lifecycle + 5 reader-supervisor scenarios pass** (14 Node test entries). Fixed stale supervisor test extraction/kill assertions to match existing owned-child implementation; did not weaken assertions.
- `owned-browser.test.mjs`: **7 ownership scenarios pass**, including native no-audio owned browser close.
- `session-preflight-tests.mjs`: read-only classification/error harness and GetMute enumeration pass before/after attempt. `node --check bounded-calibration.mjs` passes. Single runner invocation fails at ROI preflight as above. Analyzer not executed because captures do not exist.

Reviewable source snapshots and SHA-256 manifest are retained here outside ignored output-capture. No app/dependency/OS/roadmap changes, commits, microphone access or uploads. Native happy-path proof from earlier work remains the only observed real mute/restore proof; this revision's native callbacks were compiled/mock-tested, not live-fault-injected. Parent may continue matrix only after actual calibration AND safety pass; neither is claimed from this failed capture attempt.
