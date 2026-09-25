# P2 — Current native and performance evidence

Status: steps 1–2 complete; step 3 partially implemented and verified; steps 4–7 not run. No native-release/performance acceptance claimed.

## Step 1 — 2026-09-19 UTC inventory

RUNTIME: HEAD `809e1102963370c6461f8ad50f7ce28f7f0209bd` plus pre-existing dirty work (75 tracked changed files). No existing file modified. `CONTEXT.md` and current Roadmap/binding inspected; binding consistent with the active session.

Initial identity receipt: `runs/snapshot-hNI12g/identity.json`, SHA-256 `5392f177f65f5c82652de7cd3918414ec67dfcff826873f5f50f83ddd091ffe3`. It inventories 460 relevant tracked/untracked input files and all seven source overlay resources. Tracked diff SHA-256 `9028950d9354ecd348bbf9901550823e02a4e79f0d4a239db375a2398863db37`; source inventory SHA-256 `d3befbc70ceea58b9f3a489c648e0eca5c646b2d919271bc339c301236f550e4`. This is an initial inventory, not the final verification snapshot. Later evidence files are not included. Raw run directories are ignored. `snapshot.mjs` creates unique receipts without overwriting prior captures.

Source FFmpeg: SHA-256 `1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e`, 101897728 bytes. Source ffprobe: `b49ccc7c6547b141ad5a2f6ec69cc04323d7133d7704d70b331b904c63eecb07`, 101692928 bytes. Source manifest: `a827f2f093b7fc1cd91fa6b04573ec939982fa0e5c37cc7ead1594cbab7848d9`. Presence/hashes do not establish current capability verification or release assembly.

Installed tools observed: Node 22.20.0, pnpm 10.34.5, Cargo 1.97.1, rustc 1.97.1, Windows PowerShell 5.1.19041.6456. Host: Windows 10 Pro 19045; Intel i7-8700, six cores/twelve logical processors; NVIDIA GTX 1080, driver 32.0.15.6117; 2560×1440 at 60 Hz; Balanced power scheme. WebView2 installation directory 153.0.4234.46 (not yet a launched-runtime version). Foreground workload, display scaling and power stability during measurement remain unmeasured.

CODE: existing native-launch pattern uses a debug binary, isolated identifier, temporary WebView profile, loopback port and 120-second owned-process lease. It is not suitable unchanged for release/soak. Production CSP/assets remain restrictive. The Windows overlay maps seven resources. No release build, profile, debug port or application process was created in this inventory.

Overlapping existing diffs inspected: timeline multiselect formatting; monitor final endpoint and layer mute behavior; manifest/native validator addition of `rubberband`. Preserve them. The bootstrap validator still has the previous exact filter set. This is a concrete prerequisite mismatch, not evidence of decoder slowness.

### Prerequisite failure — dependent native batch stopped

`pnpm --filter @supa-video/desktop media:verify:windows` exited 1 (`99cc15ea-a609-441a-8de5-ed20ecc78570`). Read-only diagnosis (`9a7b30cf-5e09-4073-815b-72c5c13c0937`, exit 1) exposed: `target.requiredCapabilities.filters must equal the pinned set`. No dependent test/build/playback followed this failure. No system-tool substitution, installation or download performed. The user subsequently authorized the narrow repair: add `rubberband` to the bootstrap exact required set and add rejection coverage for its omission. Execution `5330bc32-c303-4bbe-a67c-f2f52fa8a570` passed 52 assertions and source-tool verification. No validator was weakened; historical failure remains recorded. The repaired prerequisite no longer blocks authorized work.

### Execution receipts

Logs: `C:/Users/SPARTAN PC/.gg/foreground/<ID>.log`.

- `afb3323c-5a8a-4190-baa1-600bb1cc5820`: status/HEAD/diff summary, exit 0.
- `003bbda1-ce2c-46f7-8197-986179c1b9f5`, `b96c4192-6644-4813-aad2-3b44687ee2c8`: overlapping diff and installed tool inspection, exit 0. Initial host display output was incomplete and is not relied on.
- `fd32cff4-2ee7-4108-84a1-f99de92458a7`: snapshot receipt, exit 0; shell also ran host inventory whose encoding was unreadable.
- `836199a3-974f-4a67-ada3-97a529c73b79`: explicit UTF-8 host inventory, exit 0.

See [test accounting](ignored-tests.md), [platform matrix](platform-matrix.md), [harness status](harness-status.md) and [results](results.md). Historical ledgers and ROADMAP.md remain unchanged. Existing application changes remain untouched; only the two explicitly approved bootstrap script/test files changed outside this new evidence directory.
