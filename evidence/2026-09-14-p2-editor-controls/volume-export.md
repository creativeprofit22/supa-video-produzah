# Volume export foundation — 2026-09-14

## Implemented

- V2 input `gainMilliDecibels` is optional, integer and bounded -96000..24000 in TypeScript and native deserialization. Null, fractional, wrong-type and unknown metadata fail closed. Missing gain means zero and stays omitted on serialization.
- Compiler emits nonzero gain metadata and exact decimal dB filters (`volume=-6.123dB`, including `-0.001dB`) after the unchanged audio timing chain and before mixing. No approximate linear gain conversion. Native expected graph reconstructs the identical filter and still validates the entire argv and input grants.
- V2 eligibility now allows bounded gain. Hidden, muted, opacity and speed remain independent. Muted/no-audio inputs retain gain metadata without adding an audio filter. Zero emits neither metadata nor filter, preserving default bytes.
- V1 remains unchanged and explicitly rejects nondefault canonical gain rather than silently discarding it.
- Existing dirty speed implementation preserved. Only six contracts/render source/test files changed, plus this evidence. No GUI, controller, ProgramMonitor, persistence, fades, jobs, cache, Cargo, dependencies, commits or roadmap changes.

## Verification actually run

- Prettier on the three touched TS files; rustfmt `--edition 2021 --config skip_children=true` on the three touched Rust files, before checks.
- `pnpm --filter @supa-video/contracts build`: passed.
- `pnpm --filter @supa-video/contracts test`: **261 passed, 14 files**.
- `pnpm --filter @supa-video/render test`: **47 passed, 1 file**, including **14 new volume cases** (five exact gains, six invalid metadata values, unknown metadata, two muted/hidden/zero-opacity/speed combinations).
- `pnpm --filter @supa-video/render check`: passed.
- Above initial TS verification execution ID: `f3de1808-91ad-4bb0-8d79-46db7d35c5eb`.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml render_volume --lib`: **1 passed** — `video::tests::render_volume_exact_bounds_metadata_and_argv_fail_closed`.
- Same cargo command with `render_speed_binds`: **1 passed** — `video::tests::render_speed_binds_source_trim_tempo_and_reciprocal_timestamps`.
- Same cargo command with `render_plan_v2_strict`: **1 passed** — `video::tests::render_plan_v2_strict_fields_match_typescript_contract`.
- Native execution ID: `15ca18f0-b828-435e-babd-0b0370f3f863`; 340 filtered per invocation, no failures, existing dead-code warnings. Build/check sequence took 154 seconds.
- Final render test/typecheck and scoped `git diff --check`: passed, execution ID `ec0cc3c1-b191-4af1-b27f-055f60d0fd9a` (after explicitly setting zero opacity in the combination test).
- Complete own diffs inspected against pre-edit dirty snapshots, not HEAD; execution ID `63ffccce-f2ec-4b54-bcb6-f45a9701e5f8`, full 294-line diff read. Subsequent change was the reviewed one-line zero-opacity test option.

## Explicit gaps / handoff

- Actual rendered-audio RMS ratio test was **not added or run**. Native compilation consumed 154 seconds; defer the production-render RMS ratio proof to parent to honor the bounded handoff. No claim of measured audio parity.
- Combined gain+speed+hidden/mute/zero-opacity is covered in TS; native gain graph/metadata and existing speed graph are independently exercised, not a combined actual-media matrix.
- TypeScript validates metadata shape/bounds; the native boundary remains the authoritative exact whole-argv validator, as before.
