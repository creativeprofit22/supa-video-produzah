# Phase 3A content-addressed ingest evidence

**Date:** 26 July 2026<br>
**Audited baseline:** `cd262b41f48361ccc98e185c86a51761bb0fec04`<br>
**Bundled toolchain:** `ffmpeg-8.1.2-gyan-essentials-windows-x86_64`<br>
**Public distribution review:** `pending` — no legal approval is claimed

## Implemented boundary

- Grouped import, preparation, and relink authorize an exact owner source grant before source metadata, store creation, hashing, probing, or process execution.
- Grouped import and relink now consume `MediaToolchainState`, verify the bundled FFprobe path, and probe the canonical object copy. Source guards reject literal `ffmpeg`/`ffprobe` construction, executable parameters, and environment lookup in every production media command.
- Exact bytes stream into `$APPCACHE/supa-video-media-v1/objects/sha256/<prefix>/<digest>.blob`. The content identity is lowercase SHA-256 plus a positive JavaScript-safe byte length; path and project IDs are excluded.
- Proxy and thumbnail keys include artifact kind, source identity, managed toolchain ID, complete preview-profile identity, and a path-neutral ordered FFmpeg recipe plus validation policy.
- Derived artifacts live independently under `derived/proxy/` and `derived/thumbnail_tile/`. Exact corrupt destinations repair under per-key locks; unrelated files and the legacy `$APPCACHE/video-phase1` tree are not swept.
- Only `$APPCACHE/supa-video-media-v1/derived/**/*` is exposed through Tauri's asset protocol. Object and lock paths are never returned to the webview.
- New import and relink operations persist `MediaContentIdentityV1`. Relink preserves the asset UUID, and semantic inverse, undo, redo, journal replay, close, and reopen preserve locator, probe, and identity together. Old V1/V2 fixtures without identity remain valid.

## Deterministic identity proof

The shared fixture `packages/video-media/fixtures/identity-v1.json` pins the UTF-8 domain separators, u32 little-endian field lengths, raw digest bytes, u64 little-endian safe integers, ordered profile fields, recipe tokens, and expected SHA-256 outputs. Browser `crypto.subtle` and Rust produce the same profile digest, recipe digest, and derived key.

Portable tests prove:

- equal bytes under different names produce different source fingerprints but the same object path and compatible derived identity;
- one-byte source mutation changes content and artifact identity;
- toolchain, profile, color transfer/HDR policy, rate, geometry, stream mapping, audio selection, thumbnail sampling, duration, and argv order invalidate the expected identity;
- malformed, uppercase, unknown-field, zero-length, and unsafe-integer identities fail strict Zod/Serde validation.

## Storage and failure proof

Portable Rust tests cover duplicate-byte convergence, concurrent ingest, corrupt-object repair, exact-destination artifact repair, lock timeout, changed-during-read detection, source read/write/flush/sync/promotion failpoints, traversal and malformed components, non-directories, symlink/reparse rejection where the platform permits creation, unrelated-file preservation, and zero surviving ingest/derive partials.

The grouped-import gateway rejects probe or content-identity tampering before journal append. Relink identity is covered through inverse, undo, redo, persisted journal replay, close, and reopen. Preparation rejects a source whose bytes differ from an already identified project asset.

## Measured verification

| Gate                                  | Measured result                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen pnpm install                   | Passed with pnpm `10.34.5`                                                                                                                                                 |
| Root build and TypeScript checks      | Passed                                                                                                                                                                     |
| ESLint and Prettier                   | Passed                                                                                                                                                                     |
| TypeScript tests                      | **153 passed**: 53 contracts, 8 media, 7 project, 10 render, 75 desktop                                                                                                    |
| Chromium browser tests                | **3 passed** at desktop and 320 px/200% text, including Axe and forced-colors checks                                                                                       |
| Rust all-feature suite                | **129 passed**: 125 unit/IPC/recovery/security tests plus 4 configuration tests; 11 explicit environment/package tests skipped by default                                  |
| Rustfmt                               | Passed                                                                                                                                                                     |
| All-target/all-feature Clippy         | Passed with `-D warnings`                                                                                                                                                  |
| Explicit real-FFmpeg integrations     | **8 passed**: IPC probe; proxy reuse/repair; display normalization; HDR tone map; AV/video-only render; collision; cancellation cleanup                                    |
| Packaged stripped-`PATH` integrations | **3 passed** using assembled `target/release/media-tools`: tamper fail-closed; create/import/prepare/relink/reopen/dedupe/mutation/corruption/render; cancellation cleanup |
| Bootstrap adversarial suite           | **51 assertions passed**                                                                                                                                                   |
| Staged media verification             | Passed for FFmpeg/FFprobe `8.1.2` and pinned hashes/capabilities                                                                                                           |
| Release durable acknowledgement       | **4.6883 ms p95**, below 100 ms                                                                                                                                            |
| Release 10,000-record journal scan    | **689.4418 ms**, below 2 seconds                                                                                                                                           |
| Windows Tauri no-bundle assembly      | Passed with the media-resource overlay                                                                                                                                     |
| `git diff --check`                    | Passed                                                                                                                                                                     |

The packaged complete test ran with `PATH` empty and the cargo executable addressed absolutely. It created a project, prepared and grouped-imported the canonical fixture, relinked the same bytes under another filename while preserving the asset UUID, reopened persisted identity, reused identical proxy/thumbnail paths, repaired a corrupted proxy, selected new identities and paths after source mutation, and completed the unchanged final render path. The two other stripped-`PATH` packaged tests proved executable tamper rejection and cancellation cleanup.

## Deferred Phase 3B

Durable media jobs/events, scheduling and priority, retry/resume, restart recovery, cache budgets/leases/eviction, audio intermediates, waveforms, keyframe indexes, transcription, and job-center UI remain deferred. The legacy cache remains untouched until a lease-aware Phase 3B migration or eviction policy exists.
