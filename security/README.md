# Dependency and secret policy

The separate CI `security` job runs on push, pull request and published release. Windows release packaging depends on it alongside existing TypeScript/Rust/Windows checks. It uses read-only contents permission, no release secrets, full-history checkout and no persisted checkout credentials. Signing trust, legal approval and platform support are unchanged.

**Current inventory: sixteen exact maintenance deferrals and one separately evidenced-unreachable GLib function deferral, expiring 2026-10-06.** GLib was initially left failing; graph-wide source, Linux generated code and linked-binary evidence later justified the bounded function disposition. Linux regression failures remain separate incomplete verification; they are not suppressed by the security gate. [Current evidence and limits](../evidence/2026-09-06-p1-dependency-triage/README.md) and [all Rust dispositions](../evidence/2026-09-06-p1-dependency-triage/rust-dispositions.md) distinguish scanner findings from demonstrated shipped exploits. A locally tested workflow is not a hosted CI pass.

## Gates

- JavaScript: scan the whole lockfile, including development dependencies, with no production-only filter. High/critical fail; lower ratings remain visible. Scanner status, schema, counts, stderr and operational errors are checked, not just severity.
- Rust: unfiltered vulnerability, unsound, unmaintained, notice and yanked coverage. `cargo-audit 0.22.2 --deny warnings` preserves all results and returns a findings status even for informational warnings. `--deny notice` is not a supported flag in this version. Vulnerabilities, unknown/unreviewed warnings, malformed output, scanner failures, stderr (including registry timeouts), filters and expired/stale exceptions fail. Exit zero alone is not clean coverage.
- Exceptions: only `unmaintained`, `unsound` and `notice` kinds are approvable. Yanked findings remain scanned, visible and gate-failing; yanked exceptions are explicitly unsupported until a separate keyed yanked-review contract is required. Remove such exceptions and replace the yanked dependency. `dependency-exceptions.json` matches advisory, crate, exact version, kind and complete Windows x86_64/Linux x86_64 inventory scope. Every entry requires rationale, a repository-contained evidence file, dependency/security maintainer ownership and expiry. Review before 2026-10-06 and on graph, feature, target or advisory changes; remove stale entries rather than retaining permanent ignores. Maintenance-only deferrals cannot cover unsoundness. No entire warning category is suppressed. A future target-inapplicable or evidenced-unreachable exception needs actual evidence for every declared target, never a host-only assumption.
- Secrets: Gitleaks 8.30.1, checksum-verified before extraction, scans all reachable history with 100% redaction and inline suppression ignored. No baseline or inherited ignore/config files. Three exact path AND full-line AND rule-specific nonsecret fixture exceptions are reviewed in `gitleaks.toml`; no whole fixture, rule or commit exclusions. Built-in upstream default rules/allowlists still apply. The optional leading newline in exact-line patterns matches Gitleaks 8.30.1's line extraction (`detect/location.go:45,54`), not arbitrary content.

Audit jobs need network access to registries, the advisory database and scanner releases, separately from offline application tests. Do not use stale/offline audit flags to get a passing gate. Scanner scratch/output stays in ignored `.cache/p1-security/`; do not publish secret reports, even redacted ones, by default. CI preserves scanner exits separately before policy evaluation; collectors returning zero do not make a scan pass. Every gate still runs after other gate failures unless cancelled.

## Exact local commands

Use pnpm 10.34.5 and Node >=22.12. From repository root, Bash. Paste each complete block as a standalone command (not inside `if`, `&&` or `||`, which disable Bash errexit). Subshells keep shell modes and PATH changes local:

```bash
(
set -euo pipefail
mkdir -p .cache/p1-security/bin
cargo install cargo-audit --version 0.22.2 --locked --root "$PWD/.cache/p1-security"
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  --output .cache/p1-security/gitleaks.tar.gz
echo '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  .cache/p1-security/gitleaks.tar.gz' | sha256sum --check --strict
tar -xzf .cache/p1-security/gitleaks.tar.gz -C .cache/p1-security/bin gitleaks
export PATH="$PWD/.cache/p1-security/bin:$PATH"
cargo audit --version
gitleaks version
node --test scripts/tests/check-dependency-policy.test.mjs scripts/tests/local-security-recipes.test.mjs
)
```

On Windows use the same release's `gitleaks_8.30.1_windows_x64.zip`, verify SHA-256 `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e` before extraction, and run its `gitleaks.exe`. Never download `latest`, pipe downloads into a shell or execute unverified archives.

Capture direct audits without losing their statuses (run each gate even if the other fails):

```bash
(
set -euo pipefail
export PATH="$PWD/.cache/p1-security/bin:$PATH"
mkdir -p .cache/p1-security
javascript_status=0
pnpm audit --json > .cache/p1-security/javascript.json 2> .cache/p1-security/javascript.stderr || javascript_status=$?
printf '%s\n' "$javascript_status" > .cache/p1-security/javascript.exit
rust_status=0
cargo audit --file apps/desktop/src-tauri/Cargo.lock --json --deny warnings > .cache/p1-security/rust.json 2> .cache/p1-security/rust.stderr || rust_status=$?
printf '%s\n' "$rust_status" > .cache/p1-security/rust.exit
failed=0
node scripts/check-dependency-policy.mjs javascript .cache/p1-security/javascript.json .cache/p1-security/javascript.exit .cache/p1-security/javascript.stderr || failed=1
node scripts/check-dependency-policy.mjs rust .cache/p1-security/rust.json .cache/p1-security/rust.exit .cache/p1-security/rust.stderr security/dependency-exceptions.json x86_64-pc-windows-msvc,x86_64-unknown-linux-gnu || failed=1
exit "$failed"
)
```

Run the CI-equivalent secret gate after establishing coverage. It rejects missing/shallow/empty Git history before scanning, then checks exit status, report shape/count and error-only logs. Gitleaks 8.30.1 can return zero for missing Git history; its raw exit alone is insufficient. Reports and logs are preserved in a unique private scratch directory, never echoed.

```bash
(
set -euo pipefail
failed=0
node scripts/tests/gitleaks-smoke.mjs .cache/p1-security/bin/gitleaks || failed=1
# For an isolated scan mirror, append .cache/p1-security/history.git to this command before ||:
node scripts/check-secrets.mjs .cache/p1-security/bin/gitleaks || failed=1
exit "$failed"
)
```

Merge resolutions are scanned as separate ordinary patches against each parent (`--all --full-history --diff-merges=separate`). Git otherwise omits merge patches. The smoke test exercises the production CLI with isolated clean merge history and a synthetic value present only in a merge result, then deleted; detection must fail the gate with a redacted merge finding. This format is verified against Gitleaks 8.30.1's patch parser.

For a direct investigative scan (not a substitute for the error-checking gate):

```bash
git rev-parse --is-shallow-repository  # must be false
git for-each-ref --format='%(refname) %(objectname)'
git rev-list --all --count
: > .cache/p1-security/empty.gitleaksignore
.cache/p1-security/bin/gitleaks git . --log-opts="--all --full-history --diff-merges=separate" --redact=100 --ignore-gitleaks-allow \
  --config security/gitleaks.toml --gitleaks-ignore-path .cache/p1-security/empty.gitleaksignore \
  --report-format=json --report-path .cache/p1-security/secrets.json
```

Full history means all available fetched branches/tags plus local refs and detached-worktree tips, not merely `--is-shallow=false`. CI checkout fetches full available branch/tag history at the event. Locally prefer an isolated `git clone --mirror --no-hardlinks . <ignored-directory>` and fetch origin heads/tags into isolated namespaces; import detached-worktree tips if the mirror's reachable commit set differs. Record exact refs, counts, scanner version, exclusions and scan status. Never rewrite the user's refs/worktree or Git history. Deleted/unreachable remote objects, uncommitted files, other repositories and binary/archive content excluded by scanner defaults are not established coverage. Check CLI help on version changes; this release's observed decode depth is 5 and archive depth 0.

For an initial investigative scan, use an explicit config containing only `[extend]` / `useDefault = true` with the empty ignore file. This bypasses project exceptions as well as inline suppressions; triage candidates before adding any exception. Missing scanner binaries are an installation task, not proof of absent secrets or an external blocker.

## Reachability review boundary

`target-inapplicable` and `evidenced-unreachable` entries require a version-1 `reviewContext` with both actual Windows/Linux target triples and a SHA-256 fingerprint. The gate independently computes it before approving any matching warning; missing context, changed inputs or mismatched invocation targets fail with `review-required`. Maintenance-only deferrals remain separate, with the same identities, ownership and deadlines. Scanning never writes or renews an approval.

The conservative boundary hashes sorted paths and file contents for **all tracked and nonignored untracked repository files**, except `security/dependency-exceptions.json` (to avoid a self-referential hash). It includes Cargo.lock, all manifests/features, application consumers, build scripts, checked-in generated code, generator inputs, target/build definitions in CI and referenced evidence contents. Additions, removals and renames invalidate too. The evidence path and explicit target scope are included in the digest. Required lockfile, manifest, CI and evidence paths must exist; symlinks, submodules and unreadable inputs fail closed. Git is required. UTF-8 text without NUL bytes normalizes CRLF to LF (including older Windows checkouts); binary bytes remain exact.

This intentionally reopens review even for unrelated repository edits. Ignored build outputs, local Cargo registry caches and machine-specific environment are not fingerprinted: regenerate/review generated-code and linked-binary evidence when those change; do not treat this source-context check as a reproducible-build attestation. Build inputs must be repository-contained and tracked, not hidden in ignored files or external path dependencies. Changing toolchains or external generation must renew the evidence, which invalidates the same fingerprint boundary.

### Hosted GLib capture: evidence, not a disposition

The Linux Rust job pins Rust **1.98.1**, compiler commit prefix `48a229cea`, host `x86_64-unknown-linux-gnu`. It retains registry caching but refuses prior target build payload. Preflight requires Node >=22.12 and `file`, `readelf`, `nm`, `tar`, `sha256sum`; it installs nothing. Unsupported Cargo configuration, target/profile/flags/compiler-wrapper overrides, missing tools or changed tracked inputs stop collection. Only explicitly allowlisted build configuration and run identity are recorded, not the runner environment or credentials.

The existing locked all-feature tests keep visible test output while recording Cargo JSON stdout and both Cargo/tee exits. A successful build message alone is insufficient: failed tests or failed logging prevent capture. Collection follows the release-budget tests and can preserve valid debug evidence even when those release tests fail; that failure still fails the job. Cancellation prevents collection/upload. The unchanged 30-minute timeout can leave cold compilation incomplete; do not extend it or describe partial outputs as complete evidence.

The artifact `hosted-glib-<event SHA>-<run ID>-<attempt>` has 30-day retention, no overwrite, and contains only `hosted-glib.tar` and its SHA-256 sidecar. Upload failure fails the job. GitHub's **outer artifact digest** and the **inner tar digest** are distinct. Scratch stays ignored under `.cache/p1-security/hosted-glib/`; the target directory, Cargo registry, environment, user media and scanner/secret reports are not archived wholesale.

The payload includes provenance, locked all-feature Linux-filtered Cargo metadata, stdout and exit receipts, tracked source hashes/tree/checkout identity and before/after Git status, generated-source inventories and files, exactly one Cargo-selected unstripped **all-feature debug library test ELF**, ELF inspections/build ID, full `nm -C` output, producer/type search file/line references, and a deterministic path/size/SHA-256 manifest. The manifest excludes only its own hash; the tar digest covers it. Copies are checked against their source bytes before packaging and the payload is checked again afterward. Inspection never executes the ELF. This is not the production/release binary.

Reported build-script output directories are reconciled with an independent debug-build Rust inventory. Additional same-job debug sources and repository-generated untracked Rust outside target are labeled separately. Target-cache disabling establishes **same-job**, not necessarily **same-step**, generation: Clippy can generate outputs that tests reuse; Cargo `fresh: true` and cached build-script messages are recorded rather than relabeled fresh. Missing directories, empty generated inventories, path escapes, symlinks and nonregular payload entries fail closed. Proc-macro expansions not materialized as files are not claimed as coverage. The historical count of 14 is not an invariant: explain every count difference during review.

Before any separately authorized fingerprint review:

1. Independently retrieve hosted run/job metadata and artifact metadata using the **exact run ID, attempt and artifact ID**, never latest/name alone. Match repository, actual checkout SHA, event SHA/ref, workflow SHA/ref, runner image, toolchain and successful all-feature test step. For a PR, reconcile the merge checkout with the recorded PR head/base/merge values; do not call the PR head the tested checkout. Record release-budget and overall job failures separately. Missing/expired artifacts or unavailable access stop review.
2. On Windows, verify the downloaded outer artifact bytes against GitHub's reported SHA-256, then verify the inner tar against its sidecar. Before extraction, inspect both archive layers: reject missing/additional/duplicate entries, absolute paths, traversal, symlinks, hardlinks, devices and other nonregular entries; allow only the expected container directories. Normalize leading `./` in the tar once and reject duplicate normalized names. Extract into a new isolated directory without executing Linux code, then verify every manifest path, size and SHA-256, rejecting missing/additional files and duplicate manifest paths. The manifest's own bytes are protected by the verified tar hash. Hash verification alone does not establish trusted compilation.
3. Reconcile every build-script message with the directory mappings and source inventories, including empty reported directories and labeled extras. Require nonempty generated sources, exact package/target/profile/features/executable identity, successful inspection commands, a usable full symbol report and matching GNU build ID. Successful upload or matching hashes alone do not prove completeness.
4. Read the actual generated files for `Variant::array_iter_str` and `VariantStrIter` construction/use, compare the full demangled symbol report, and investigate every hit. Reconcile the locked dependency/source graph and Windows GLib absence separately. Symbol no-match is corroboration only, **never standalone unreachability proof**, including against inlining.
5. Keep reporting **`review-required`** until a separately authorized review updates dispositions and deliberately calculates a new fingerprint after formatting all final inputs. Capture itself changes fingerprint inputs. It does not renew either exception, change either target/owner, or extend any **2026-10-06** deadline. Hashes/run linkage are integrity and provenance evidence, not a signed reproducible-build attestation.

Local verification uses Windows fixture tests only; the first separately authorized hosted run must validate real Cargo output, source counts and ELF inspections. Implementation approval does not authorize push, dispatch, installs, local Linux execution or fingerprint renewal.

Deliberate renewal: review the changed graph, consumers, generators and both target scopes; update the referenced disposition evidence and retain its limits/deadline. Finish all input edits, then print a candidate digest (read-only):

```bash
node --input-type=module -e 'import {reviewFingerprint,TARGETS} from "./scripts/check-dependency-policy.mjs"; console.log(reviewFingerprint(process.cwd(), TARGETS, "evidence/2026-09-06-p1-dependency-triage/rust-dispositions.md"));'
```

Only after review, copy that digest into the affected entry's `reviewContext.sha256`, retaining `version: 1` and the reviewed `targets`. Review evidence and fingerprint together in the same change; never add automatic refresh to CI or scanner collection. Re-run the Node tests and freshly collected Rust gate above. No fingerprint makes a reachable function safe or extends expiry.

## A discovered secret

Stop release work, contain access and notify the credential owner. Revoke/rotate through the owner before other hardening; assume historical exposure matters. Never test the credential. Record only file/line/commit and remediation status, not the value or raw report. A redacted detection still needs human validation; lack of scan coverage is not a discovered secret. Do not erase history automatically. Add only a specific evidenced nonsecret exception after review—never a broad ignore or baseline to make a gate green.
