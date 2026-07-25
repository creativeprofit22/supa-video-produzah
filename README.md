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

The native project boundary, FFmpeg/FFprobe status and media probing, controlled proxy/thumbnail preparation, cancellable render jobs, and verified native MP4 export are implemented. The desktop shell connects source selection, preparation, render progress, cancellation, collision handling, and export results to React; native project commands are registered but are not exposed through a new/open/save workflow yet.

Prepared-proxy playback, project new/open/save wiring, timeline trimming, undo/redo controls, reopen, and the complete end-to-end Phase 1 UI gate remain pending. The setup commands run the current checkpoint, not the complete Phase 1 workflow. See [`ROADMAP.md`](./ROADMAP.md) for live completion status and verification evidence.

## Project format

Projects use the `.svpvideo` extension. A file is strict, versioned JSON containing one asset, one sequence, one video track, immutable revisions, rational frame times, and safe source locators. Proxy, thumbnail, decoder, and render-cache paths are never persisted.

## Security boundary

The Phase 1 architecture keeps arbitrary filesystem access and shell execution outside the React webview. Native commands use Rust-owned dialogs and per-window path grants; Rust canonicalizes and revalidates project, source, cache, and output paths, and FFmpeg receives validated argument arrays without a shell. The asset protocol is active only for product-owned derived media beneath `$APPCACHE/video-phase1/**/*`; source files and final exports are excluded. Production uses an explicit local-only CSP, and the main-window capability grants only event listen/unlisten access.

## Phase 1 target contract and limitations

The completed Phase 1 workflow will support one local asset, one clip, one track, exact frame trims, controlled proxy playback, and one verified MP4 export. Multiple clips, captions, transitions, stock media, cloud services, agents, native compositing, and bundled FFmpeg distribution are outside Phase 1.
