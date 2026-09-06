# P1 dependency and secret-scan evidence — 6 September 2026

Status: **implementation finished; phase verification remains in progress because Linux regression checks did not pass.** Scanner severity is not demonstrated application exploit severity.

## Final policy and verification (steps 4–7)

- [Every Rust warning's target, parent chain, role, function evidence and disposition](rust-dispositions.md) is recorded with owner, deadline and reopening conditions. Complete unfiltered JSON is in [rust-audit.json](rust-audit.json). Sixteen maintenance-only exceptions and one separately justified GLib function exception expire 2026-10-06. No Rust dependency/source, signing trust, platform support or historical ROADMAP claim changed.
- Final direct `pnpm audit --json`: exit 0, empty stderr, zero findings. Final direct `cargo audit --file apps/desktop/src-tauri/Cargo.lock --json --deny warnings`: exit 1, empty stderr, zero vulnerabilities and the same 17 warnings. Both policy gates pass; the Rust scanner's original findings status and every warning remain visible, not rewritten to a clean scan.
- `node --test scripts/tests/check-dependency-policy.test.mjs`: 33 passed, covering strict shapes, exact exceptions, malformed/empty output, expiry/staleness, vulnerabilities, tool errors, both ecosystems and actual CLI exits. `node scripts/tests/gitleaks-smoke.mjs <verified-binary>` passes benign detection, redaction, exact-value/path exceptions and scanner-error tests without logging fixture contents.
- Reviewed full-history direct scan and `node scripts/check-secrets.mjs <verified-binary> .cache/p1-security/history.git`: 144 commits, zero remaining candidates, exit 0. Initial five nonsecret candidates are fully documented below. Gitleaks itself returned zero on an invalid Git directory during smoke testing; the new gate rejects missing/shallow/empty history, malformed reports and error-only logs in addition to nonzero exits. No broad ignore or secret baseline added.
- Pinned/checksum-verified actionlint 1.7.12 accepts the changed workflow. Existing action pins/read-only permission/release controls remain; `windows-release.needs` now includes the independent security gate. Security checks still execute after other gate failures. Network requirements and exact commands are documented in [security policy](../../security/README.md).
- Windows locked all-feature Rust tests and all-target/all-feature Clippy pass. Linux WSL Ubuntu-22.04, Rust 1.97.1, GTK 3.24.33/WebKit2GTK 2.50.2: all-target/all-feature Clippy passes; Cargo test attempts time out. Direct execution of the compiled all-feature test binary also times out after failures in existing scheduler, durable-acknowledgement and publication-race tests. Cancellation passes in an isolated rerun. Serial execution still fails scheduler cases and times out. **No full Linux test pass, no established historical baseline, and no hosted CI pass claimed.** Tests/thresholds were not edited or skipped. These failures are outside the changed Rust code (there is no Rust code/lock diff) and need separate investigation, not suppression in this phase.

Criterion trace: JavaScript exposure/remediation → step 3 below and frozen install/build/check/test/lint/browser commands; Rust inventory/reachability → rust-dispositions.md, 34 target trees, graph-wide source/generated/link evidence and direct final audit; secret coverage/policy → initial and reviewed 144-commit scans, policy tests, scanner smoke tests and actionlint. Final audit/policy-test execution: `3ffbca3b-4564-4566-9a2c-96a35f05b622`; secret gate/smoke: `a4c1fd9d-099e-440b-9ebe-0115b6a462c3`; Linux Clippy: `547d17d6-67e9-427c-ad86-3e67651a1d4a`; failing Linux serial regression: `89295699-ac5f-4fac-a19b-d9dffad6f761`. These references document results, not phase completion.

## JavaScript remediation (step 3)

| Advisory (upstream severity) | Function/input and exposure                                                                                                                                                                                                                                                                                                                                                                                                                                      | Remediation                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| GHSA-rgw5-rvv9-x895 (high)   | ESLint/config-array/typescript-estree → minimatch 10.2.5 → brace-expansion 5.0.8. Minimatch `src/index.ts:328–341,480,1242` expands glob patterns; ESLint `lib/eslint/eslint-helpers.js:210,290` constructs Minimatch from lint patterns. Repository-owned `eslint.config.js:6,11` defines fixed glob strings. Hostile repository/config/CLI patterns can reach expansion in development/CI; ordinary selected project/media bytes do not enter this build tool. | Compatible 5.0.9; parent permits ^5.0.5.   |
| GHSA-2v37-7h3g-55p8 (high)   | Desktop Vite 8.1.5 / plugin-react and workspace Vitest → PostCSS 8.5.23 → nanoid 3.3.16. Vite `src/node/plugins/css.ts:1733–1736` processes repository CSS. PostCSS `lib/input.js:3,80` uses `nanoid/non-secure` with constant size 6, not advisory sinks customAlphabet/customRandom with zero size. Hostile CSS does not control this size or select those generators. No identified source-to-affected-sink path in this graph.                               | Compatible 3.3.18; parent permits ^3.3.16. |

CODE: opensrc resolved exact installed minimatch/PostCSS/Vite versions; app and workspace TS/TSX import search found no affected tooling APIs. RUNTIME: diagnostic Vite sourcemap build lists 144 sources in one map, none from ESLint/minimatch/brace-expansion/PostCSS/nanoid. DEDUCED: neither affected package is shipped in this observed frontend bundle; packaging other than this build is not thereby proven. No demonstrated shipped-app exploit.

RUNTIME: registry metadata confirms both patch releases and integrity digests. Only eight lockfile lines changed (two packages, snapshots and dependency links); no manifests, majors, overrides or direct dependencies changed. `pnpm install --frozen-lockfile`, direct `pnpm audit --json` (zero reported findings), `pnpm build`, `pnpm check`, `pnpm test`, `pnpm lint` all returned 0. First combined command timed out during tests; separate rerun with fresh log passed. Browser tooling initially lacked Chromium; installed the locked Playwright browser, reran `pnpm --dir apps/desktop test:browser`: 46 passed, exit 0. Existing jsdom canvas notices remain nonfatal. Full fresh logs are private under `.cache/p1-security/`.

## Full-history scan (step 2)

RUNTIME: Gitleaks 8.30.1 installed from the official release; Windows x64 archive SHA-256 verified as `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`. Linux x64 published SHA-256 for CI: `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`.

An isolated local mirror fetched available origin branches/tags without changing user refs. The mirror initially omitted four detached-worktree commits; importing the two missing worktree tips restored all 144 reachable commits. Scanned refs include main, origin/main, origin/HEAD, notes/commits, upstream/main and isolated scan refs for controller/nemo-recovery. Exact refs are saved locally in `.cache/p1-security/history-refs.txt`. Both source and mirror are non-shallow. Unreachable/deleted remote objects, other repositories, working-tree files, binary archive contents are not covered. Built-in rules retain their upstream defaults; no project exclusions, baseline, inherited config or inline suppression was used. Explicit empty ignore file and default-only config were supplied. CLI default decode depth is 5, archive depth 0, no size cap.

Command: `.cache/p1-security/gitleaks/gitleaks.exe git .cache/p1-security/history.git --log-opts="--all" --redact=100 --ignore-gitleaks-allow --config .cache/p1-security/default-gitleaks.toml --gitleaks-ignore-path .cache/p1-security/empty.gitleaksignore --report-format=json --report-path .cache/p1-security/history-findings.json`.

RUNTIME: 144 commits / 5.80 MB scanned, exit 1, five generic-api-key candidates. All five are nonsecret deterministic artifact identity test vectors, not credentials. Historical lines equal current fixture lines; the identity/transcript/caption fixture tests passed (23 tests). No credential was tested and no history rewritten. The original redacted report remains private and ignored. Narrow reviewed nonsecret exceptions are now recorded in the CI config, not blanket fixture exclusions.

| Historical location                                                                                         | Disposition                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `0cfae1d5f03f453fc1295cf71a6b9054c43a877b:packages/video-media/fixtures/caption-artifact-v1.json:23,87,114` | Repeated synthetic transcript artifact identity, fixture schema and caption tests; nonsecret |
| `4a4053cd6e8e4b4f2ebd8d6bdebbc4ab1e4b03e5:packages/video-media/fixtures/transcript-artifact-v1.json:142`    | Deterministic transcript identity reproduced by transcript tests; nonsecret                  |
| `19c747d9c91bb68dd6188fab27e5775a43121450:packages/video-media/fixtures/identity-v1.json:72`                | Deterministic media identity reproduced by identity tests; nonsecret                         |

## Initial direct scans (step 1)

RUNTIME: initial worktree clean; repository not shallow; 144 commits reachable from local refs. Remote completeness and secret coverage not yet established.

Tools: Node 22.20.0, pnpm 10.34.5, Cargo 1.97.1, cargo-audit 0.22.2. Gitleaks initially absent (installation pending, not an external blocker).

- `pnpm audit --json`: exit 1, two high advisories, brace-expansion 5.0.8 (GHSA-rgw5-rvv9-x895) and nanoid 3.3.16 (GHSA-2v37-7h3g-55p8). Raw output: local ignored `.cache/p1-security/js-before.json`.
- `pnpm why -r brace-expansion`: minimatch 10.2.5 via ESLint 10.7.0, @eslint/config-array 0.23.5 and @typescript-eslint/typescript-estree 8.65.0; root dev tooling. Full graph: local `.cache/p1-security/brace-paths.txt`.
- `pnpm why -r nanoid`: PostCSS 8.5.23 via Vite 8.1.5, desktop dev dependency, @vitejs/plugin-react 6.0.4 and Vitest 4.1.10 / @vitest/mocker 4.1.10 across workspaces. Full graph: local `.cache/p1-security/nanoid-paths.txt`.
- `cargo audit --file apps/desktop/src-tauri/Cargo.lock --json`: first attempt returned 0 despite a yanked-registry timeout on stderr. This attempt is NOT complete coverage. Retry returned 0 with empty stderr, zero vulnerabilities and 17 warnings (16 unmaintained, one unsound). Raw retry: local `.cache/p1-security/rust-before.json`. Advisory database revision from scanner JSON: `5a0ebedfe8bdd2e295b171f4162f8c977bcad9a5` (1,239 advisories, last updated 2026-09-02). The separately queried default cargo directory was not this scanner's database; its revision is not scan evidence.

The fresh count matches the historical 17; original historical raw output is unavailable, so identity-level changes cannot be asserted. At step 1, target/function dispositions were pending and no exceptions were approved; the completed inventory and subsequent evidence-based dispositions are linked above.

| Kind         | Advisory          | Crate/version            |
| ------------ | ----------------- | ------------------------ |
| unmaintained | RUSTSEC-2024-0413 | atk 0.18.2               |
| unmaintained | RUSTSEC-2024-0416 | atk-sys 0.18.2           |
| unmaintained | RUSTSEC-2024-0412 | gdk 0.18.2               |
| unmaintained | RUSTSEC-2024-0418 | gdk-sys 0.18.2           |
| unmaintained | RUSTSEC-2024-0411 | gdkwayland-sys 0.18.2    |
| unmaintained | RUSTSEC-2024-0417 | gdkx11 0.18.2            |
| unmaintained | RUSTSEC-2024-0414 | gdkx11-sys 0.18.2        |
| unmaintained | RUSTSEC-2024-0415 | gtk 0.18.2               |
| unmaintained | RUSTSEC-2024-0420 | gtk-sys 0.18.2           |
| unmaintained | RUSTSEC-2024-0419 | gtk3-macros 0.18.2       |
| unmaintained | RUSTSEC-2024-0370 | proc-macro-error 1.0.4   |
| unmaintained | RUSTSEC-2025-0081 | unic-char-property 0.9.0 |
| unmaintained | RUSTSEC-2025-0075 | unic-char-range 0.9.0    |
| unmaintained | RUSTSEC-2025-0080 | unic-common 0.9.0        |
| unmaintained | RUSTSEC-2025-0100 | unic-ucd-ident 0.9.0     |
| unmaintained | RUSTSEC-2025-0098 | unic-ucd-version 0.9.0   |
| unsound      | RUSTSEC-2024-0429 | glib 0.18.5              |

CODE reference pattern: 66HEX/frame `tooling/xtask/src/main.rs:1955–2009`, revision eefde7a4b5424f11ef393a53fa72e7dfae3e693f, for pinned scanners and checksum verification. Its category suppression and unrelated exceptions are not adopted.
