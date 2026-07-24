# Phase 1 recovery and render-plan compiler

## Outcome

Restore the broken workspace package boundary, then complete the actual next Phase 1 roadmap item: a browser-safe, deterministic `compileSingleClipRenderPlan` implementation with exact FFmpeg argv snapshots and no process or filesystem access.

This plan intentionally stops after Phase 1 implementation Step 6. Fixtures, Rust media/process commands, React workflow work, and runtime FFmpeg integration remain Steps 7–18 and must not be pulled into this change.

## Current baseline

- `packages/video-project/package.json` is 515 NUL bytes. pnpm cannot parse the workspace, so root `build`, `check`, and `test` fail before running package scripts; Vitest also cannot discover `packages/video-project/src/project.test.ts`.
- The lockfile already records the intended `@supa-video/project` workspace edge to `@supa-video/contracts` plus TypeScript/Vitest development dependencies, so restoring the manifest should not change `pnpm-lock.yaml`.
- `packages/video-project/src/project.test.ts` is the only source file currently reported by Prettier.
- `packages/video-contracts` currently type-checks and passes 17 tests. It already exports `ProjectRevision`, `RenderPlanV1`, `renderPlanV1Schema`, rational-time helpers, and the `invalid_render_plan` domain error code.
- `packages/video-project` source type-checks and contains the four-command path plus immutable history, but its five tests are blocked by the corrupt manifest.
- `packages/video-render/src/index.ts` contains only `export {};`; no compiler or render tests exist.
- Official FFmpeg documentation confirms that option order is semantic, `-map` controls exact stream inclusion, video rates accept `numerator/denominator`, and decimal seconds or integer microseconds are valid duration syntax. The compiler will therefore emit one ordered argv array and never a shell command.

## Scope

### Workspace recovery

Restore `packages/video-project/package.json` as the private ESM package `@supa-video/project`, matching the established package pattern:

- export `./dist/index.js` and `./dist/index.d.ts`;
- provide `build`, `check`, and `test` scripts matching the contracts/render packages;
- depend on `@supa-video/contracts` through `workspace:*`;
- retain the lockfile-pinned TypeScript `6.0.3` and Vitest `4.1.10` development dependencies.

Format `packages/video-project/src/project.test.ts`, then prove the recovered package can type-check and execute all five existing tests before touching the render implementation. Do not regenerate or edit the lockfile unless `pnpm install --frozen-lockfile` proves the existing lockfile is inconsistent.

### Compiler API

Add `packages/video-render/src/compile-render-plan.ts` with:

```ts
export interface CompileSingleClipRenderPlanInput {
  readonly planId: string;
  readonly revision: Readonly<ProjectRevision>;
  readonly inputPath: string;
  readonly outputPath: string;
}

export function compileSingleClipRenderPlan(
  input: CompileSingleClipRenderPlanInput,
): Readonly<RenderPlanV1>;
```

The package remains browser-safe: it accepts already-resolved paths, performs no path lookup, reads no files, and spawns no process. `packages/video-render/src/index.ts` will export the compiler and its input type.

### Validation and error contract

The compiler will validate the supplied revision with `projectRevisionSchema` and reject every non-renderable state through `VideoDomainError("invalid_render_plan", ...)`:

- malformed revision or invalid plan/path payload;
- missing asset, sequence, track, or the single required clip;
- clip asset identity mismatch;
- sequence/clip rate mismatch or sequence/asset average-rate mismatch;
- empty or reversed source range;
- source-out beyond the probed source duration;
- invalid UUID, path, dimensions, or expected metadata caught by `renderPlanV1Schema`.

Error details may include schema issues and stable IDs/numeric bounds, but must not introduce filesystem access or shell diagnostics. The compiler must not mutate the revision or any nested state.

### Rational boundary formatting

Derive:

- `sourceStart` from `clip.sourceIn`;
- `durationFrames` from the half-open range `sourceOut.value - sourceIn.value`;
- `duration` from a rational time at the sequence rate;
- `expected` metadata from the immutable revision: duration frames, exact rate, sequence dimensions, and whether the probe reports audio.

At the FFmpeg edge, convert start and duration to integer microseconds with the existing BigInt-backed `rationalTimeToMicroseconds(..., "nearestTiesAwayFromZero")`, then emit fixed six-place decimal seconds. This avoids floating-point/scientific notation, gives one explicit rounding policy, and bounds each boundary error to half a microsecond—well below the one-frame output tolerance.

### Exact Phase 1 argv grammar

Build one argv array in this order:

1. global supervision flags: `-hide_banner`, `-nostdin`, `-loglevel warning`, `-progress pipe:1`, `-nostats`;
2. one input: `-i`, then `inputPath`;
3. output-side trim: `-ss <fixed-seconds>`, `-t <fixed-seconds>`;
4. exact stream selection: `-map 0:v:0`; for AV sources add `-map 0:a:0`, while video-only sources add `-an`;
5. one deterministic video filter string: aspect-preserving Lanczos scale into the even sequence dimensions, centered black pad, then `fps=<rateNumerator>/<rateDenominator>` for sequence CFR;
6. video encoding: `-c:v libx264`, `-pix_fmt yuv420p`;
7. AV-only audio encoding: `-c:a aac`, `-ar 48000`;
8. MP4 optimization: `-movflags +faststart`;
9. `outputPath` as the final argument.

Paths remain raw argv elements. Do not add shell quoting, concatenate a command string, normalize user paths, or invoke FFmpeg. The returned object must pass `renderPlanV1Schema`, carry `schemaVersion: 1`, use the supplied `planId`, bind `revisionId` to the supplied revision, set `executable: "ffmpeg"`, and be deeply frozen including `expected` and `argv`.

## Files

- Restore `packages/video-project/package.json`.
- Format `packages/video-project/src/project.test.ts` without changing test behavior.
- Add `packages/video-render/src/compile-render-plan.ts`.
- Add `packages/video-render/src/compile-render-plan.test.ts`.
- Replace the placeholder export in `packages/video-render/src/index.ts` with the public compiler export.
- Leave `packages/video-contracts/src/render-plan.ts`, `pnpm-lock.yaml`, Rust, fixtures, and desktop UI unchanged unless a focused check exposes a concrete contract defect required by this compiler.

## Tests

`compile-render-plan.test.ts` will use deterministic UUIDs and valid in-memory revisions to cover:

- exact AV argv inline snapshot, with path separators normalized only in the snapshot representation;
- exact video-only branch, including `-an` and absence of audio map/codec arguments;
- expected duration/rate/dimensions/audio metadata and revision/plan/path identity;
- fixed six-place second formatting at an integer rate and `30000/1001`, with no exponent notation;
- paths containing spaces remaining single argv elements and never becoming a shell string;
- deep immutability of the plan, expected metadata, and argv;
- rejection of malformed revisions, incomplete states, mixed asset/sequence rates, empty ranges, and source-out beyond the probe duration;
- final validation through `renderPlanV1Schema` and `invalid_render_plan` error typing.

Verification gates:

- `pnpm install --frozen-lockfile`;
- focused project package build/check/test after manifest recovery;
- focused contracts and render package build/check/test;
- root `pnpm build`, `pnpm check`, `pnpm test`, `pnpm lint`, and `pnpm format:check`.

No FFmpeg process integration is claimed here; executable rendering starts with later native-boundary work and the explicit integration tests in Phase 1 Step 16.

## Risks

- **Manifest reconstruction drift:** derive it from the lockfile and neighboring package manifests; require a frozen install and no lockfile diff.
- **Option-order drift:** keep argv construction linear and lock both AV branches with inline snapshots.
- **Time drift:** use existing BigInt rational conversion and fixed microsecond formatting, never JavaScript floating-point seconds.
- **Invalid loaded projects bypassing command checks:** revalidate render-critical invariants at compilation, especially source duration and asset/sequence rate.
- **Scope creep into native rendering:** keep this package pure; Rust revalidation, output collision handling, process supervision, and post-render probing remain later roadmap steps.

## Steps

1. Restore `packages/video-project/package.json` from the lockfile and sibling-package conventions without changing dependency versions or `pnpm-lock.yaml`.
2. Format `packages/video-project/src/project.test.ts`, run the project package build/check/test gates, and resolve any recovery-only failures.
3. Add `CompileSingleClipRenderPlanInput`, render-critical revision validation, rational microsecond formatting, exact AV/video-only argv construction, schema validation, and deep freezing in `packages/video-render/src/compile-render-plan.ts`.
4. Export `compileSingleClipRenderPlan` and its input type from `packages/video-render/src/index.ts`.
5. Add deterministic render compiler tests covering exact argv snapshots, both audio branches, metadata, rational formatting, path token integrity, immutability, and invalid/incomplete/out-of-bounds revisions.
6. Run frozen install plus focused contracts/project/render build, check, and test gates; fix every failure without expanding into native runtime work.
7. Run root build, check, test, lint, and format checks and confirm Phase 1 Step 6 is complete while Steps 7–18 remain explicitly unclaimed.