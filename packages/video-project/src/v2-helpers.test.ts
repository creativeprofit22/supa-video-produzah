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

  it("rejects live imports without content identity", () => {
    const legacyImport = buildProjectCommand({
      type: "ImportAsset",
      commandId: id(4),
      asset: {
        id: id(5),
        displayName: "legacy.mp4",
        locator: { absolutePath: "C:\\Media\\legacy.mp4" },
        probe: {
          durationMicroseconds: 1_000_000,
          averageFrameRate: { numerator: 30, denominator: 1 },
          realFrameRate: { numerator: 30, denominator: 1 },
          variableFrameRate: false,
          width: 640,
          height: 360,
          videoCodecName: "h264",
          audio: null,
          fileSizeBytes: 1_000,
        },
      },
    });

    expect(legacyImport.type).toBe("ImportAsset");
    if (legacyImport.type !== "ImportAsset") throw new Error("Expected a legacy import command");
    expect(legacyImport.asset.contentIdentity).toBeUndefined();
    expect(() =>
      buildCommandGroup({
        groupId: id(1),
        projectId: id(2),
        baseRevision: 0,
        commands: [legacyImport],
      }),
    ).toThrow("Live asset imports require a content identity");
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
