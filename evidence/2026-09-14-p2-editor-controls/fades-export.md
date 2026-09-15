# Fades export — 2026-09-14

Implemented optional V2 input `fades: { inFrames, outFrames }`, copied only for nonzero canonical fades. Removed temporary unsupported-export guard. V1 adaptation explicitly rejects nonzero fades. Output-frame boundaries use existing rational-to-microsecond rounding and fixed-six decimal formatting in TypeScript and Rust. Audible filters run source trim, timestamp reset, optional atempo, bounded output trim, optional gain, then linear (`curve=tri`) afade ramps. Zero ramps are omitted; zero/absent fades retain existing argv. Hidden/zero-opacity inputs retain audio; muted inputs retain metadata without audio filters.

Strict metadata rejects null, invalid integers, unknown fields, unsafe values, sums exceeding expected output frames, and inconsistent timing context. TS validates fade-bearing audio branches and output duration. Native independently reconstructs expected graph and retains existing entire-argv validation and grants.

## Actual verification

- `pnpm --filter @supa-video/contracts build`: passed (execution ID `d17b688d-8b96-4d1a-af82-75e19d120752`; later command in that initial chain found a test-fixture TS typing error, fixed).
- `pnpm --filter @supa-video/render check`: passed.
- `pnpm --filter @supa-video/contracts check`: passed.
- `pnpm --filter @supa-video/render test`: **54/54 passed**, including seven new fades cases (zero/in/out/both at 30000/1001, retimed gain with hidden/zero opacity and mute variants, invalid metadata/sums/context/filter duration).
- Final successful check/test execution ID: `23a03c6d-c076-4615-ab31-adf2fe9ad50b`.
- Prettier formatted touched TS files; rustfmt `--edition 2021 --config skip_children=true` formatted the three touched native files.

## Native test added / remaining

`apps/desktop/src-tauri/src/video/tests.rs`: `render_fades_exact_output_frames_and_tamper_rejection` covers valid zero/in/out/both graphs, absent metadata with fades, changed curve, changed expected duration, null/negative/fractional/unsafe/unknown metadata and excessive sum using current grants fixture.

**Not run:** Rust build/tests, intentionally delegated to parent. Parent should run the new native test plus existing render speed/volume suites. Native retimed/fractional-rate fade-specific acceptance tests remain desirable; current TS cases prove those compiler paths, not native execution. No actual RMS/media export test was added or run. No native process/job/export IDs exist for this change. No UI, ProgramMonitor, controller, project fade commands, dependencies, grants, or roadmap changes were made by this task.
