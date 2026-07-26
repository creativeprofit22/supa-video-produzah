# Third-party notices: FFmpeg toolchain

## Distributed artifact

Supa Video Producer packages `ffmpeg.exe` and `ffprobe.exe` from **Gyan FFmpeg 8.1.2 release essentials**, built 27 June 2026 for 64-bit Windows.

- Provider: Gyan Doshi, <https://www.gyan.dev/ffmpeg/builds/>
- Immutable archive: [`ffmpeg-8.1.2-essentials_build.zip`](https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip)
- Archive identity: `109728040` bytes; SHA-256 `db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec`
- Release: <https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2>
- FFmpeg source commit: [`38b88335f99e76ed89ff3c93f877fdefce736c13`](https://github.com/FFmpeg/FFmpeg/commit/38b88335f99e76ed89ff3c93f877fdefce736c13)
- Provider declaration: 64-bit static GPLv3 build
- Exact hashes and required capabilities: [`manifest.v1.json`](./manifest.v1.json)

The provider build configuration includes `--enable-gpl`, `--enable-version3`, `--enable-static`, `--enable-libx264`, `--enable-libx265`, and `--enable-libzimg`. The selected archive also declares other third-party libraries in the preserved provider notice at [`licenses/GYAN-FFMPEG-README.txt`](./licenses/GYAN-FFMPEG-README.txt).

## License and source obligations

The distributed FFmpeg executables are declared **GPL-3.0-or-later** by their provider. The complete license text shipped in the selected archive is preserved at [`licenses/GPL-3.0.txt`](./licenses/GPL-3.0.txt).

Corresponding-source availability and release evidence are recorded in [`SOURCE_OFFER.md`](./SOURCE_OFFER.md). A public release is mechanically blocked while `distributionReview.status` in the manifest is not `approved`.

FFmpeg licensing compliance and codec-patent clearance are separate questions. Inclusion of H.264/AAC and other codecs may create patent obligations depending on distribution and territory. This repository does not claim patent clearance or legal approval; a named external review must approve both the GPL/source route and codec posture before public distribution.

## No warranty

FFmpeg and its included libraries are provided under their respective terms and without warranty. See the included GPL text and provider notice for the controlling terms and build details.
