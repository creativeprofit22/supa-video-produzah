# Safe implementation partial — no live mute or captures

Implemented and compiled the guardian health/protocol changes and integrated the lifecycle into the bounded runner behind its unconditional capture-disable guard. No guardian/browser/reader was launched by this work. No restoration transaction was opened; this work has no pending restoration. Prior proof restoration was not re-enumerated.

## Actual verification

`verification.json` contains command arguments, zero exit statuses, captured results and SHA-256 hashes. `build-guardian.cmd` compiled both native managed executables and ran nine mock tests successfully. `node --test guardian-protocol.test.mjs` passed six fake-child tests: normal STOP/ACK ordering, foreign-unmute invalidation before restoration, heartbeat loss, early lease expiry, pending restoration without force kill, and early exit without ACK. `node --check` passed on the wrapper and bounded runner. These are mock/protocol tests, not real COM race or native parent-death injection tests. `git check-ignore` confirmed this evidence is outside the ignored runtime folder.

## Implemented

- Native tracked-foreign GetMute readback before READY and every nominal 100 ms; HEALTH publication, unmute/readback-error invalidation, new foreign/unclassified-session rejection, lease/root-death invalidation and explicit restoring event. Never remutes a detected foreign unmute to conceal contamination. The SDK ISimpleAudioVolume declaration was read at installed 10.0.19041.0 `um/Audioclient.h:1526-1546`; existing interop was also read.
- Independent protocol lifecycle: bounded output/event retention; 1-second heartbeat deadline; emergency restore request on heartbeat loss; early restore/exit invalidates; verified ACK plus exit required; restoration-pending has no force-kill or abandonment timeout.
- Runner creates a separate 60-second guardian per condition, waits for readiness, keeps it outside reader kill ownership, waits for reader exit before normal restoration, and awaits guardian completion before browser close. Existing decoded controls and AudioStop-before-WGC-marker code remain unchanged. Error cleanup now awaits actual reader process settlement rather than a two-second race.

## Not ready for live: exact remaining work

The runner is deliberately disabled at `bounded-calibration.mjs:13`. The revised native lifecycle and runner have not been exercised together. Review fixed Add expiry invalidation and final observed-original readback failure reporting. The mutation-transaction ACK is now accompanied by a separate allForeignOriginalsVerified observation event; failures invalidate the run without writing over user changes. Native notification/race and complete runner fault-injection coverage are still absent. Originally-muted sessions are monitored but intentionally not written back over user changes.

IAudioSessionEvents was not registered; 100-ms polling cannot prove absence of a transient unmute/remute between reads and is not a hard real-time COM deadline. The fake-child cases inject protocol events, not real native callbacks. The final six-time V-interval / ±1-ms A / one-frame ±100-ms metric pipeline has not been reviewed or executed in this work. No offset, sound discard, control change, or retry-to-green was made. Complete these same-phase checks before removing the guard; no three-control result is claimed.

Runtime sources and compiled executables are in sibling ignored `output-capture/`. This directory preserves the initial nine-native/six-protocol-test revision. Final reviewed source snapshots and actual rerun results are in sibling `protocol-review/verification.json`: native compilation plus nine mock tests passed; ten protocol tests passed; wrapper and runner syntax checks passed. Added assertions cover null events, throwing reporters, failed reader shutdown awaiting restoration, and failed observed-original readback despite mutation ACK. Review also fixed falsely marking failed reader shutdown as stopped. No app/dependency/OS/roadmap changes or commits were made by this work.

Steroids is unavailable in the provided tools. Installed official Windows SDK declarations and existing local source were used; this work was not cross-checked against comparable real-world implementations.
