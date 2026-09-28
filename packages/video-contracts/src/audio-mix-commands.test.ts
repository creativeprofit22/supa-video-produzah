import { describe, expect, it } from "vitest";
import { projectCommandSchemaV2 } from "./project-commands-v2.js";

const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const role = { type: "SetTrackAudioRole", commandId: id(1), sequenceId: id(2), trackId: id(3) };
const loudness = { type: "SetSequenceLoudnessTarget", commandId: id(4), sequenceId: id(2) };
const target = {
  integratedLufs: -16,
  truePeakCeilingDbtp: -1,
  ducking: false,
  dialogueCleanup: true,
};

describe("public audio-mix commands", () => {
  it.each([
    ["a role", { ...role, role: "music" }],
    ["an explicit null role", { ...role, role: null }],
    ["a loudness target", { ...loudness, target }],
    ["an explicit null loudness target", { ...loudness, target: null }],
  ])("accept %s", (_case, command) => {
    expect(projectCommandSchemaV2.parse(command)).toEqual(command);
  });

  it.each([
    ["a missing role", role],
    ["an undefined role", { ...role, role: undefined }],
    ["a missing loudness target", loudness],
    ["an undefined loudness target", { ...loudness, target: undefined }],
  ])("reject %s so clearing is always explicit", (_case, command) => {
    expect(projectCommandSchemaV2.safeParse(command).success).toBe(false);
  });
});
