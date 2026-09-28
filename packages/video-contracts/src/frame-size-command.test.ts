import { describe, expect, it } from "vitest";
import { projectCommandSchemaV2 } from "./project-commands-v2.js";

const command = {
  type: "SetSequenceFrameSize",
  commandId: "00000000-0000-4000-8000-000000000001",
  sequenceId: "00000000-0000-4000-8000-000000000002",
};

describe("SetSequenceFrameSize", () => {
  it.each([
    [1_280, 720],
    [720, 1_280],
    [720, 720],
    [2, 16_384],
  ])("accepts %ix%i", (width, height) => {
    const value = { ...command, width, height };
    expect(projectCommandSchemaV2.parse(value)).toEqual(value);
  });

  it.each([
    [1_281, 720],
    [720, 0],
    [16_386, 720],
    [720.5, 720],
  ])("rejects %sx%s, matching the native validation", (width, height) => {
    expect(projectCommandSchemaV2.safeParse({ ...command, width, height }).success).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(
      projectCommandSchemaV2.safeParse({ ...command, width: 720, height: 720, fit: "fill" })
        .success,
    ).toBe(false);
  });
});
