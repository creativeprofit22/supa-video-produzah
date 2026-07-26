# Supa Video Producer

Supa Video Producer is a standalone, offline-first Tauri desktop application under active Phase 1 development. The Phase 1 target is to trim one local video clip and export a verified H.264/AAC MP4.

## Phase 1 prerequisites

- Windows with Microsoft C++ Build Tools and the WebView2 Evergreen Runtime
- Node.js 22.12 or newer
- pnpm 10.34.5 through Corepack
- Rust 1.87 or newer with the MSVC toolchain
- `ffmpeg` and `ffprobe` available on `PATH`

FFmpeg binaries are not bundled in Phase 1 and must be available on `PATH`.

## Setup

```sh
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm --dir apps/desktop tauri dev
```

Run `pnpm check`, `pnpm lint`, and `pnpm format:check` before submitting changes.

## Windows release gate

Every push and pull request compiles and tests the native project on `windows-2025`, including the Windows Job Object supervisor branch, and assembles the production Tauri executable without downloading installer tooling.

Publishing a GitHub release runs the installer gate on a fresh protected `release` environment. It builds both MSI and NSIS packages, installs and launches the NSIS artifact, verifies the release executable uses the Windows GUI subsystem, runs the system-FFmpeg tool-status/media-probe smoke, and archives the signed executable, installers, and SHA-256 checksums.

Release artifacts must be Authenticode-signed with SHA-256 and timestamped using the certificate issuer's service. Configure the protected `release` environment with base64 PFX secret `WINDOWS_CERTIFICATE`, PFX-password secret `WINDOWS_CERTIFICATE_PASSWORD`, and HTTP(S) repository variable `WINDOWS_TIMESTAMP_URL`; missing credentials, invalid signatures, smoke failures, or unsigned artifacts block the release. CI installs FFmpeg 8.1.2 only for smoke coverage and does not bundle it.

## Current implementation checkpoint

Phase 1 is complete. The desktop provides strict new/open/save persistence, controlled proxy playback, a thumbnail timeline, exact frame trim controls, save-before-activation Apply/Undo/Redo, keyboard frame navigation, native overwrite confirmation, cancellable verified export, and controlled final-preview playback.

The final source has 123 unique passing TypeScript tests: 39 contracts, 5 project/history, 9 render compiler, and 70 desktop IPC/controller/component/integration/accessibility tests. The Rust crate passes 62 default tests and 68 `tauri-ipc-test` tests; all eight system-FFmpeg integrations pass.

Real Windows evidence proves native create/open/prepare/play, `[5, 50)` trim, Undo/Redo, collision cancel/replace, export/reopen, exact 1.5-second ffprobe output, long-render cancellation with zero surviving FFmpeg/partials/output, the required recovery-state matrix, 480px/320px/200% reflow, and accessibility checks. Exact-SHA Linux and Windows CI evidence is recorded in [`apps/desktop/evidence/phase-1/verification.md`](./apps/desktop/evidence/phase-1/verification.md); see also [`ROADMAP.md`](./ROADMAP.md) and [`apps/desktop/DESIGN.md`](./apps/desktop/DESIGN.md).

## Project format

Projects use the `.svpvideo` extension. A file is strict, versioned JSON containing one asset, one sequence, one video track, immutable revisions, rational frame times, and safe source locators. Proxy, thumbnail, decoder, and render-cache paths are never persisted.

## Security boundary

The Phase 1 architecture keeps arbitrary filesystem access and shell execution outside the React webview. Native commands use Rust-owned dialogs and per-window path grants; Rust canonicalizes and revalidates project, source, cache, and output paths, and FFmpeg receives validated argument arrays without a shell. The asset protocol is active only for product-owned derived media beneath `$APPCACHE/video-phase1/**/*`; source files and final exports are excluded. Production uses an explicit local-only CSP, and the main-window capability grants only event listen/unlisten access.

## Phase 1 target contract and limitations

The implemented Phase 1 workflow supports one local asset, one clip, one track, exact frame trims, controlled proxy playback, and one verified MP4 export. Multiple clips, captions, transitions, stock media, cloud services, agents, native compositing, and bundled FFmpeg distribution are outside Phase 1. Phase 2 remains blocked until the Step 18 hard completion evidence is committed.
