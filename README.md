# Supa Video Producer

Supa Video Producer is a standalone, offline-first Tauri desktop application. Phase 3A adds content-addressed ingest and deterministic derived media on top of the Rust-owned canonical project engine, crash recovery, and pinned Windows FFmpeg/ffprobe toolchain.

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

Phase 3A is implemented from audited baseline `cd262b41f48361ccc98e185c86a51761bb0fec04`. The product pins Gyan FFmpeg 8.1.2 release essentials and now streams authorized source bytes into a global app-owned SHA-256 media store.

Equal bytes selected under different filenames, project IDs, or asset IDs converge on one verified object and compatible proxy/thumbnail paths. Derived keys include source content, managed toolchain, complete preview/color profile, stream/rate/geometry/sampling choices, ordered path-neutral FFmpeg arguments, and validation policy. Corrupt exact destinations repair under per-key locks while unrelated files and the legacy cache survive.

Grouped import, preparation, and relink use bundled FFprobe, persist exact content identity, reject caller probe/identity tampering before project mutation, and preserve asset UUIDs through relink/undo/redo/replay/reopen. Local gates pass 153 TypeScript tests, 129 all-feature Rust/configuration tests, 3 Chromium checks, all 8 explicit FFmpeg integrations, and all 3 enhanced packaged integrations with an empty `PATH`. See [`apps/desktop/evidence/phase-3/content-addressed-ingest.md`](./apps/desktop/evidence/phase-3/content-addressed-ingest.md).

## Project format and portability

A project consists of the user-selected `.svpvideo` V2 snapshot **and its sibling `.svpvideo.data/` directory**. Move or back up both together.

The sidecar contains the session lock, append-only `journal.ndjson`, and previous snapshot. Snapshot reads are capped at 16 MiB, journal reads at 64 MiB, records and command-group requests at 1 MiB, and command groups at 100 commands. Phase 2 retains the complete journal hash chain and does not compact it.

V1 projects migrate on first native open. The selected V1 state and stable media/timeline IDs are preserved, while legacy undo branches reset at one explicit irreversible migration boundary. Proxy, thumbnail, decoder, GPU, file-handle, render-job, playhead, selection, and viewport data are never persisted.

## Security boundary

The architecture keeps arbitrary filesystem access, canonical project mutation, and media-process execution outside the React webview. Native commands use Rust-owned dialogs and per-window path grants; Rust canonicalizes and revalidates project, source, cache, output, and bundled-resource paths. An embedded manifest verifies exact FFmpeg/ffprobe hashes before the no-shell supervisor spawns them with bounded output and descendant cleanup. The asset protocol exposes only product-owned artifacts beneath `$APPCACHE/supa-video-media-v1/derived/**/*`; content objects, locks, source files, bundled tools, legacy cache files, and final exports are excluded. Production uses an explicit local-only CSP, and the main-window capability grants only event listen/unlisten and close-guard access.

## Current UI contract and limitations

The V2 domain supports ordered assets, sequences, typed video/audio/caption tracks, clips, markers, fixed-point transforms/gain, nested-sequence references, and optional exact source-content identities. The production UI intentionally remains the proven one-local-clip workflow. Phase 3B next adds durable media jobs, scheduling, retry/resume, restart recovery, cache budgets/leases/eviction, audio intermediates, waveforms, keyframe indexes, transcription, and job-center UI. Professional multitrack interaction, transitions, stock media, cloud services, agents, native compositing, and journal compaction remain later work. Public distribution also remains blocked pending explicit GPL/source-offer and codec-patent review.
