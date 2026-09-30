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

## `live-acquire-*.json`: live acquisition from all three keyless providers

Command (run 2026-09-30, all 3 passed):

```
cargo test --lib live_ -- --ignored --nocapture --test-threads=1
```

The evidence paths come from `SUPA_VIDEO_RIGHTS_LIVE_ACQUIRE_EVIDENCE` (Internet
Archive), `SUPA_VIDEO_RIGHTS_LIVE_ACQUIRE_COMMONS_EVIDENCE` and
`SUPA_VIDEO_RIGHTS_LIVE_ACQUIRE_OPENVERSE_EVIDENCE`. All three tests share one
helper. For each provider it takes one real item whose license allows
commercial-online use, found by a fixed live query with no user input, and runs
it through the production network policy. Each item then goes through the same
steps: quarantine download with streamed SHA-256, MIME check, real ffprobe
verification, promotion and receipt commit. Afterwards the test re-reads the
promoted object from disk, re-hashes it and checks it against the receipt.

| Provider | Item | Media | Bytes | License | Policy | Snapshots |
|---|---|---|---|---|---|---|
| Wikimedia Commons | `File:Sunrise Timelapse (30174294051).webm` | video/webm | 7,046,837 | PDM 1.0 | allow | api-record, landing-page, license-page |
| Openverse | `image:a434d427-8a9c-4e39-aa61-cfe5bea37310` ("Sunrise at Ramp 25") | image/jpeg | 98,275 | PDM 1.0 | allow | api-record, landing-page, license-page |
| Internet Archive | `museo-de-las-culturas-mayas-cancun-…` | video/mp4 | 8,627,583 | CC BY 4.0 | allow | api-record, landing-page, license-page |

No candidate was skipped in this run (`skippedItems: []` for all three). The
Internet Archive download followed the `archive.org/download` redirect to a
storage node. The allowlist accepts that node only when it is a single label
under `.us.archive.org` or `.ca.archive.org`. Openverse has no video search, so
its live item is an image, checked by ffprobe as an image stream. Images can be
acquired and receipted, but they cannot be placed on the timeline yet.
