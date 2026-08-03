# Supa Video Producer

Supa Video Producer is a standalone, offline-first Tauri desktop application. Phases 1–3 are complete, and Phase 4 is unblocked for private-use development. Public distribution is deferred pending legal approval of the bundled FFmpeg profile.

## Prerequisites

- Windows x86_64 with Microsoft C++ Build Tools and the WebView2 Evergreen Runtime
- Node.js 22.12 or newer
- pnpm 10.34.5 through Corepack
- Rust 1.94 or newer with the MSVC toolchain (required by the pinned bundled SQLite dependency)

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

The current scope is private use only. Distribution review is deferred until public distribution and does not block Phase 4; `distributionReview.status` intentionally remains `pending`. Publishing a GitHub release stays fail-closed until that status is `approved`.

After documented GPL/source-offer and codec-patent approval, the protected `release` environment builds signed MSI and NSIS packages, verifies signatures and installed resource hashes, probes the bundled capabilities with a stripped `PATH`, launches the installed GUI without system FFmpeg, and archives installers plus compliance/hash evidence. Release artifacts must be Authenticode-signed with SHA-256 and timestamped using the certificate issuer's service. Configure the protected `release` environment with base64 PFX secret `WINDOWS_CERTIFICATE`, PFX-password secret `WINDOWS_CERTIFICATE_PASSWORD`, and HTTP(S) repository variable `WINDOWS_TIMESTAMP_URL`; missing approval, credentials, signatures, resources, capabilities, or stripped-`PATH` smoke proof blocks release.

## Current implementation checkpoint

Phase 3B implementation is present through the ordered local closure series. Production now has strict browser/native job contracts; SQLite job, event, cache, lease, and setting state; hierarchical preparation jobs; durable final-render jobs; bounded priority scheduling; retry, cancellation, and restart recovery; lease-aware deterministic LRU eviction; explicit legacy-cache cleanup; and a project-independent Job Center.

The managed cache keeps the Phase 3A content-addressed object and deterministic derived-media guarantees. Machine-local SQLite state lives under app local data, while cache bytes remain under the app cache root and project snapshots/journals remain authoritative files. Production uses verified bundled Gyan FFmpeg 8.1.2 and never searches `PATH`.

The 28 July closure worktree passes frozen install; root build/check/test/lint/format; 204 TypeScript/Vitest tests; 13 Chromium accessibility/responsive tests; Rustfmt; all-target/all-feature Clippy; 171 non-ignored Rust tests; all 11 explicit real-FFmpeg tests; staged FFmpeg checks; all original packaged IPC tests; three Phase 3B bundled-resource wrappers; release performance checks; and Windows no-bundle assembly. Latest release results were `699.8438 ms` for a generated 10,000-record journal scan, `4.8993 ms` durable-command acknowledgment p95, `11.5919 ms` media-job enqueue/event p95, `4.6878 ms` to list 100 recent jobs, and `2.6108 ms` recovery selection across 10,000 jobs.

Packaged IPC now uses production-shaped Tauri roots and distinct durable render UUIDs. Composite timestamp/job-ID pagination returns equal-timestamp pages losslessly; Job Center can load older records with pending, failure/retry, no-more, focus, live-status, loaded-depth refresh, and narrow/200% text behavior covered.

Literal assembled Windows verification passes with bundled FFmpeg and stripped `PATH`: interrupted proxy recovery preserves parent/child IDs and completes once; ExportPanel and Job Center reconcile cancellation, native destination reauthorization, same-job retry, and completion; active leases survive deterministic test-budget eviction; cache misses regenerate without identity drift; and legacy inventory survives restart until visible confirmation. Independent checks found one terminal event per lifecycle and no final FFmpeg/FFprobe or owned partial residue. Exact-SHA GitHub Actions run [`30764490903`](https://github.com/creativeprofit22/supa-video-produzah/actions/runs/30764490903) passed at HEAD `dbcb519eb2f562834d7ea7086219f87f5d7fbf2f`, with the TypeScript, Rust, and Windows jobs all executing successfully. Phase 3B is complete. See [`apps/desktop/evidence/phase-3/assembled-windows-runtime-closure.md`](./apps/desktop/evidence/phase-3/assembled-windows-runtime-closure.md).

## Project format and portability

A project consists of the user-selected `.svpvideo` V2 snapshot **and its sibling `.svpvideo.data/` directory**. Move or back up both together.

The sidecar contains the session lock, append-only `journal.ndjson`, and previous snapshot. Snapshot reads are capped at 16 MiB, journal reads at 64 MiB, records and command-group requests at 1 MiB, and command groups at 100 commands. Phase 2 retains the complete journal hash chain and does not compact it.

V1 projects migrate on first native open. The selected V1 state and stable media/timeline IDs are preserved, while legacy undo branches reset at one explicit irreversible migration boundary. Proxy, thumbnail, decoder, GPU, file-handle, render-job, playhead, selection, and viewport data are never persisted.

## Security boundary

The architecture keeps arbitrary filesystem access, canonical project mutation, and media-process execution outside the React webview. Native commands use Rust-owned dialogs and per-window path grants; Rust canonicalizes and revalidates project, source, cache, output, and bundled-resource paths. An embedded manifest verifies exact FFmpeg/ffprobe hashes before the no-shell supervisor spawns them with bounded output and descendant cleanup. The asset protocol exposes only product-owned artifacts beneath `$APPCACHE/supa-video-media-v1/derived/**/*`; content objects, locks, source files, bundled tools, legacy cache files, and final exports are excluded. Production uses an explicit local-only CSP, and the main-window capability grants only event listen/unlisten and close-guard access.

## Current UI contract and limitations

The V2 domain supports ordered assets, sequences, typed video/audio/caption tracks, clips, markers, fixed-point transforms/gain, nested-sequence references, and optional exact source-content identities. The production UI intentionally remains the proven one-local-clip workflow. Phase 3B adds durable preparation/render jobs, bounded scheduling, retry/cancel/restart recovery, a lease-aware 20 GiB managed-cache lifecycle, explicit legacy-cache cleanup, and an app-level Job Center. Audio intermediates, waveform pyramids, keyframe indexes, transcription, embeddings, professional multitrack interaction, transitions, stock media, cloud services, agents, native compositing, and journal compaction remain later work. Phase 4 may proceed for private use; public distribution remains fail-closed until documented GPL/source-offer and codec-patent legal approval changes the manifest review status from `pending` to `approved`.
