# Supa Video Producer

Supa Video Producer is a standalone, offline-first Tauri desktop application. Phase 2 adds a Rust-owned canonical project engine with durable command history and exact crash recovery.

## Prerequisites

- Windows with Microsoft C++ Build Tools and the WebView2 Evergreen Runtime
- Node.js 22.12 or newer
- pnpm 10.34.5 through Corepack
- Rust 1.87 or newer with the MSVC toolchain
- `ffmpeg` and `ffprobe` available on `PATH`

FFmpeg binaries are not bundled yet and must be available on `PATH`.

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

Phase 2 is implemented on top of baseline `a0a636995a453789b46640512aa9bccb4ed89c31`. Rust now owns V2 command execution, semantic inverses, monotonic revisions, idempotency, advisory project locks, append-and-sync NDJSON history, periodic atomic snapshots, V1 migration, replay, torn-tail repair, and recovery reports. React consumes validated projections and retains only ephemeral playback, draft, preparation, and render state.

The production UI keeps the Phase 1 single-clip workflow while importing asset/sequence/clip as one command group, applying trim through the native service, using durable undo/redo, exporting from a V2 renderable revision, relinking through a native picker/probe transaction, and exposing a hidden in-flow Project Inspector with `Ctrl/Cmd+Alt+D`.

Local gates pass 48 desktop tests, 44 contract tests, 7 project-helper tests, 10 render-compiler tests, 81 all-feature Rust tests, four explicit real-FFmpeg integrations, Clippy with warnings denied, and the Windows Tauri production build. Release measurements on this machine are 2.9 ms p95 durable command acknowledgment and 656 ms to scan a generated 10,000-record journal. See [`apps/desktop/evidence/phase-2/verification.md`](./apps/desktop/evidence/phase-2/verification.md).

## Project format and portability

A project consists of the user-selected `.svpvideo` V2 snapshot **and its sibling `.svpvideo.data/` directory**. Move or back up both together.

The sidecar contains the session lock, append-only `journal.ndjson`, and previous snapshot. Snapshot reads are capped at 16 MiB, journal reads at 64 MiB, records and command-group requests at 1 MiB, and command groups at 100 commands. Phase 2 retains the complete journal hash chain and does not compact it.

V1 projects migrate on first native open. The selected V1 state and stable media/timeline IDs are preserved, while legacy undo branches reset at one explicit irreversible migration boundary. Proxy, thumbnail, decoder, GPU, file-handle, render-job, playhead, selection, and viewport data are never persisted.

## Security boundary

The architecture keeps arbitrary filesystem access, canonical project mutation, and shell execution outside the React webview. Native commands use Rust-owned dialogs and per-window path grants; Rust canonicalizes and revalidates project, source, cache, and output paths, and FFmpeg receives validated argument arrays without a shell. The asset protocol is active only for product-owned derived media beneath `$APPCACHE/video-phase1/**/*`; source files and final exports are excluded. Production uses an explicit local-only CSP, and the main-window capability grants only event listen/unlisten access.

## Current UI contract and limitations

The V2 domain supports ordered assets, sequences, typed video/audio/caption tracks, clips, markers, fixed-point transforms/gain, and nested-sequence references. The production UI intentionally remains the proven one-local-clip workflow. Professional multitrack interaction, transitions, stock media, cloud services, agents, native compositing, journal compaction, and bundled FFmpeg distribution remain later phases.
