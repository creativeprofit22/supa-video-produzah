# Phase 7 evidence: rights-checked stock and public media

These results come from automated runs on 2026-09-29; nothing was checked by hand.

## `rights-e2e.json`: scripted real-app run (fixture provider)

Command: `cargo test --lib rights_export_e2e -- --nocapture`, with
`SUPA_VIDEO_RIGHTS_EVIDENCE` set. It uses a local fixture HTTP server, the real
bundled FFmpeg and ffprobe, and the production TypeScript compiler
(`compile-rights-export.mjs`):

1. Search returns 1 advisory candidate.
2. Acquire with provider and item ids only. The file is downloaded to
   quarantine, SHA-256 hashed, checked with ffprobe and promoted. The receipt
   has 3 snapshots (api-record, landing-page, license-page), license CC BY 4.0,
   policy allow.
3. The asset goes on the timeline with its `origin` and is exported through the
   render worker. The export completes, and `credits.json` and `CREDITS.txt`
   are written next to the output.
4. The upstream record is withdrawn (HTTP 410), and the refresh records it as
   `withdrawn`.
5. Export is then blocked with `rights_upstream_withdrawn`. This holds on the
   fresh and the persisted/reauthorized paths, with the origin kept and with it
   stripped.

## `live-search.json`: live search across three providers

Command: `cargo test --lib live_three_provider_search -- --ignored --nocapture`.
It goes through the production network policy (HTTPS, host allowlist, caps).

- Wikimedia Commons: ok, 14 live candidates, licenses normalized.
- Openverse: ok, 20 live candidates, licenses normalized.
- Internet Archive: ok, 20 live candidates, licenses normalized. One item
  normalized to `unknown` and is blocked for public use.
- Smithsonian, Pexels, Pixabay, Freesound: skipped because no API key is in the
  system keyring (service `supa-video-producer.rights`). They were not faked.

## `live-acquire-internet-archive.json`: live acquisition

Command: `cargo test --lib live_internet_archive_acquisition -- --ignored --nocapture`.

A real CC BY 4.0 video (`download_20251006_2303`, 748,560 bytes, MP4) was
acquired from the live Internet Archive through the production policy. The run:

- followed the `archive.org/download` redirect to a storage node, which is
  allowed only when the host is a single label under `.us/.ca.archive.org`;
- streamed and hashed the file, checked its MIME type and verified it with the
  real ffprobe;
- promoted the file and wrote the receipt, with 3 HTTPS snapshots and policy
  allow for commercial-online.
