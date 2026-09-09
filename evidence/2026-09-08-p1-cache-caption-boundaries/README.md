# P1 — cache lifetime and caption boundaries

Date: 2026-09-08. Base revision: `80a2cfead567c78b9f757297f2af7c940675f68b`.
The worktree was clean before implementation. Changes remain uncommitted.
Scope: A1/A2 only; no cache production change, dependency, schema, public API,
mixed-rate validation, trust-policy, or historical ROADMAP change.

## Unresolved follow-up: intermittent bundled ToolUnavailable

The original execution `0895f6b5-bb4f-4376-a084-a4bfc49b1e63` failed with exit 101
before rendering the V1/V2 rounded 30000/1001 case. Both staged-resource copies had
completed; `verified_ffmpeg` then returned `ToolUnavailable`, category `not_found`,
operation `caption_boundary`. The failed test took 13.41 seconds. The unchanged
rerun `0877ff53-9a41-45b7-acff-c344cb1c4a29` passed, but did not establish a cause
or fix. This was not a demonstrated process-launch or font failure.

The exact remaining filesystem alternatives are resource-root canonicalization
(which maps every I/O error to `NotFound`) and FFmpeg metadata lookup returning
`NotFound`, during initial resolution or reverification. The original log did not
preserve the stage, path or underlying Windows error, so it cannot distinguish
these alternatives. No deletion, antivirus interference or other cause is proven.

Test-only diagnostics now emit stage, path, `io::ErrorKind` and `raw_os_error`
before mapping. Deterministic missing-resource execution
`61ac5ff4-05a2-4dbb-b563-3d1b311287f6` passed: one test, zero failed/ignored, exit 0.
It logged `canonicalize_root` / `NotFound` / Windows error 2, and
`symlink_metadata_binary` / `NotFound` / Windows error 3 for both absent binaries.
This verifies diagnostic emission, not reproduction of the intermittent cause.

Resolver-only batch `a43a0061-de00-474b-89ec-0459b6da45aa` used the same temporary
staged-resource lifecycle, without rendering, capped at 20 iterations and 300
seconds. **Only 12 iterations completed successfully.** Iteration 13 started but
had no recorded outcome when the command was cancelled at the 300-second limit
(tool elapsed 300715ms; aborted, exit 1). **The batch did not pass.** No intermittent
filesystem failure was observed in the completed iterations. Earlier attempts
`36377495-9ad6-4856-9d37-2ae0c2e23574` and
`70ae1712-9393-46e9-a61b-c99f5e765b41` stopped during compilation and provide no
runtime diagnostic evidence.

**Status: unresolved follow-up, not fixed.** Successful matrix executions below
remain evidence of those renders, not proof that tool resolution is reliable.
No further reproductions, production changes or Roadmap updates accompany this
record. All recorded execution IDs are historical; this documentation update does
not claim current harness acceptance for earlier checks.

## Final matrix evidence — 2026-09-08

The bundled production-path test now independently selects all five entries in
`CAPTION_BOUNDARY_CASES`, each exercising V1 and V2. It retains actual-frame PTS
assertions, isolated cue comparisons, old-inclusive-expression controls and
unconditional deliberate-overlap controls. No font/PATH workaround is used.
Missing or modified pinned resources fail instead of skipping. Binaries are
8.1.2 essentials, verified by the production bundled resolver; positive renders
use the production validator and executor. Default font identity is not logged.

### Completed executions before this final documentation edit (historical)

| Rate       | Shared / final endpoint (us) | V1/V2 result                         | Execution ID                           |
| ---------- | ---------------------------- | ------------------------------------ | -------------------------------------- |
| 30/1       | 1000000 / 2000000            | Both passed                          | `22d924be-bc6f-4fa4-bdfa-820ae5fb1879` |
| 30000/1001 | 1001000 / 2002000            | Both passed before helper extraction | `6fa1d7df-ab40-40f1-9ca9-35ef1f55db72` |
| 30000/1001 | 1034367 / 2035367            | Both passed                          | `e134eb2a-f305-4139-a934-1f44d4decd17` |
| 24000/1001 | 1001000 / 2002000            | Both passed                          | `59987a63-3834-48bc-acb6-f9aef199e7fb` |
| 24000/1001 | 1042708 / 2085417            | Both passed                          | `0bb23899-016f-4662-84f1-6045558bea2d` |

All completed with exit 0, one passed test each, zero failed and zero ignored.
The four newly added cases each used a standalone 600000ms command; test durations
were 178.56, 187.69, 184.61 and 187.51 seconds respectively. Correct-frame maximum
MAE stayed below 0.31 against the unchanged 2.0 threshold; deliberate shared-boundary
overlap exceeded 13.29. Old inclusive graphs also visibly fail at exact 30/1 and
24000/1001 boundaries. Do not generalize that failure to 30000/1001 or rounded
endpoints: the previously documented floating-point limitation still applies.

### Current verification protocol and doneWhen mapping

This README is finalized **before** the final verification pass. Final command
IDs/outcomes will be reported in the response, not written here afterwards;
therefore every execution ID recorded in this file is historical, not a claim
of current harness approval. No further edits are planned unless a check fails.

| P1 doneWhen                                                                                                                       | Required final checks                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Barrier-controlled publication/eviction-to-lease races for transcripts and prepared media; protected artifacts cannot be evicted. | `race_` plus `reserved_lease_wins_and_invalid_content_never_leases`; retain unsafe sensitivity controls and real-caller coverage described below. |
| Both compilers enforce the same half-open interval and exact argv validation agrees.                                              | TypeScript render tests plus native exact-argv, malformed-metadata and full boundary-matrix validation tests.                                     |
| Real FFmpeg output proves non-overlapping adjacent cues, including fractional rates and V1/V2.                                    | All five independently selected bundled tests above, not merely the historical local 9.0.1 / Arial matrix.                                        |

Final verification uses standalone commands: Cargo formatting check, scoped README
Prettier formatting check, the criterion checks above, and five separate bundled
render commands with 600000ms timeouts. Non-render Cargo checks use 300000ms;
pnpm checks use 120000ms. Actual outcomes, rather than this protocol, decide whether
any criterion remains unmet. No packaging, other platforms, named default fonts or
Roadmap settlement is claimed. The old WinGet 8.1.2 full-build crash is distinct
from the passing pinned essentials build; old local-workaround and partial-matrix
records below are historical and do not limit or expand the new measured matrix.

## Historical criterion outcomes (before full bundled coverage)

| Criterion                 | Current evidence                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 cache lifetime         | PASS: existing deterministic races plus test-only unsafe sensitivity controls; current production defect not reproduced.                                                                                |
| A2 compiler/native parity | PASS: both helpers emit `gte(t\,START)*lt(t\,END)`; V1/V2 exact argv validation agrees.                                                                                                                 |
| A2 actual caption frames  | PASS with scoped evidence: pinned bundled 8.1.2 essentials, V1/V2 at 30000/1001 only; retained local 9.0.1 / Arial full-matrix evidence covers the other rates/endpoints. See the reconciliation below. |

## Verification refresh — 2026-09-08 18:40Z

The reviewer reported all previous criterion execution IDs as **STALE** in the
harness. Those records below remain historical; they are not current harness
approval. All six requested checks were rerun as standalone commands, with no
shell chaining, PATH overrides or font workaround. No production/test source was
changed in this refresh. Only this README was updated after execution.

| Criterion/check                                   | New execution ID                       | UTC start | Timeout (ms) | Actual test outcome                    |
| ------------------------------------------------- | -------------------------------------- | --------- | -----------: | -------------------------------------- |
| A1: `race_`                                       | `83bec02b-91ee-4f6a-8391-8dbffb560256` | 18:36:29  |       300000 | PASSED: 11 tests, exit 0               |
| A2: TypeScript compiler                           | `59322507-07b7-43c3-b8b8-2b8c60c958c5` | 18:36:43  |       120000 | PASSED: 26 tests, exit 0               |
| A2: native exact argv / escaping                  | `ae738991-17b5-4f07-915b-03f5af893040` | 18:36:53  |       300000 | PASSED: 1 test, exit 0                 |
| A2: native boundary matrix validation             | `4f004c3c-7301-411d-8bea-265c2b782def` | 18:37:02  |       300000 | PASSED: 1 test, exit 0                 |
| A1: reserved lease                                | `e0bc7952-634a-4db6-aa6b-c57404d33b66` | 18:37:11  |       300000 | PASSED: 1 test, exit 0                 |
| A2: bundled real frames, V1/V2 at 30000/1001 only | `5a1e0568-fc0c-4200-b7ad-8ff5ad3f5ece` | 18:37:31  |       600000 | PASSED: 1 test, exit 0; 178.36 seconds |

Every execution reported zero failed and zero ignored tests. The five non-render
commands are listed in the reconciliation below; the sixth was:

```sh
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_caption_boundary_bundled_ffmpeg_v1_v2 -- --nocapture
```

The verified pinned 8.1.2 essentials binary resolved to
`%TEMP%\.tmpWnexfd\media-tools\ffmpeg.exe` (with FFprobe alongside it).
V1/V2 frame assertions and negative controls passed with the same measurements
recorded below. This renews **only V1/V2 at 30000/1001**, not other bundled rates,
rounded endpoints, fonts, platforms or desktop packaging. The wider local
9.0.1 / Arial matrix remains historical evidence and was not refreshed.

Here **PASSED** means the observed completed test result and independent exit 0.
The execution tool does not expose the harness's post-README-edit classification;
no claim is made that these IDs remain classifier-approved after this evidence
write. Current executed coverage supports A1 and compiler/argv parity, plus the
stated bundled-frame subset. A fully fresh wider real-frame matrix is not proven
by this refresh. No Roadmap update API or packaging command was called.

## Criterion reconciliation — 2026-09-08 18:35Z (historical executions)

Compared against the three exact `doneWhen` entries for phase
`85b1e9e2-ec8f-4244-956c-08cb996a6662`, read at Roadmap revision 134.
Code revision: `267dcc127bd64d7dedab3b793a9f4ea739ebe5e1`, plus the existing
uncommitted bundled integration test in `video/tests.rs`. This turn changes only
this evidence README. No Roadmap update API was called and no packaging work ran.

| Exact doneWhen                                                                                                                                                                                  | Result and supporting evidence                                                                                                                                                                                                                                                            | Remaining requirement gap                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Barrier-controlled tests establish and prevent both cache publication-to-lease and eviction-selection-to-lease races for transcripts and prepared media; protected artifacts cannot be evicted. | PASS: refreshed 11 `race_` tests plus the reserved-lease test. Acknowledged barriers, unsafe sensitivity controls, real transcript/prepared callers and protected bytes cover both schedules. See A1 below for the per-test mapping.                                                      | None. These establish regression prevention and sensitivity, not a newly reproduced production defect.                                                                        |
| Both render compilers enforce the same half-open caption interval and exact argv validation agrees.                                                                                             | PASS: refreshed 26 TypeScript compiler tests, native exact V1/V2 argv/escaping test, and native full rate/endpoint matrix validation. Both helpers still use `gte(t\\,START)*lt(t\\,END)`.                                                                                                | None. Matrix validation alone is not actual-frame proof.                                                                                                                      |
| Real FFmpeg output proves adjacent cues do not overlap at the shared boundary, including fractional rates and V1/V2 plans; otherwise retain that proof as unverified.                           | PASS with explicit environment scope: current bundled 8.1.2 essentials output proves V1/V2 at 30000/1001, shared endpoint 1001000us and final endpoint 2002000us. Retained local 9.0.1 / Arial full-matrix execution covers 30/1, 30000/1001 and 24000/1001, including rounded endpoints. | No uncovered literal P1 requirement. Other rates on the pinned bundled build and packaged-desktop operation remain unverified; neither is required by these doneWhen entries. |

### Fresh checks for stale criterion evidence

Each command below ran independently, without shell chaining or pipelines. All
exited 0 with zero failures and zero ignored tests. Cargo commands had 300000ms
timeouts; the pnpm command had 120000ms. Existing informational MSVC linker output
was not suppressed. No assertions or test selection inside the suites changed.

| Check                                  | UTC start | Execution ID                           | Passed |
| -------------------------------------- | --------- | -------------------------------------- | -----: |
| Cache race schedules                   | 18:33:41  | `0d43ae00-5721-4641-a329-e323d9ebd785` |     11 |
| TypeScript compiler                    | 18:33:57  | `f78541a9-701d-40c8-aacc-b948613ef9ce` |     26 |
| Native exact argv / escaping           | 18:34:16  | `98a3d279-ec98-4118-81d4-46364672f148` |      1 |
| Native full boundary matrix validation | 18:34:24  | `d59b37ca-d32e-410c-8c68-b591b10ded59` |      1 |
| Lease wins after eviction selection    | 18:34:35  | `dd89f3ac-4cc9-446d-b987-cefc392cae1b` |      1 |

Commands (each line was a separate tool execution):

```sh
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml race_
pnpm --filter @supa-video/render test
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_caption_metadata_exactly_binds_v1_and_v2_argv_and_escapes_drawtext
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_caption_boundary_matrix_validates_exact_v1_v2_plans_without_tools
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml reserved_lease_wins_and_invalid_content_never_leases
```

### Retained current bundled-render evidence — not rerun

Execution `f347c60c-9c89-479c-9ba9-0b934aa0dc2b`, started 18:17:36Z, ran:

```sh
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml render_caption_boundary_bundled_ffmpeg_v1_v2 -- --nocapture
```

Standalone command, 300000ms timeout, exit 0; **1 passed, 0 failed, 0 ignored**,
185.44 seconds in the test. Resolved binary:
`\\?\C:\Users\SPARTAN PC\AppData\Local\Temp\.tmppl6GQV\media-tools\ffmpeg.exe`.
The temporary resource directory is removed after the test. The production resolver
verifies the manifest-pinned 8.1.2 essentials binaries copied from the existing
project staging directory. Bootstrap execution
`d41711a4-0d7e-4a58-9607-8a98a0e6e1b1` verified that exact pinned toolchain.
No PATH override, FONTCONFIG_FILE/FONTCONFIG_PATH setting, explicit font file or
local Arial workaround was used. The selected default font was not logged, so
this is not evidence of a particular font family. Missing resources fail, not skip.

**Only V1/V2 at 30000/1001 is a completed bundled-render pass.** It uses 90 frames
per render, six outputs per version, and checks frames 29/30/31 and 59/60/61
against isolated controls using actual output PTS. Positive maximum MAE was
0.268641 (V1) / 0.273547 (V2), below the fixed 2.0 tolerance. Deliberate overlap
at the shared boundary measured 13.308016 / 13.295172 and was correctly rejected.
At this rate the old inclusive expression also avoids the boundary because of
floating-point rounding; it is not claimed to fail here. See the rounding section.

The earlier expanded bundled run `d0cf3c25-2cbc-4486-a1e3-85276602e3cd` was aborted
at approximately 300 seconds. Partial frame output is not a completed wider pass.
The original local full-matrix test remains intact through a shared helper; its
9.0.1 / Arial results below are retained evidence, not newly executed bundled proof.
Current SHA-256 checks confirm that `cache.rs`, `render.rs`, the TypeScript compiler
and its tests still match the historical hashes below. The current `video/tests.rs`
hash is `0791f965ef242d855fe8923ba86e4e6af4b06e30dc22b4de348c3c93e8f96815`;
its added bundled test and helper extraction do not expand the old evidence scope.

**Conclusion:** the three P1 requirements have supporting runtime evidence within
the environments stated above; none remains unverified as written. This is an
evidence reconciliation, not host/classifier acceptance or Roadmap completion.
The stale Roadmap font-crash record refers to the original WinGet 8.1.2 **full**
build, not the now-tested pinned 8.1.2 **essentials** build.

## Earlier evidence and history

The following records are retained chronologically. References to future Roadmap
submission describe earlier activity, not actions requested or taken in this turn.

Initial verification was incomplete. Initial in-progress reports were rejected by the
host tool schema (`blocker`/`required_external_action`: expected never, received
null). After fresh criterion-specific checks, the concrete external FFmpeg/font
dependency was successfully reported as blocked via `roadmap_status`, revision
129, with failed verification and three unique execution bindings:

| Criterion ID                                                       | Bash execution ID                      | Outcome                                                       |
| ------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------- |
| `c821cdffb1ec034c8068f61801b1067c3e1ee9c3f17c13c717a98ec97046e831` | `ac7f60ed-21dd-498e-930f-c59b0933a112` | 11 race tests passed                                          |
| `f15401a3197bb404a071395c0b3796a7891be28e65b7fdf31d14d3084a5dc2c3` | `211818e2-dad6-4a73-a03e-814454791950` | 26 compiler and 3 native caption tests passed                 |
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

| Rate       | Shared boundary (microseconds) | Final end (microseconds) | Alignment                      |
| ---------- | -----------------------------: | -----------------------: | ------------------------------ |
| 30/1       |                        1000000 |                  2000000 | exact                          |
| 30000/1001 |                        1001000 |                  2002000 | exact                          |
| 30000/1001 |                        1034367 |                  2035367 | rounded up from frame time     |
| 24000/1001 |                        1001000 |                  2002000 | exact                          |
| 24000/1001 |                        1042708 |                  2085417 | rounded shared/final endpoints |

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

| Rate/endpoints     | V1 maximum positive MAE | V2 maximum positive MAE | Deliberate shared-boundary overlap MAE V1/V2 |
| ------------------ | ----------------------: | ----------------------: | -------------------------------------------- |
| 30/1 exact         |                0.297063 |                0.288984 | 13.089344 / 13.087297                        |
| 30000/1001 exact   |                0.297063 |                0.288984 | 13.089344 / 13.087297                        |
| 30000/1001 rounded |                0.197391 |                0.183922 | 13.089344 / 13.087297                        |
| 24000/1001 exact   |                0.375297 |                0.383281 | 13.167906 / 13.172875                        |
| 24000/1001 rounded |                0.375297 |                0.383281 | 13.167906 / 13.172875                        |

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
