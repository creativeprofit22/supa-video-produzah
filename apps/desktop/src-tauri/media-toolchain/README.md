# Bundled FFmpeg toolchain

This directory declares the only FFmpeg/ffprobe build production may execute. The tracked manifest is compiled into the Rust application; staged executables are local build artifacts and are never committed.

## Supported target

- `x86_64-pc-windows-msvc`: Gyan FFmpeg 8.1.2 release essentials
- Every other target fails closed as bundled tools unavailable.
- Production never searches `PATH` or accepts a tool path from the webview.

## Bootstrap and verify

From the repository root on Windows:

```powershell
pnpm --dir apps/desktop media:bootstrap:windows
pnpm --dir apps/desktop media:verify:windows
```

For offline or CI use, pass the exact cached archive:

```powershell
pnpm --dir apps/desktop media:bootstrap:windows -ArchivePath C:\cache\ffmpeg-8.1.2-essentials_build.zip
```

Bootstrap strictly validates the manifest, archive length/SHA-256, ZIP entries, executable hashes, version/build configuration, and required encoders/muxers/filters before atomically staging `ffmpeg.exe` and `ffprobe.exe` under `bin/x86_64-pc-windows-msvc/`.

## Updating

1. Select one immutable, versioned provider release and confirm it is an official FFmpeg download-page source.
2. Record the exact toolchain ID, FFmpeg version/tag/source commit, commit URL, provider URL/build date, archive URL/name/length/SHA-256, executable lengths/SHA-256 values, variant, architecture, and license class.
3. Verify the archive first, then measure executable identities and required capabilities; never derive a trusted value from an unverified download.
4. In one change, update `manifest.v1.json`, every `Pinned*` constant in `scripts/bootstrap-ffmpeg-windows.ps1`, every `PINNED_*` constant in `src/video/toolchain.rs`, `THIRD_PARTY_NOTICES.md`, `SOURCE_OFFER.md`, the CI archive URL/cache key, and the Tauri package overlay.
5. Keep `sourceCommit` byte-for-byte equal to the commit suffix in `sourceUrl`. Bootstrap, runtime, and the release gate must pin the source URL, provider URL, provider build date, and complete archive identity exactly.
6. Update `validator-parity.v1.json` whenever identity or review validation changes. Both the PowerShell and Rust tests consume this one mutation corpus; add every accepted/rejected edge case there instead of creating validator-specific cases.
7. Leave `distributionReview.status` as `pending` with all three metadata fields `null` until a named legal review supplies the required evidence. `rejected` also requires all metadata fields to remain `null`; `approved` requires a non-blank reviewer, real `YYYY-MM-DD` calendar date, and durable fragment-free HTTPS reference.
8. Run `pnpm --dir apps/desktop media:test:windows`, `pnpm --dir apps/desktop media:verify:windows`, and `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml toolchain::tests`, then complete package assembly, installed-file hash checks, and stripped-`PATH` smoke tests.

Never update hashes to make an unexplained mismatch pass. Treat replacement of a versioned provider artifact as a supply-chain incident.

## Distribution review

Local development and verification may use `pending` or `rejected` only when `reviewedBy`, `reviewedAt`, and `reference` are all `null`. Public release automation requires `approved`, a non-blank `reviewedBy`, a real `YYYY-MM-DD` calendar date, and a durable HTTPS evidence URL without a fragment.

Approval must separately address GPL source availability and codec-patent exposure. The release gate runs the same strict bootstrap validator before signing; the compiled Rust validator enforces the matching provenance/review matrix at runtime. The application UI reports only tool readiness and identity; it never represents legal approval.
