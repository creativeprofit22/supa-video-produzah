# P1 — cache lifetime and caption boundaries

Date: 2026-09-08. Base revision: `80a2cfead567c78b9f757297f2af7c940675f68b`.
The worktree was clean before implementation. Changes remain uncommitted.
Scope: A1/A2 only; no cache production change, dependency, schema, public API,
mixed-rate validation, trust-policy, or historical ROADMAP change.

## Criterion outcomes

| Criterion | Current evidence |
| --- | --- |
| A1 cache lifetime | PASS: existing deterministic races plus test-only unsafe sensitivity controls; current production defect not reproduced. |
| A2 compiler/native parity | PASS: both helpers emit `gte(t\,START)*lt(t\,END)`; V1/V2 exact argv validation agrees. |
| A2 actual caption frames | PASS on the verified local FFmpeg 9.0.1 / Arial setup: ten V1/V2 rate/endpoint cases, 60 inspected frames, old-expression and deliberate-overlap negative controls. |

Initial verification was incomplete. Initial in-progress reports were rejected by the
host tool schema (`blocker`/`required_external_action`: expected never, received
null). After fresh criterion-specific checks, the concrete external FFmpeg/font
dependency was successfully reported as blocked via `roadmap_status`, revision
129, with failed verification and three unique execution bindings:

| Criterion ID | Bash execution ID | Outcome |
| --- | --- | --- |
| `c821cdffb1ec034c8068f61801b1067c3e1ee9c3f17c13c717a98ec97046e831` | `ac7f60ed-21dd-498e-930f-c59b0933a112` | 11 race tests passed |
| `f15401a3197bb404a071395c0b3796a7891be28e65b7fdf31d14d3084a5dc2c3` | `211818e2-dad6-4a73-a03e-814454791950` | 26 compiler and 3 native caption tests passed |
| `6f891087204fab213bfc5dfd1b20adb9ac05c7dee11d873457ccf42ba64eefa5` | `da6ea627-8bad-4a13-b128-afac28610f80` | Explicit post-format frame test failed at font initialization |

These were respectively the same `race_`, combined TypeScript/native caption,
and explicit opt-in commands documented below, executed separately on unchanged
code at 16:28–16:29Z. A recorded failed execution binding is not passing proof.
The user subsequently authorized local FFmpeg/font repair, including replacement.
The external rendering blocker was resolved; the old failed executions above are
historical, not the current real-frame result. Full matrix execution
`f23cd216-3ae6-4858-ab20-c7b427df4e94` passed explicitly on the repaired environment.
Fresh post-format criterion executions are submitted separately through
`roadmap_status`; a successful command is not by itself host acceptance or settlement.

## A1 schedules and sensitivity

Before edits, `cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml race_`
passed all 10 existing tests. This is fresh regression-prevention evidence, not a
reproduction of a present production race or a rewrite of historical evidence.

Existing tests retained:

- `race_publication_handoff_preserves_returned_lease_and_bytes`: acknowledged
  publication upsert barrier plus acknowledged eviction attempt, for transcript,
  source, proxy, thumbnail; includes fresh and reserved reuse. Exact bytes and
  `(catalog, lease) = (1, 1)` remain; release enables zero-budget eviction.
- `race_final_eligibility_check_must_not_return_a_dangling_lease`: acknowledged
  final eligibility barrier holds the artifact lock and SQLite writer reservation;
  competing lease attempt cannot return a handle after deletion. All four kinds.
- `reserved_lease_wins_and_invalid_content_never_leases`: reservation followed by
  lease before deletion preserves bytes; invalid/missing content cannot lease.
- Actual caller races: `race_actual_transcript_publication_fresh_and_reserved_reuse`
  and `race_actual_prepared_publication_and_completed_reuse` cover transcript and
  source/proxy/thumbnail publication and reuse through real preparation paths.

New `race_unsafe_baselines_expose_split_handoff_and_stale_selection` executes two
explicitly unsafe, test-only controls for each of the four kinds (eight schedules):

1. Split handoff: register, acknowledge pause before lease, evict, resume lease.
   File disappears, catalog/leases are `(0, 0)`, and acquisition rejects the lost
   publication. The current lease primitive still fails closed.
2. Stale selection: reserve, acknowledge pause, acquire a real lease, resume a
   deliberately unchecked unlink. File disappears despite `(1, 1)`, proving that
   the byte/lease assertions detect the unsafe stale-deletion schedule.

These are sensitivity controls, not an isolated historical binary reproduction.
They use existing channel gates and RAII worker joins, not timing sleeps. There is
no unsafe production switch. Caller inspection retained artifact-lock-before-writer
ordering and guard ownership through combined registration/lease commit, including
source guarded ingest and derived completed reuse before reads/probes.

The cache suite also passed containment, invalid/missing bytes, LRU tie ordering,
transaction rollback, stale cleanup, and failed-unlink reconciliation tests.

Grounding: corpus search and show of `kunobi-ninja/kache`, `src/daemon_local.rs`,
`run_pin_batch` lines 260–295 corroborated SQLite IMMEDIATE plus final existence
recheck. The local explicit lease/lock protocol is stronger than its idle-grace
pin policy, which was not copied.

## A2 compiler and validator

Failing TypeScript adjacent-cue expectations and native exact-argv tests were run
before modifying either production helper. Failures showed the old inclusive
expression rather than the expected exclusive end. The production diff changes
only the two shared enable expressions. Six-decimal formatting, text escaping,
metadata checks, graph order, and exact argv rejection remain intact.

TypeScript covers V1 adaptation from a caption-capable V2 revision and V2 output,
zero start, integer/fractional adjacent endpoints, empty and hidden tracks, and
existing hostile-text escaping. Native validation rejects old `between`, changed
start/end values, constant enable, removed caption filters and metadata mismatch.
An additional non-ignored test validates no-caption, outgoing, incoming and
adjacent V1/V2 fixture graphs at every rate/endpoint in the matrix below.

FFmpeg's expression documentation defines `between` as inclusive and `gte`/`lt`
as the required half-open interval. Reference:
<https://ffmpeg.org/ffmpeg-utils.html#Expression-Evaluation>.

## Real-frame test design and measured results

`render_caption_boundary_local_ffmpeg_v1_v2` is opt-in and was explicitly executed
with `--ignored --nocapture`; its being ignored in the normal suite is NOT proof.
It verifies local programs, probes default drawtext/font support, generates a
solid 640x360 source, then uses native grants, exact validated plans and supervised
workers for positive renders. It includes no-caption, long outgoing-only,
short incoming-only, and adjacent-cue outputs. Two negative controls use the old
inclusive expression: original adjacent endpoints, and deliberately overlapping
full-time cues. Both must fail native validation and execute only as test-generated
argv against disposable paths, never through an unsafe production option. Six
outputs per case give 60 renders, of which 40 follow the validated supervised path.

| Rate | Shared boundary (microseconds) | Final end (microseconds) | Alignment |
| --- | ---: | ---: | --- |
| 30/1 | 1000000 | 2000000 | exact |
| 30000/1001 | 1001000 | 2002000 | exact |
| 30000/1001 | 1034367 | 2035367 | rounded up from frame time |
| 24000/1001 | 1001000 | 2002000 | exact |
| 24000/1001 | 1042708 | 2085417 | rounded shared/final endpoints |

Both V1/V2 are specified for every row. Output inspection is bounded to 100
frames, a 640x100 bottom luma crop (6.4 MB maximum per decode), and FFprobe frame
PTS plus stream time base. Expected cue selection uses integer arithmetic against
the actual output PTS and the half-open microsecond interval, not floating
approximate equality. It inspects the preceding, first at/after, and following
frames at shared and final endpoints. A fixed mean absolute error tolerance of
2 gray levels accommodates H.264 variation; wrong isolated controls and binary-exact
inclusive-boundary controls must exceed the same threshold. The same fixed detector
must reject deliberate overlap at both endpoints for every rate and version.
No pixel tolerance or positive half-open expected interval was changed.

Measured in `f23cd216-3ae6-4858-ab20-c7b427df4e94`:

| Rate/endpoints | V1 maximum positive MAE | V2 maximum positive MAE | Deliberate shared-boundary overlap MAE V1/V2 |
| --- | ---: | ---: | --- |
| 30/1 exact | 0.297063 | 0.288984 | 13.089344 / 13.087297 |
| 30000/1001 exact | 0.297063 | 0.288984 | 13.089344 / 13.087297 |
| 30000/1001 rounded | 0.197391 | 0.183922 | 13.089344 / 13.087297 |
| 24000/1001 exact | 0.375297 | 0.383281 | 13.167906 / 13.172875 |
| 24000/1001 rounded | 0.375297 | 0.383281 | 13.167906 / 13.172875 |

The original inclusive graph fails the same detector at 30/1's shared boundary
(MAE 13.015641 / 13.032953) and final endpoint (2.211063 / 2.210641), and at
24000/1001's exact shared boundary (13.012422 / 13.014000) and final endpoint
(2.215734 / 2.217406). Correct final-cue absence has MAE 0 in every matrix case.

### Rounding limitation and corrected negative-control assumption

The first executable matrix run (`654dada3-55a5-4fe5-947b-834f44314595`) exposed
an incorrect TEST assumption: rational equality does not guarantee that the old
inclusive graph overlaps at every fractional boundary. At 30000/1001, FFmpeg's
`30 * (1001/30000)` is `1.001000000000000112`, whereas parsed `1.001000` is
`1.000999999999999890`. The old expression therefore already excludes that frame.
This is not evidence against the observed overlap at 30/1 and 24000/1001.

Verified source: FFmpeg n9.0.1 `libavfilter/avfilter.c`,
`evaluate_timeline_at_frame`, assigns `t = pts * av_q2d(link->time_base)`:
<https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/libavfilter/avfilter.c>.
The corrected test asserts old-graph failure at binary equality and asserts its
non-overlap when floating time already crossed the rationally equal endpoint.
It additionally requires deliberate-overlap rejection unconditionally for every
rate/version/endpoint, rather than losing negative-control coverage at fractional
rates. Positive frame expectations still derive solely from actual rational
output PTS and the original half-open microsecond contract.

Microsecond rounding itself is also visible: at 30000/1001, frame 31 precedes
1034367us and still carries the outgoing cue; frame 32 carries the incoming cue.
At 24000/1001, frame 25 follows 1042708us, while frame 50 precedes 2085417us and
still carries the final cue; frame 51 is blank. No exact rational-alignment claim
is made for these rounded intervals.

### Historical environment failure

Originally installed FFmpeg and FFprobe: `8.1.2-full_build-www.gyan.dev`, gcc 16.1.0,
libavfilter 11.14.102. Resolved from the existing Gyan.FFmpeg WinGet package under
`%LOCALAPPDATA%/Microsoft/WinGet/Packages/`. Build advertises fontconfig, freetype,
fribidi and harfbuzz support. Source generation and a standalone no-caption encode
succeeded. Drawtext default-font initialization fails with:

```text
Fontconfig error: Cannot load default config file: File not found
ExitStatus(ExitStatus(3221225477))
```

A standalone drawtext reproduction also crashed. A temporary FONTCONFIG_FILE
pointing at installed Windows fonts and selecting Arial still crashed; no system
configuration, fonts, installed binaries or render arguments were changed.
Windows fonts (including Arial) exist, but no successfully selected render font
can be reported. Temporary config/media and host command logs are outside the
repository. Fontconfig configuration reference:
<https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-user.html>.

### Authorized local repair and provenance

After explicit authorization, an isolated Arial-only directory still failed with
Gyan 8.1.2. Explicit `fontfile` worked, isolating the failure to default font lookup,
not caption parsing or the font itself. A checksum-verified BtbN 8.1 build handled
font lookup but failed libx264 encoding with native status `-1073741795` (illegal
instruction); it was not used for passing proof. Its archive SHA-256 was
`bffba999b75b8a99d4a5e2b6db4d7655554950af24a447b4a0f88157c7fa1b0d`.

The selected replacement is Gyan **9.0.1 essentials**, gcc 16.1.0, libavfilter
12.1.101. The official FFmpeg download page links this provider. Release metadata
was read from GitHub and the downloaded archive matched its published digest:

- Release: <https://github.com/GyanD/codexffmpeg/releases/tag/9.0.1>
- Archive SHA-256: `fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9`
- FFmpeg EXE SHA-256: `72a489eccd008c2ec2c0a5856c5c75bc3d8bbfa90166c4566865c246445e6aa3`
- FFprobe EXE SHA-256: `19202b23c0043f15ad1b7bce2344f406fd52bd6efd8f995ce02e7392a1cec52f`
- Arial copied from `C:/Windows/Fonts/arial.ttf`, SHA-256:
  `c9b76220a5be42ead4733611e417cd65c5fd8aeaa33eb56576ac378a37d130a1`.

Only explicitly named executable/license archive members were extracted. Tools,
license, and a local font copy are installed side-by-side under
`%LOCALAPPDATA%/supa-video-tools/ffmpeg-9.0.1/`; existing tools and global PATH
remain untouched. The ignored `.cache/p1-fontconfig/fonts.conf` points at that
single-font directory and its cache and assigns Arial as the default family.
The test's verbose preflight records the exact font file actually selected.
No production graph, validation, trust policy or repo dependency was changed.

The original 8.1.2 installation remains unsuitable; passing output evidence is
specific to the verified replacement/font configuration. Other fonts, tool builds
and platforms are not certified by these measurements.

## Commands and final results

Earlier post-format chained execution (before environment repair and the
negative-control correction): `c17e897c-66e5-403a-8010-cafe3a3853f1`, exit 0,
2026-09-08 16:18:57Z–16:23:37Z. Every command was joined with `&&`:

```sh
pnpm --filter @supa-video/render test
pnpm --filter @supa-video/render check
pnpm exec eslint packages/video-render/src/compile-render-plan.ts packages/video-render/src/compile-render-plan.test.ts
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml race_
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml video::cache::tests
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_caption
cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```

Results: 26 TypeScript tests passed; TypeScript check and ESLint passed; 11 race
tests passed; 22 cache tests passed (overlapping subsets, not additive); 3 native
caption tests passed and the real-frame test was ignored in this normal run;
strict all-target/all-feature Clippy passed. Cargo test emitted an existing
informational MSVC linker-message warning; no assertion was relaxed.

Explicit real-frame execution command (requires the selected working tools):

```sh
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_caption_boundary_local_ffmpeg_v1_v2 -- --ignored --nocapture
```

Execution `6e8d6ed1-9a12-42f9-87a9-d9df2acfca8b` first passed the non-ignored
native matrix test, then failed the explicit real-frame test (exit 101) at the
font preflight. This occurred before formatting; the post-format normal suite
compiles but does not establish real output.

Formatting: scoped Prettier and cargo fmt; final diff inspected, `git diff --check`
passed. No broader derived/transcript regression expansion was required because
production cache/caller code was unchanged.

Repaired-environment command from a PowerShell shell at the repository root
(environment changes are confined to that shell):

```powershell
$env:FONTCONFIG_FILE = (Resolve-Path '.cache/p1-fontconfig/fonts.conf').Path
$env:PATH = "$env:LOCALAPPDATA/supa-video-tools/ffmpeg-9.0.1/bin;" + $env:PATH
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_caption_boundary_local_ffmpeg_v1_v2 -- --ignored --nocapture
```

The first full pass used the same binary/font hashes in temporary paths, as
recorded in execution `f23cd216-3ae6-4858-ab20-c7b427df4e94`. Final post-format
criterion checks use the stable side-by-side location above. Current execution
bindings are submitted with the completion-intent report, not by editing this
file after those checks.

Post-format source SHA-256:

```text
bc9d711d46564bead4d82e55d391c45313aaadd2aca3f0ee6f72a1a819dab2b1  apps/desktop/src-tauri/src/video/cache.rs
51c5a84506d9d7ad0ab8df0b4bcd812c836ab65b626517202a2c9d3eaa5d6d6a  apps/desktop/src-tauri/src/video/render.rs
fb877e49b10e06d42a7b189ee5fce5010f7029a557ccb76c8041b6a239331f4c  apps/desktop/src-tauri/src/video/tests.rs
369e65f6b87174495300b8fdbd068a2b2ec05f99e813fee19ea94764d8ac0148  packages/video-render/src/compile-render-plan.ts
7d93cef21213c40cacbc8d79481d5d7e22fb4df9abbd6d419082acdb3d0b0ef7  packages/video-render/src/compile-render-plan.test.ts
```
