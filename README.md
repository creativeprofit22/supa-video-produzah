# Supa Video Producer

Supa Video Producer is a standalone, offline-first Tauri desktop application for trimming one local video clip and exporting a verified H.264/AAC MP4.

## Phase 1 prerequisites

- Windows with Microsoft C++ Build Tools and the WebView2 Evergreen Runtime
- Node.js 22.12 or newer
- pnpm 10.34.5 through Corepack
- Rust 1.87 or newer with the MSVC toolchain
- `ffmpeg` and `ffprobe` available on `PATH`

The application checks FFmpeg before project work begins. FFmpeg binaries are not bundled in Phase 1.

## Setup

```sh
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm --dir apps/desktop tauri dev
```

Run `pnpm check`, `pnpm lint`, and `pnpm format:check` before submitting changes.

## Project format

Projects use the `.svpvideo` extension. A file is strict, versioned JSON containing one asset, one sequence, one video track, immutable revisions, rational frame times, and safe source locators. Proxy, thumbnail, decoder, and render-cache paths are never persisted.

## Security boundary

The React webview cannot read arbitrary files or launch shell commands. Rust-owned dialogs create per-window path grants; Rust canonicalizes and revalidates all project, source, cache, and output paths. FFmpeg receives validated argument arrays without a shell. Cache media is exposed only from the narrow `$APPCACHE/video-phase1/**/*` asset scope.

## Phase 1 limitations

Phase 1 supports one local asset, one clip, one track, exact frame trims, controlled proxy playback, and one MP4 export. It does not include multiple clips, captions, transitions, stock media, cloud services, agents, native compositing, or bundled FFmpeg distribution.
