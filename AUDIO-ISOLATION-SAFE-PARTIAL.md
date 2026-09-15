# Audio isolation — SAFE PARTIAL

## Outcome

No real session mute state was changed. No audio/video capture, microphone use, upload, browser launch, process kill, endpoint change, or volume change was performed. No session was left muted **by this run**. One session was already muted at enumeration; its state was not changed. Restoration acknowledgement is **not applicable**, not “restored.” All six child invocations in the successful verification run exited; no background children were launched.

Live isolation is deliberately disabled. The existing three-control runner and analyzer are unchanged. **No calibration controls were recorded and the matrix must not continue on this result.**

## Implemented locally (ignored harness only)

- `evidence/2026-09-14-p2-speed/output-capture/SessionPreflight.cs`: dependency-free C# COM, MTA, read-only default `eRender/eConsole` enumeration matching `Loopback.cs:69`. Reads stable device/session/instance identities privately in memory, mute state, state, system-session result and process-result status. Releases COM objects in `finally`. Emits counts only. Live/restore modes fail closed before COM activation.
- `evidence/2026-09-14-p2-speed/output-capture/SessionRestorationCore.cs`: **mock-only**, unconnected transaction core retaining supplied handles. Exclusive new durable journal with `WriteThrough` and `Flush(true)` before mute; original Boolean restoration/readback; no success acknowledgement if any write/read/journal verification fails. This is not a production guardian or persistent recovery replayer.
- `evidence/2026-09-14-p2-speed/output-capture/session-preflight-tests.mjs`: runs classification/error tests and ten transaction tests before the first real read-only COM enumeration; writes results into a new directory.

Installed SDK declarations read first: `C:/Program Files (x86)/Windows Kits/10/Include/10.0.19041.0/um/audiopolicy.h` (`IAudioSessionControl2`, `IAudioSessionManager2`), `Audioclient.h` (`ISimpleAudioVolume`), and `mmdeviceapi.h` (device identity/activation). No process-loopback API was used.

## Actual verification and dry-run counts

Compiled both C# executables using installed `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`. Ran:

`node evidence/2026-09-14-p2-speed/output-capture/session-preflight-tests.mjs`

Successful evidence directory: `evidence/2026-09-14-p2-speed/output-capture/isolation-preflight-2026-09-15T04-04-54-192Z/`.

- `results.json:19`: ten mock transaction tests passed, including original true/false, journal failure, uncertain setter failure, foreign-session rejection, duplicate instance, readback failure and durable-file checks.
- `results.json:27`, `:37`, `:45`: unsupported isolation, restoration, and missing mode each rejected as expected.
- `results.json:55`: first real enumeration exited zero. Counts: **3 sessions; 1 system-sound, 2 other; 1 originally muted; 2 inactive, 1 active, 0 expired; 1 non-single-process result**. Default render endpoint identity was unchanged across enumeration. This does not guarantee capture-time endpoint stability or session-list completeness.
- `completion.json`: all spawned children exited, zero real mutations, zero captures.

An earlier mock-only test failed because `File.ReadAllText` did not share access with the open journal writer. Fixed the test reader to use `FileShare.ReadWrite`, rebuilt and reran. Failure evidence remains in `isolation-preflight-2026-09-15T04-04-32-097Z/`. No real COM enumeration or muting occurred in that failed run; this was not a calibration retry.

## Blocker and exact next step

The live safety envelope is not implemented/verified within this bounded attempt. Existing `bounded-calibration.mjs:47` obtains browser PID through window-title discovery, not the exact spawned browser process handle. Its `:31` cleanup uses PID-only `taskkill /T`; neither satisfies strict PID-reuse/ownership requirements. Do not enable real muting on these paths.

**Next step:** replace browser launch/discovery with a retained exact spawned root process identity (PID + creation time + validated executable, retained native process handle), validate its HWND and descendant ancestry/creation identities, and replace PID-only termination with owned-handle termination. Then implement and fault-test an independent MTA guardian with session notifications, capture-invalidating new/ambiguous foreign-session detection, endpoint-change invalidation, <=60-second monotonic lease, retained parent identity/handle, durable crash recovery replay by device + session + instance identity, exact-handle restoration and verifier, and a restoration ACK awaited only after all recorders stop. A non-single-process result must never be treated as single-process ownership.

Only after those tests pass: wire guardian readiness after exact browser PID is known and before any captures; execute the original three controls exactly once in a new directory with unchanged <=6-second capture and six-timestamp/one-frame/±100 ms gates. Continue the matrix only if all calibration gates pass. Current artifacts provide **no live lease, notification, identity-reuse, crash recovery, restoration ACK, or calibration verification**.
