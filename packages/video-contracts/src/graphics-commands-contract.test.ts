import { readFileSync } from "node:fs";

import { type ProjectCommandV2, projectCommandSchemaV2 } from "./project-commands-v2.js";
import {
  type VideoProjectStateV2,
  videoProjectSnapshotV2Schema,
  videoProjectStateV2Schema,
} from "./project-v2.js";
import { describe, expect, it } from "vitest";

import {
  applyGraphicsGroup,
  type GraphicsCommand,
  isGraphicsCommand,
} from "./graphics-commands.js";

const fixturesUrl = new URL("../fixtures/", import.meta.url);
const readFixture = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, fixturesUrl), "utf8"));

interface GraphicsCommandsContract {
  readonly base: string;
  readonly sequenceIndex: number;
  readonly trackIndex: number;
  readonly cases: readonly {
    readonly name: string;
    readonly commands: readonly unknown[];
    readonly expectedGraphicsClips: readonly unknown[];
  }[];
  readonly invalid: readonly {
    readonly name: string;
    readonly commands: readonly unknown[];
    readonly category: string;
    readonly code: "invalid_command" | "invalid_project";
    readonly lockTrack?: boolean;
  }[];
  readonly invalidWire: readonly { readonly name: string; readonly command: unknown }[];
}

// Test-owned fixture file; every command and the base project are schema-parsed below.
const contract = readFixture("graphics-commands.json") as GraphicsCommandsContract;

const base = videoProjectSnapshotV2Schema.parse(readFixture(contract.base)).state;
const inverseId = (commandId: string, ordinal: number): string =>
  `${commandId.slice(0, 24)}${String(ordinal).padStart(12, "0")}`;

function graphicsCommands(values: readonly unknown[]): GraphicsCommand[] {
  return values.map((value) => {
    const command: ProjectCommandV2 = projectCommandSchemaV2.parse(value);
    if (!isGraphicsCommand(command)) throw new Error(`not a graphics command: ${command.type}`);
    return command;
  });
}

function graphicsClipsOf(state: VideoProjectStateV2): unknown {
  const track = state.sequences[contract.sequenceIndex]?.tracks[contract.trackIndex];
  if (track?.kind !== "graphics") throw new Error("fixture track is not a graphics track");
  return track.graphicsClips;
}

describe("graphics commands contract (shared with Rust)", () => {
  it.each(contract.cases)("$name: apply, undo and redo", ({ commands, expectedGraphicsClips }) => {
    const forward = graphicsCommands(commands);

    const applied = applyGraphicsGroup(base, forward, inverseId);
    if (!applied.ok) throw new Error(`apply failed: ${applied.category}`);
    const undone = applyGraphicsGroup(applied.state, applied.inverse, inverseId);
    if (!undone.ok) throw new Error(`undo failed: ${undone.category}`);
    const redone = applyGraphicsGroup(undone.state, forward, inverseId);
    if (!redone.ok) throw new Error(`redo failed: ${redone.category}`);

    expect(graphicsClipsOf(applied.state)).toEqual(expectedGraphicsClips);
    expect(JSON.stringify(undone.state)).toBe(JSON.stringify(base));
    expect(redone.state).toEqual(applied.state);
    expect(videoProjectStateV2Schema.safeParse(applied.state).success).toBe(true);
  });

  it.each(contract.invalid)(
    "$name is refused with $category",
    ({ commands, category, code, lockTrack }) => {
      const state = structuredClone(base);
      const track = state.sequences[contract.sequenceIndex]?.tracks[contract.trackIndex];
      if (lockTrack === true && track !== undefined) track.locked = true;

      const result = applyGraphicsGroup(state, graphicsCommands(commands), inverseId);

      expect(result).toEqual({ ok: false, code, category });
    },
  );

  it.each(contract.invalidWire)("$name is rejected at the schema boundary", ({ command }) => {
    expect(projectCommandSchemaV2.safeParse(command).success).toBe(false);
  });
});
