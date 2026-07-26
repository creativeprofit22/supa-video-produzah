# Supa Video Producer

Supa Video Producer is a standalone, offline-first Tauri desktop application. Phase 3 now pins and verifies one bundled FFmpeg/ffprobe toolchain for Windows x86_64 on top of the Rust-owned canonical project engine and crash recovery.

## Prerequisites

- Windows x86_64 with Microsoft C++ Build Tools and the WebView2 Evergreen Runtime
- Node.js 22.12 or newer
- pnpm 10.34.5 through Corepack
- Rust 1.87 or newer with the MSVC toolchain

Production does not use system FFmpeg or search `PATH`. Explicit development comparison tests may still use a separately installed system FFmpeg.

## Setup

```sh
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm --dir apps/desktop media:bootstrap:windows
pnpm --dir apps/desktop media:verify:windows
pnpm --dir apps/desktop tauri dev --config src-tauri/tauri.media-tools.windows.conf.json
```

Run `pnpm check`, `pnpm lint`, and `pnpm format:check` before submitting changes.

## Windows release gate

Every push and pull request keeps the TypeScript and Linux Rust gates network-free. The Windows job caches the pinned archive by SHA-256, runs adversarial bootstrap tests, stages and verifies the exact executables, exercises all-feature Rust tests, and assembles the production Tauri executable with the media-resource overlay.

Publishing a GitHub release is fail-closed while `distributionReview.status` in the compiled manifest is not `approved`. After approval, the protected `release` environment builds signed MSI and NSIS packages, verifies signatures and installed resource hashes, probes the bundled capabilities with a stripped `PATH`, launches the installed GUI without system FFmpeg, and archives installers plus compliance/hash evidence.

Release artifacts must be Authenticode-signed with SHA-256 and timestamped using the certificate issuer's service. Configure the protected `release` environment with base64 PFX secret `WINDOWS_CERTIFICATE`, PFX-password secret `WINDOWS_CERTIFICATE_PASSWORD`, and HTTP(S) repository variable `WINDOWS_TIMESTAMP_URL`; missing approval, credentials, signatures, resources, capabilities, or stripped-`PATH` smoke proof blocks release.

## Current implementation checkpoint

Phase 3's FFmpeg distribution baseline is implemented on Phase 2 HEAD `7ad26432e6ffa36e63f1fc85349345179c31fd72`. The product pins Gyan FFmpeg 8.1.2 release essentials by archive length/SHA-256, source commit, executable hashes, build flags, and required encoder/muxer/filter capabilities.

Rust compiles the manifest into the application, resolves only exact contained bundled resources, rejects symlinks/reparse points and hash/capability mismatches, and passes verified absolute paths into the existing no-shell process supervisor. Production status, probe, preparation, and render commands share this managed toolchain and expose no path override or `PATH` fallback.

The production UI keeps the Phase 2 single-clip workflow and now reports the sanitized bundled source, short version, stable toolchain ID, and actionable missing/damaged/incompatible states. Local gates pass 138 TypeScript tests, 121 default all-feature Rust tests, all eight explicit bundled-FFmpeg integrations, all three stripped-`PATH` packaged IPC integrations, bootstrap adversarial checks, Clippy with warnings denied, Tauri executable/MSI/NSIS assembly, installed-resource hash verification, and stripped-`PATH` launch. See [`apps/desktop/evidence/phase-3/ffmpeg-distribution.md`](./apps/desktop/evidence/phase-3/ffmpeg-distribution.md).

## Project format and portability

A project consists of the user-selected `.svpvideo` V2 snapshot **and its sibling `.svpvideo.data/` directory**. Move or back up both together.

The sidecar contains the session lock, append-only `journal.ndjson`, and previous snapshot. Snapshot reads are capped at 16 MiB, journal reads at 64 MiB, records and command-group requests at 1 MiB, and command groups at 100 commands. Phase 2 retains the complete journal hash chain and does not compact it.

V1 projects migrate on first native open. The selected V1 state and stable media/timeline IDs are preserved, while legacy undo branches reset at one explicit irreversible migration boundary. Proxy, thumbnail, decoder, GPU, file-handle, render-job, playhead, selection, and viewport data are never persisted.

## Security boundary

The architecture keeps arbitrary filesystem access, canonical project mutation, and media-process execution outside the React webview. Native commands use Rust-owned dialogs and per-window path grants; Rust canonicalizes and revalidates project, source, cache, output, and bundled-resource paths. An embedded manifest verifies exact FFmpeg/ffprobe hashes before the existing no-shell supervisor spawns them with bounded output and descendant cleanup. The asset protocol is active only for product-owned derived media beneath `$APPCACHE/video-phase1/**/*`; source files, bundled tools, and final exports are excluded. Production uses an explicit local-only CSP, and the main-window capability grants only event listen/unlisten and close-guard access.

## Current UI contract and limitations

The V2 domain supports ordered assets, sequences, typed video/audio/caption tracks, clips, markers, fixed-point transforms/gain, and nested-sequence references. The production UI intentionally remains the proven one-local-clip workflow. Professional multitrack interaction, transitions, stock media, cloud services, agents, native compositing, journal compaction, content-addressed ingest, durable media jobs, cache budgets, and waveform/keyframe generation remain later Phase 3 work. Public distribution also remains blocked pending explicit GPL/source-offer and codec-patent review.
