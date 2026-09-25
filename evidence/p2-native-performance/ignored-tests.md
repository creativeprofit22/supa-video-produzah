# Original ignored tests — historical accounting

Read-only reconciliation on 2026-09-19, not a test rerun. Historical `7771df6` source contains 19 ignored names; current source retains all 19 and adds the caption test (row 9). Source comparison execution `a651a8b7-1d48-4dc1-96c7-b232f4ed9b60` exited 0. The link between that historical tree and execution `b76b4be0-26bb-4920-af2a-479fe6877f12` is preserved in `evidence/2026-09-05-p0-repeatable-checks/verification.md`.

Raw-log inspection `78fa9cc1-705f-422c-9912-fde9f3f95e17` exited 0 and found all 20 individual test logs below. Each contains `1 passed; 0 failed; 0 ignored; 0 measured; 378 filtered out`. Execution exit 0 is recorded by the historical final-verification ledger; these raw stdout logs do not independently contain command exit metadata. Do not equate this reconciliation's exit with historical test exits.

Log root: `C:/Users/SPARTAN PC/.gg/foreground/`. Each ID names `<ID>.log`; the reconciliation log retains a full SHA-256 for every raw log, exact result excerpts and row number.

Prerequisites: **S** = system FFmpeg/ffprobe and fixture; **H** = S plus HDR/zscale/tonemap capabilities; **G** = S plus rotated/anamorphic generation; **B** = assembled pinned Windows resource overlay and mock IPC harness. Current rerun disposition: row 18 passed after repaired prerequisite gates; the other 19 remain **historical pass, not rerun**. Historical passes below are retained, not promoted to release-WebView or current-tree acceptance.

| Row                | Exact test                                                                                        | Prerequisite                | Historical passing execution           |
| ------------------ | ------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------- |
| 1                  | `video::tests::local_ffmpeg_status_and_canonical_probe_match_fixture`                             | S                           | `0c976025-761a-4d6d-93ff-a58f89533648` |
| 2                  | `video::tests::derived_local_ffmpeg_prepares_reuses_and_repairs_controlled_artifacts`             | S                           | `d799b733-7b82-47e6-a20d-797f1c48d78d` |
| 3                  | `video::tests::durable_preparation_restart_system_ffmpeg_proves_all_crash_boundaries`             | S                           | `d06f9fa8-1e93-4f56-a203-b3616761a432` |
| 4                  | `video::tests::derived_local_ffmpeg_tone_maps_hdr_to_tagged_bt709_sdr`                            | H                           | `8e12761a-1757-4ab1-93a1-17930a8f3f96` |
| 5                  | `video::tests::derived_local_ffmpeg_normalizes_rotated_and_anamorphic_sources`                    | G                           | `f0f3530d-507a-48b5-84b5-c3e80270147e` |
| 6                  | `video::tests::durable_preparation_records_parent_and_hidden_children`                            | S                           | `7fec3045-475a-4513-ad0d-a6b3b8f68f9d` |
| 7                  | `video::tests::final_render_restart_reauthorization_requeues_same_job_and_completes_once`         | S                           | `6450a7cd-05ea-42d2-9a0b-c86a2f4f77d8` |
| 8                  | `video::tests::render_worker_local_ffmpeg_exports_av_and_video_only_with_ordered_verified_events` | S                           | `61f85992-6edc-49cc-90b0-8e7fbcd393f0` |
| 9 (later addition) | `video::tests::render_caption_boundary_local_ffmpeg_v1_v2`                                        | S plus caption/font support | `14c8b9b7-55ed-49ec-a331-55abf0660957` |
| 10                 | `video::tests::render_visibility_local_ffmpeg_outputs_black_video_and_respects_audio_mute`        | S                           | `3f907697-fd98-4172-95a0-5b49f2155d9e` |
| 11                 | `video::tests::render_worker_local_ffmpeg_preserves_no_overwrite_collision`                       | S                           | `d1e928ff-ecbc-4f18-b69b-dee582eff888` |
| 12                 | `video::tests::render_worker_local_ffmpeg_cancellation_reaps_process_and_cleans_partial_once`     | S                           | `55891194-23e6-463d-892c-79c8dccfedc9` |
| 13                 | `tests::packaged_phase3b_hierarchical_preparation_and_restart_boundaries`                         | B                           | `0b77aa5c-478e-4c81-b471-fa0898735496` |
| 14                 | `tests::packaged_phase3b_final_render_reauthorization_retry_and_cancellation`                     | B                           | `4149eb93-49a1-4e66-b650-2e51b7cbcb86` |
| 15                 | `tests::packaged_phase3b_collision_stops_before_preview_preparation`                              | B                           | `2fa83d4a-4d4c-4b97-9557-1b00bd9f29d1` |
| 16                 | `tests::packaged_phase3b_cache_lease_eviction_regeneration_and_legacy_policy`                     | B                           | `85eb585b-00b4-47a1-ab55-ef3c6521f1aa` |
| 17                 | `tests::packaged_media_renamed_or_replaced_executable_fails_before_spawn`                         | B                           | `b79a4361-2e99-46da-81b9-0ce7359db77d` |
| 18                 | `tests::packaged_media_ipc_status_probe_prepare_and_render_complete`                              | B                           | `9ac90d8a-86fa-4496-9f54-213a2ab80160` |
| 19                 | `tests::packaged_media_ipc_render_cancel_cleans_partial`                                          | B                           | `16f669ea-8b30-49c5-bc02-7a8994644b34` |
| 20                 | `tests::picker_source_grant_reaches_media_probe_over_tauri_ipc`                                   | S, mock IPC                 | `2d963b5f-96e7-41be-a065-08a722370040` |

Original 19 = rows 1–8 and 10–20: twelve system-tool tests plus seven bundled-resource tests. Caption owner: phase `85b1e9e2-ec8f-4244-956c-08cb996a6662`, `evidence/2026-09-08-p1-cache-caption-boundaries/README.md`. No duplicated caption implementation or calibration matrix.

## Provenance and procedural distinctions

The September 18 test observations above remain historical passes. The failed prerequisite `811999c0-82d0-4034-a75c-b153cbdc6fba` and subsequent prohibited continuation remain a procedural violation, not a compliant batch. Later separately authorized assembly `f6524d70-39b3-4698-a2fa-c20378a05b56` and corrected row-18 rerun `d87381f8-fabd-4bb1-9068-9b933da5b69e` do not retroactively repair the batch.

Raw receipts inspected directly in this session:

- `bb8e4896-7f8a-4834-b0d4-87920854bc69`: same HEAD plus dirty status; not clean HEAD verification.
- `3f7ff6c1-77ee-409f-a7f0-0ba38b8ae118`: source binaries matched pinned hashes, generated debug manifest still had SHA-256 `aecfbebada0753ac1e80d6493a813d749d902e3d11bc13504a88c1b039df4b45`.
- `35f53a81-0522-4928-8caf-a4d71852d35f`: later equality of seven resources, binary hashes/sizes, source preservation, FFmpeg/ffprobe 8.1.2 version probes with exit 0 and librubberband build flag. Full capability output remains in the raw log.
- `c7b38162-d135-437a-89d6-85ce16c29106`: final source preservation, exact resource hashes including corrected manifest `a827f2f093b7fc1cd91fa6b04573ec939982fa0e5c37cc7ead1594cbab7848d9`, and a 25162752-byte debug executable. No release launch proof.

Freshness: current source manifest and binary hashes match the corrected resource receipt, but source-tree equivalence across every historical individual test has not been established. Retain historical passes; do not blindly repeat all 20 to recover known accounting. The per-command `stamp-resumed-cargo-test.json` was also inspected: it binds the earlier broad native run, not every September 18 individual run. Therefore source equivalence for every individual run is explicitly unverified. Their dispositions stay historical instead of assuming fresh acceptance.

## Current targeted closure after approved repair

The user authorized aligning the bootstrap validator and its regression coverage with the existing rubberband requirement. Execution `5330bc32-c303-4bbe-a67c-f2f52fa8a570` passed 52 bootstrap adversarial assertions and `media:verify:windows` (exit 0); removing rubberband remains rejected. No changed binary or relaxed manifest rule.

Execution `54758748-7414-45ae-99b4-fb07256b786e` then verified source/debug equality for all seven overlay resources and ran **row 18 only**, offline/locked, exact ignored selection, one test thread. Result: **1 passed, 0 failed, 378 filtered**, 22.92 seconds. Snapshot `runs/snapshot-fcdLXv/identity.json`, SHA-256 `64abf435965bcdd42d68c02cffe8eb5cd4d3ffff1bfbd26cad7a751f7031a621`, tracked diff hash `50d06fd6624e8f1ae943d015b7820b1814b120a4e1083129b1a28c89a3ca7083`. Exact argv/environment are retained in the execution log. This closes the current tool-check-to-IPC prerequisite path; it is not release executable launch or parity for the pending stress fixtures.

No blanket rerun of the remaining 19 was selected: their observed historical results satisfy name accounting, and no application/native source changed in this work. Current release/workload parity is assigned to step 4, not inferred from these historical tests. Step 2 accounting is complete with these explicit freshness limits.
