# P3 · Delivery and verification (source Phase 10) — evidence

Roadmap phase `44613e71-d500-4404-8c8b-de7c495d3d1a`, approved plan `6184c4e2-d844-44f6-82bb-5fd1311319c7`.

## User decisions (1 Oct 2026)

1. Phase 9's measured deferral (phase `d665936f`, Done 1 Oct 2026) satisfies Phase 10's "Phases 5–9" dependency. If a preview target later fails, Phase 9 reopens separately.
2. A verified **private, unsigned Windows build** completes this phase. Public distribution stays with phase `297929a2` (not started) and is not claimed here.
3. No auto-updater: recorded non-goal (single-user personal app, no signing key or update host).
4. Provenance is a plain readable manifest beside each export; no C2PA signing.

## Criterion 1 — Phase 9 dependency vs Milestone C wording

- Conflict: `ROADMAP.md` Phase 10 said "Depends on: Phases 5–9"; Milestone C said Phase 9 only "where profiling requires".
- Resolution (decision 1 above) recorded in `ROADMAP.md`: Phase 10 "Depends on" line, Milestone C text, and decision-register item 8.
- Supporting evidence: `evidence/2026-09-30-p3-native-preview-gate/README.md` (WebView preview meets every written target; compositor deferred with measured justification).

## Criterion 2 — stale `csp: null` risk

Git evidence (`git log -S'"csp"' -- apps/desktop/src-tauri/tauri.conf.json`, `git show`):

| Commit | Date | `security.csp` |
|---|---|---|
| `72fcdac` | 2026-07-24 | `null` (initial commit) |
| `595fa8f` | 2026-07-25 | restrictive object policy (`default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, IPC + asset protocol only) |

- Since `595fa8f` the production `csp` and a separate `devCsp` (adds `ws:` and `style-src 'unsafe-inline'` for Vite only) are explicit, and `apps/desktop/src-tauri/tests/security_config.rs` asserts the exact generated runtime CSP, the default capability, the Windows media overlay and the managed-path media command surface.
- `ROADMAP.md` Phase 10 risk "Existing `csp: null` remaining in production" is struck through with this date trail; `ROADMAP.md` lines near 55 and 190 already described a restrictive CSP.
- Actual remaining release gaps identified (addressed by later plan steps):
  - prove zero CSP violations at runtime in the **packaged** build (production `style-src 'self'` has no `'unsafe-inline'`) — step 13;
  - no automated check that the installed bundle carries the CSP — step 13;
  - no license inventory for app npm/cargo dependencies — step 11.

## Criterion 3 — release gate (manifests, QC, repair, provenance, formats, installer/security/accessibility)

All in the working tree on top of HEAD `5584cb4` (not committed). Design and user-facing behaviour: `docs/features/delivery.md`.

| Gate item | Implementation | Automated proof |
|---|---|---|
| Immutable render manifest | `video/render_manifest.rs` writes `<output>.manifest.json` atomically before promotion, never overwrites; digests of toolchain, inputs, output; editorial evaluator version + SHA-256; schema in `packages/video-qc/src/manifest.ts` | `qc_export::same_revision_rendered_twice_has_the_same_manifest_except_timestamp_and_bytes`, `manifest_write_failure_leaves_no_output_and_no_manifest`, disk-full failpoint; qc package manifest tests |
| Technical QC | `video/qc.rs`: one FFmpeg pass (black, freeze, silence, clipping, loudness) + caption bounds; stable finding ids shared with TS (golden id `6d198444…0f53` pinned in both) | `qc_detectors_report_exactly_the_expected_finding_per_fixture` (synthetic fixtures from pinned FFmpeg, clean fixture has none); crash / timeout → `qc_unavailable` with no output; cancel during QC → `cancelled` after cleanup |
| Editorial QC | `packages/video-qc/src/editorial.ts` (repetition, beat coverage, must-show / must-not-show), required on every render request and validated natively before encoding | `editorial.test.ts`; native rejection of missing / mismatched / malformed evaluation (`invalid_editorial_evaluation`), including through mock IPC in `lib.rs` |
| Rights QC | Rights gate re-run for the review export and for every Deliver preset; rights findings never overridable | `rights_gate` withdrawn case fails every preset regardless of decisions; `review_record::blocked_until_accepted_and_rights_never_resolve`, `forged_rights_override_lines_are_ignored_on_read` |
| Bounded visible repair | Append-only `<output>.review.jsonl` (`video/review_record.rs`, `packages/video-qc/src/review-record.ts`); 3 attempts per finding; explicit stop; accept-with-reason | append-only bytes, digest mismatch, malformed / foreign line fail closed, attempt limit, stop, forged rights overrides ignored |
| Attribution / provenance | Manifest + existing credits sidecars (`credits.json`, `CREDITS.txt`); Deliver manifests reference the review manifest and accepted decision ids | `delivery_export`: accepted editorial warning carries over — all three preset manifests list the same finding id and reference the decision id |
| Supported output formats | `DELIVERY_PRESETS` 16:9 1920×1080, 9:16 1080×1920, 1:1 1080×1080 (H.264/AAC MP4) + thumbnail, `metadata.json`, SRT/VTT | `delivery_export`: all three presets, blocked source refuses Deliver, new unaccepted blocker → `qc_release_blocked` (no output, no manifest), unaccepted editorial blocker starts no preset |
| Installer | Unsigned MSI with app licenses, FFmpeg notices, source offer, GPL text and pinned toolchain | Installer smoke below |
| Security | Production CSP (since `595fa8f`); Zod JIT probe disabled (`apps/desktop/src/zod-csp.ts`) after the packaged smoke caught an `eval` CSP violation | `tests/security_config.rs` (CSP, capability, bundled license resource); `zod-csp.test.ts`; zero CSP violations in both packaged runs |
| Accessibility | Review and Deliver panels keyboard-operable with labelled controls and live status | `ReviewDeliver.test.tsx` (unit, keyboard, axe), `accessibility.test.tsx` zero violations |
| License inventory | `scripts/license-inventory.mjs` → `apps/desktop/src-tauri/licenses/THIRD_PARTY_LICENSES.md` (npm + cargo, allowlist, fails closed on unknown / denied); CI step | `scripts/tests/license-inventory.test.mjs`; `pnpm licenses:check` exit 0 |
| Crash diagnostics | `crash_report.rs` panic hook writes redacted local reports; `CrashNotice` shows them once on next launch; nothing sent | redaction tests, `CrashNotice.test.tsx`; missing-binary / disk-full / no-network error paths in `qc_export` |

### Packaged runs (Windows, unsigned MSI)

Harness: `scripts/release-smoke/release-smoke.mjs` (admin-extract only, nothing installed; isolated `LOCALAPPDATA`/`APPDATA`).

- **Installer smoke, real identifier** — `installer-smoke/` (log + screenshot). MSI SHA-256 `a6d3abd94ac8289206b33895c0e5d7dae76910a85f1eef9ca2cf4e6b75f01530`, exe `NotSigned`. All 9 bundled resources found; FFmpeg `1326dde4…ec5e` and FFprobe `b49ccc7c…cb07` match the pinned toolchain. CSP delivered as a header, page reloaded with a listener: zero violations.
- **Full Review → Deliver scenario, separate identifier `com.supavideo.producer.releasesmoke`** (so real app data is never touched) — `release-smoke/` (log + 5 screenshots, inspected). MSI SHA-256 `fbdb2f03ba85f1e47c87350f529742a36f217dd5cfd3e8389786adc75b02b48c`.
  - The broken fixture exported with `qcStatus: blocked`: audio clipping, black frames and freeze frames as blockers, silence as a warning (`02-review-findings.png`).
  - Deliver was blocked with 3 unresolved findings (`03-deliver-blocked.png`). A repair was suggested (1/3), then stopped. Four findings were accepted with reasons, which made the export releasable (`04-deliver-ready.png`).
  - All three presets were delivered as H.264 at the right sizes. Each preset manifest carries the same finding ids and references the review manifest (`05-delivered.png`).
  - Zero CSP violations.

## Criterion 4 — consume owning phases

- Dependency triage: P1 dependency phase `89c1da2c` (`evidence/2026-09-06-p1-dependency-triage/`). The new license inventory adds coverage; it does not re-triage advisories.
- Native/performance evidence: P2 phase `8cdf067c` (`evidence/p2-native-performance/`) and the native preview gate `d665936f` (`evidence/2026-09-30-p3-native-preview-gate/README.md`).
- Rights: phase `0ab8342f` (`evidence/phase-7/`); first cut `737fc6a1` (`evidence/2026-09-30-p3-first-cut/`), whose plan data feeds the editorial checks.
- Public distribution: still owned by phase `297929a2` (not started). Nothing here claims legal approval, signing or public release.

## Final checks (1 Oct 2026, working tree on HEAD `5584cb4`)

Run one at a time on an idle machine. Execution IDs are the agent's foreground/background run IDs.

| Check | Execution | Result |
|---|---|---|
| `cargo test --features tauri-ipc-test` | `29d8ba7b-2518-4ff0-8d63-865d98331442` | exit 0 — 671 + 6 passed, 0 failed, 26 ignored |
| `cargo clippy --all-targets --all-features -- -D warnings`, `cargo fmt --check` | `83d7e099-d70c-40fd-a37b-ca1f1b17b0b3` | both exit 0 |
| `pnpm test` | `f4c581e6-d2c9-49d0-83bf-c62e240ddcb2` | exit 0 — contracts 330, rights 109, render 92, media 48, project 217, produce 92, qc 53, desktop 532 (1,473) |
| `pnpm --filter @supa-video/desktop test:browser` | `7c5e2de4-c584-49f8-b0b7-0d9512a52e93` | exit 0 — 122 passed |
| `pnpm lint`, `pnpm check`, `pnpm licenses:check` | `ce3c3ae7-fa88-498b-9c04-a70af87a8498` | all exit 0 |
| `pnpm format:check` | `f7a47974-7ccf-4ee4-8e23-8ce03a1810b1` | exit 0 (after formatting `docs/features/delivery.md`) |

Earlier failed runs are kept here, not hidden:

- The first full `cargo test` failed 4 (then 12 in `--lib`) at the copy of the 200 MB bundled FFmpeg into `%TEMP%`, because drive C: had 1.3 GB free. It passed once space was freed.
- One vitest run made in parallel with `cargo test` timed out 3 tests (`accessibility.test.tsx` ×2, `JobCenter.test.tsx` ×1). They passed alone, and the full suite passed alone with no unhandled rejections.
- The first browser run failed 122/122 to launch because the Playwright Chromium binary was missing. The pinned 1.62.0 browser was reinstalled, after which all 122 passed.

## Known limits (not fixed)

- Private, unsigned Windows MSI only. No NSIS, no macOS/Linux, no signing, no public distribution (phase `297929a2`).
- The packaged scenario recorded a repair attempt and an explicit stop. It did not apply the repair and then undo it in the packaged app. Repair apply and undo go through the existing proposal flow and are covered by the agent-proposals evidence and unit tests.
- Automatic repair suggestions exist only for silence findings. Other kinds are fixed by hand or accepted.
- QC thresholds are fixed defaults and not yet user-tunable.
- Under parallel machine load, timing-sensitive vitest and scheduler tests can time out. Their timeouts were not raised. The intermittent Windows supervisor timeout and the old host acceptance linkage are still not claimed fixed.
- A stuck "prepare media asset" job was seen once, only with the real identifier's pre-existing 1.7 GB cache (over its 549 MB budget). Its cause was not found.
- Hosted CI has not been run on these changes.

## Non-goals recorded

Updater, C2PA signing and public distribution are listed under Phase 10 "Non-goals" in `ROADMAP.md`, and in `docs/features/delivery.md`.
