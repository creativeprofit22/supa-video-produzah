import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandGroupRequestSchema, projectCommandSchemaV2 } from "./project-commands-v2.js";
import { projectHistoryEntryV2Schema } from "./project-v2.js";

const command = JSON.parse(
  readFileSync(new URL("../fixtures/clip-speed-command.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const projectId = "10000000-0000-4000-8000-000000000001";
const groupId = "10000000-0000-4000-8000-000000000010";

describe("speed inverse history boundary", () => {
  it.each([null, { numerator: 1, denominator: 1 }, { numerator: 3, denominator: 2 }])(
    "preserves exact previous representation %j only in inverse history",
    (speed) => {
      const inverse = { ...command, type: "RestoreClipSpeed", speed };
      expect(projectCommandSchemaV2.parse(inverse)).toEqual(inverse);
      const entry = {
        groupId,
        summary: "Updated clip speed",
        forwardCommands: [command],
        inverseCommands: [inverse],
        affectedRanges: [],
        cacheInvalidations: ["timeline", "preview", "audio_mix", "render_plan"],
      };
      expect(projectHistoryEntryV2Schema.parse(entry)).toEqual(entry);
      expect(
        projectHistoryEntryV2Schema.safeParse({ ...entry, forwardCommands: [inverse] }).success,
      ).toBe(false);
      expect(
        commandGroupRequestSchema.safeParse({
          groupId,
          projectId,
          baseRevision: 0,
          commands: [inverse],
        }).success,
      ).toBe(false);
      expect(
        commandGroupRequestSchema.safeParse({
          groupId,
          projectId,
          baseRevision: 0,
          commands: [command],
        }).success,
      ).toBe(true);
    },
  );
  it("requires the nullable restore field and still rejects invalid speeds and extra fields", () => {
    const inverse = { ...command, type: "RestoreClipSpeed", speed: null };
    const missing: Record<string, unknown> = { ...inverse };
    delete missing.speed;
    expect(projectCommandSchemaV2.safeParse(missing).success).toBe(false);
    expect(
      projectCommandSchemaV2.safeParse({ ...inverse, speed: { numerator: 2, denominator: 2 } })
        .success,
    ).toBe(false);
    expect(projectCommandSchemaV2.safeParse({ ...inverse, extra: true }).success).toBe(false);
  });
});
