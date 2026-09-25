# Step 9 native playback preparation — NOT executed, NOT Done

## Delivered

- `native-playback-check.mjs`: opt-in actual-root editor driver using the existing owned launcher and native file picker, not a browser fixture. Fresh disposable project/profile; distinct test app identifier; separate Cargo target directory. Applies 150%, -6000 milli-decibels, fades 5/7 output frames, source [30,120), producing 60 frames at 30/1. Checks saved canonical single clip, Play/Pause/stability/resume/last frame, eligible real UI export/native completion, decoded final count/rate/pitch/flash-tone timing, and native Final playback at 1x. These assertions have **not run**.
- `native-timing-adapter.mjs`: pure argument/protocol and result adapter for the existing capture executables. Uses retained native root PID/creation/executable (descendants handled by existing OwnedIdentity), not Chromium as root. Requires exact tagged HWND and physical window ROI. Reuses unchanged one-frame/pitch classification. This is **not a runnable capture orchestrator** and its proof booleans must be backed by retained raw evidence, not treated as independent validation.
- `native-playback.test.mjs`: five offline tests for config isolation, root identity arguments, ROI rejection, missing safety/review evidence, unchanged shifted/pitch/tolerance sensitivity.

No existing helper, Rust, production component, dependency, capability, CSP or historical evidence was changed. No build, app launch, audio recording, screenshot, user-state access, mute operation or destructive removal was performed. Files/profile/project remain retained after future execution. Automated interaction is not a human keyboard check.

## Parent-only prerequisites and commands (not run here)

Wait until parallel production fixes stabilize. Review driver and record source/tool hashes first. From repository root in **PowerShell**, build an isolated debug native host of the production editor (not the fixture entry point):

```powershell
$completion = 'evidence/2026-09-16-p2-editor-controls-completion'
$env:TAURI_CONFIG = node "$completion/native-playback-check.mjs" --print-isolated-config
if ($LASTEXITCODE -ne 0) { throw 'Config failed' }
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target/step9-native
if ($LASTEXITCODE -ne 0) { throw 'Isolated native build failed' }
Remove-Item Env:TAURI_CONFIG
```

Overlay: identifier `com.supavideo.native-playback-step9-20260916`; test devUrl `http://localhost:4173` reuses the parent's owned production-root Vite server; OS window title `SUPA_LOOPBACK_PRIVATE_TEST Native editor step 9`; original 1280x800 / minimum 480x360 geometry. Security/grants untouched. Do not substitute the ordinary binary. The separate target is deliberately not the parent's current debug executable. Build configuration/runtime title still need actual verification; embedded string checks are a fail-closed prerequisite, not proof of runtime config.

Serve the **production root** frontend only after approval (managed background process, readiness wake, then HTTP check; do not start a second server if the parent's verified production-root server is already running):

```text
pnpm --filter @supa-video/desktop exec vite --host 127.0.0.1 --port 4173 --strictPort
```

Then, foreground under the existing 120-second owned lease:

```text
node evidence/2026-09-16-p2-editor-controls-completion/native-playback-check.mjs --run-native-playback-authorized
```

Port 9226 must be free. Bundled manifest-verified media tools and existing owned launcher must be available. `completion-media/single-flash-30-1.mp4` must already exist and decode as one flash/tone, 180 frames at 30/1, ~1 kHz. Driver never regenerates/overwrites it: copies bytes with exclusive creation into the existing picker-authorized `supa-controls-native-*` temp prefix and verifies SHA-256 against the original. Importing that disposable copy preserves both native file granting and provenance. No prior project is reopened. App cache is separated from ordinary user state by the isolated identifier; WebView profile and output project are fresh per invocation.

Output location is printed even on failure. Retain `owned.json`, `failure.json` if any, `decoded-final.json`, and `playback.json`. A pass here is **playback/decoded-export only**, not live native A/V timing acceptance. Stop on failure; do not enlarge lease, silently change selectors or weaken end-frame assertions to obtain green.

## Bounded remaining capture integration gap

Inspection establishes that `capture-calibration.mjs` owns/launches Chromium, overwrites its page, hardcodes Chromium executable and ROI (100,200), and injects HTTP silence. Calling its `targets` API cannot attach the actual editor; doing so would misrepresent browser-fixture proof as native proof. Do not edit it or the parent-owned helpers for this task.

Two concrete prerequisites remain before a native recording orchestrator can safely use the supplied adapter:

1. **Native ROI mapping/readiness:** retain real native HWND/root creation/executable, actual OS title, DPI and client-to-WGC-window physical-pixel mapping for the Program monitor's video interior. Verify fresh black/white samples at that exact ROI without inserting a replacement DOM fixture, capturing another window or guessing from browser chrome offsets. WgcRoi enforces title, owner, visibility, fixed capture size, 1..16-pixel ROI and stop bounds; never weaken it.
2. **Owned silent endpoint clock readiness under existing CSP/grants:** the qualified browser path injects an HTTP silent audio element, incompatible with assuming the production editor's media grants/CSP. Establish a narrowly scoped, granted decoded-zero owned stream without rerouting the measured ProgramMonitor graph or creating foreign unmuted sessions. Do not omit `AUDIO_PACKETS_READY` or its pre-play zero-packet evidence. If this cannot be established with existing authorized components, request the exact bounded access/design decision instead of building a replacement platform.

After those prerequisites: fresh sync/+100/-100 controls and parent review; attach only the native owned root; reader identity → read-only guard readiness (zero foreign unmuted sessions) → WGC readiness/fresh black → reader begin/packet readiness → common-QPC real UI Play → normal audio stop → WGC stop marker/exit → guard stop/exit → reader exit. Use three-second audio (existing reader limit), WGC under six seconds, bounded logs/watchdogs, invalidate immediately on isolation change. Measure preview and real native-export Final separately from pause/resume assertions (each timing run must start at frame 0 and retain exactly one flash/tone). No microphones, foreign mute, desktop-wide video, latency subtraction, unmatched-event removal or tolerance change.

Actual decoded end/frame/pitch/fade/gain evidence and live calibrated timing have different scopes. This single flash is interior to the fades, so the new driver confirms canonical fade/gain settings but does not independently quantify both fade envelopes; retain existing decoded envelope evidence and its source-stability limits. Native assistive technology and the bounded human keyboard check remain explicitly unverified.

## Verification actually run

`node --check native-playback-check.mjs`, `node --check native-timing-adapter.mjs`, and `node --test native-playback.test.mjs` (each path prefixed by this completion directory): exit 0, five tests passed. Execution `a05f8bff-19b1-485f-b881-1175fcd73d0d`. These checks import modules without launching binaries or decoding media. No live behavior or capture qualification is claimed. Step 9 remains incomplete.
