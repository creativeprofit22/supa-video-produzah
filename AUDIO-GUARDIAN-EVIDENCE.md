# Live bounded guardian — short proof passed; capture remains disabled

One authorized no-audio native proof completed at 2026-09-15 04:31 UTC. Four sessions were observed, one already muted; three were temporarily muted and all three original booleans were read-back verified restored. Before/after muted count was 1/1. The owned browser remained alive at ACK, then its job drained and closed. No sessions remain muted by this proof; no recovery is pending. No playback, recording, microphone access, upload, volume, endpoint, app-code, dependency, OS, roadmap or git-history changes were made.

## Evidence and implementation

- `evidence/2026-09-14-p2-speed/guardian-proof-1789446694996.json:6`: ready + restoration ACK; before/after read-only enumerations, zero captures/playback/mic, and owned-job cleanup are in the same file.
- `evidence/2026-09-14-p2-speed/guardian-verification.json:1`: final compilation, seven new fault tests, existing ten transaction tests/read-only harness, syntax checks, source hashes, and private journal completeness (three snapshots, three verified restores, final ALL_RESTORED_VERIFIED).
- Reviewable source snapshots are outside the ignored harness in `evidence/2026-09-14-p2-speed/guardian-source/`. Executables and the private recovery journal remain in ignored `output-capture/`; `git check-ignore` confirmed that separation. Prior outputs were preserved.
- `guardian-source/LiveGuardian.cs`: MTA Core Audio manager on default eRender/eConsole, retained exact root handle/FILETIME/executable, retained ancestor handles and creation-time ordering, confirmed system-sounds classification, fail-closed nonsystem multiprocess classification unless already muted, retained session RCWs, synchronized notifications/stopping, <=60-second lease and parent stdin EOF/stop, endpoint-change abort, unregister-before-final-restore.
- `guardian-source/SessionRestorationCore.cs`: write-through journal plus Flush(true) before each mutation, original mute booleans, retained session handles, readback before restoration ACK. No master-volume setter is called.
- `guardian-source/audio-guardian.mjs`: ready / stop / exit / restored-ack interface, deliberately outside force-killed recorder collection. `bounded-calibration.mjs:10` exposes the interface but retains an unconditional CAPTURE-disabled guard. Parent must wire per-run restoration into calibration before capture; no three-control capture occurred.

## Verification actually run

Compiled LiveGuardian.exe and GuardianTests.exe using installed .NET Framework x64 csc, before any real mute, then ran GuardianTests.exe (7 pass). Executed `node .../guardian-proof.mjs` exactly once (pass). After two safety hardenings, recompiled both executables, reran seven tests, ran `node session-preflight-tests.mjs` (including ten existing transaction tests and read-only COM enumeration), and `node --check` on the handshake, proof and bounded runner. Installed SDK 10.0.19041.0 audiopolicy.h notification vtable declarations were read directly. Final source differs from the live-proven binary by broken-pipe-safe output and rejecting duplicate instance IDs attached to a different retained RCW/identifier; these changes compiled/tested but were NOT live-retested to avoid a second authorized mute cycle.

Fault tests cover journal-write failure before mutation, partial mutation, a newly added mock session plus rejection after restoration, duplicate/reused mock identity, lease boundary/stopping policy, failed restoration without false ACK, and native wrong-FILETIME rejection on the current test process. These are not full native notification-race or OS PID-reuse fault injection tests. Native parent-death/timeout and expired-session failures were not induced in the live proof.

## Final review correction

Reading every changed file caught an unhandled IOException on the background stdin reader: a broken parent pipe could otherwise terminate the guardian before restoration. `LiveGuardian.ReadStop` now catches that I/O failure and always requests stopping. A new assertion injects the broken-pipe IOException and verifies the stop request. Executed `cmd.exe /c build-guardian.cmd` after this correction: both C# executables compiled and all eight tests passed; reread both changed sections afterward. No additional live mute was performed.

The original `guardian-source/` snapshot and `guardian-verification.json` are preserved as the earlier seven-test revision. Final corrected C# snapshots and hashes are in `guardian-review-source/` and `guardian-review-verification.json`. The runtime files in ignored `output-capture/` are the final eight-test build. Earlier live proof does not constitute native verification of these later changes.

The implementation was checked against the installed Windows SDK declarations, but a comparable real-world implementation cross-check was not completed. No claim is made about Steroids availability or its catalog contents.

## Lifetime and recovery limits

The guardian is an independent managed process, not a browser-job member. Its owning caller must never force-kill it or place it in a kill-on-parent-exit container. Parent EOF initiates restore; failed restore keeps the process and exact handles alive, emits recovery-pending, and retries without successful exit. A lease ends permission to mute, not permission to abandon restoration. A hung Windows COM call cannot be made hard real-time by this managed loop.

There is no guarantee after guardian crash, forced termination, OS crash or power loss. Journal durability does not itself perform crash recovery. Automated cross-process replay is not implemented. If interrupted, keep the private journal: every SNAPSHOT lacking RESTORED_VERIFIED remains pending, even if its session expired. Do not guess by application names or restore to replacement sessions; recovery requires exact recorded endpoint/session/instance identity and GetMute confirmation, otherwise explicit unresolved status. The proof journal has no such unresolved snapshots. Do not publish its encoded session identifiers.
