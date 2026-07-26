import { describe, expect, it } from "vitest";

import { buildCommandGroup, buildProjectCommand } from "./command-group.js";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

describe("V2 browser-safe helpers", () => {
  it("builds authority-free strict groups", () => {
    const command = buildProjectCommand({
      type: "RemoveMarker",
      commandId: id(4),
      sequenceId: id(5),
      markerId: id(6),
    });
    const group = buildCommandGroup({
      groupId: id(1),
      projectId: id(2),
      baseRevision: 7,
      commands: [command],
    });
    expect(group).toEqual({
      groupId: id(1),
      projectId: id(2),
      baseRevision: 7,
      commands: [command],
    });
    expect(group).not.toHaveProperty("committedAt");
    expect(group).not.toHaveProperty("summary");
    expect(group).not.toHaveProperty("stateHash");
  });

  it("rejects authority-only command fields", () => {
    expect(() =>
      buildProjectCommand({
        type: "RemoveMarker",
        commandId: id(4),
        sequenceId: id(5),
        markerId: id(6),
        summary: "caller supplied",
      } as never),
    ).toThrow();
  });
});
