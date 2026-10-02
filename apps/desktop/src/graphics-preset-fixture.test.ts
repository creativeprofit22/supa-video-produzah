import { videoProjectSnapshotV2Schema } from "@supa-video/contracts";
import { applyMotionPreset, type GraphicsPresetRequest } from "@supa-video/project";
import { expect, it } from "vitest";

import presetFixture from "../../../packages/video-contracts/fixtures/graphics-preset-commands.json";
import baseFixture from "../../../packages/video-contracts/fixtures/project-v2/valid-graphics.svpvideo?raw";

// The Rust graphics contract tests replay these commands; if presets change, regenerate with
// scripts/generate-graphics-preset-fixture.mjs so both languages stay on the same output.
it.each(presetFixture.cases)("motion preset output matches the shared fixture: $name", (entry) => {
  const base = videoProjectSnapshotV2Schema.parse(JSON.parse(baseFixture));
  const command = entry.commands[0];
  if (command === undefined) throw new Error("fixture case has no command");

  // Fixture JSON is test-owned; the request shape is checked by applyMotionPreset's types at use.
  const result = applyMotionPreset(
    base.state,
    presetFixture.ref,
    entry.request as GraphicsPresetRequest,
    command.commandId,
  );

  if (!result.ok) throw new Error(result.error.message);
  expect(JSON.parse(JSON.stringify(result.command))).toEqual(command);
});
