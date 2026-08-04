import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseVideoProjectFile } from "./migrations.js";
import { commandGroupRequestSchema, projectCommandSchemaV2 } from "./project-commands-v2.js";
import { projectHistoryEntryV2Schema, videoProjectSnapshotV2Schema } from "./project-v2.js";
import { projectProjectionSchema, recoveryReportSchema } from "./project-service.js";

const ids = {
  project: "00000000-0000-4000-8000-000000000001",
  revision: "00000000-0000-4000-8000-000000000002",
  operation: "00000000-0000-4000-8000-000000000003",
  generation: "00000000-0000-4000-8000-000000000004",
  group: "00000000-0000-4000-8000-000000000005",
  command: "00000000-0000-4000-8000-000000000006",
} as const;
const timestamp = "2026-07-26T12:00:00.000Z";
const hash = "0".repeat(64);
const legacyImportCommand = {
  type: "ImportAsset" as const,
  commandId: ids.command,
  asset: {
    id: ids.operation,
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
};

function snapshot() {
  return {
    schemaVersion: 2 as const,
    id: ids.project,
    name: "Canonical fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    storageGenerationId: ids.generation,
    revision: {
      number: 0,
      id: ids.revision,
      parentId: null,
      committedAt: timestamp,
      operationId: ids.operation,
      stateHash: hash,
    },
    state: { assets: [], sequences: [], activeSequenceId: null },
    history: { undoStack: [], redoStack: [] },
    lastAppliedRecordNumber: 0,
    lastRecordHash: hash,
  };
}
interface ManifestMutation {
  pointer: string;
  value?: unknown;
  repeatString?: { value: string; count: number };
  repeatArray?: { value: unknown; count: number };
}

function applyManifestMutation(input: unknown, mutation: ManifestMutation): void {
  let replacement: unknown;
  if (mutation.repeatString !== undefined) {
    replacement = mutation.repeatString.value.repeat(mutation.repeatString.count);
  } else if (mutation.repeatArray !== undefined) {
    replacement = Array.from({ length: mutation.repeatArray.count }, () =>
      structuredClone(mutation.repeatArray!.value),
    );
  } else {
    replacement = structuredClone(mutation.value);
  }

  const segments = mutation.pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let target = input as Record<string, unknown> | unknown[];
  for (const segment of segments.slice(0, -1)) {
    target = (target as Record<string, Record<string, unknown> | unknown[]>)[segment]!;
  }
  const key = segments.at(-1)!;
  if (Array.isArray(target) && key === "-") {
    target.push(replacement);
  } else {
    (target as Record<string, unknown>)[key] = replacement;
  }
}

describe("V2 project contracts", () => {
  it("matches the shared V2 fixture manifest", async () => {
    const manifestUrl = new URL("../fixtures/project-v2/manifest.json", import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
      cases: Array<{
        name: string;
        path: string;
        expected: "valid" | "invalid_project" | "unsupported_schema";
        mutations?: ManifestMutation[];
        rehashState?: boolean;
      }>;
    };
    for (const fixture of manifest.cases) {
      const input = JSON.parse(
        await readFile(new URL(fixture.path, manifestUrl), "utf8"),
      ) as unknown;
      for (const mutation of fixture.mutations ?? []) applyManifestMutation(input, mutation);
      try {
        parseVideoProjectFile(input);
        expect(fixture.expected, fixture.name).toBe("valid");
      } catch (error) {
        expect((error as { code?: string }).code, fixture.name).toBe(fixture.expected);
      }
    }
  });

  it("dispatches strict V1 and V2 projects while rejecting future versions", () => {
    expect(parseVideoProjectFile(snapshot())).toEqual(snapshot());
    expect(() => videoProjectSnapshotV2Schema.parse({ ...snapshot(), extra: true })).toThrow();
    expect(() => parseVideoProjectFile({ schemaVersion: 3 })).toThrow("schema 3");
  });

  it("rejects dangling clip asset and sequence references", async () => {
    const fixtureUrl = new URL(
      "../fixtures/project-v2/valid-relative-source.svpvideo",
      import.meta.url,
    );
    const fixture = videoProjectSnapshotV2Schema.parse(
      JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown,
    );
    const track = fixture.state.sequences[0]!.tracks[0]!;
    if (track.kind === "caption") throw new Error("Expected clip track fixture");

    const danglingAsset = structuredClone(fixture);
    const danglingAssetTrack = danglingAsset.state.sequences[0]!.tracks[0]!;
    if (danglingAssetTrack.kind === "caption") throw new Error("Expected clip track fixture");
    danglingAssetTrack.clips[0]!.source = { kind: "asset", assetId: ids.project };
    expect(videoProjectSnapshotV2Schema.safeParse(danglingAsset).success).toBe(false);

    const danglingSequence = structuredClone(fixture);
    const danglingSequenceTrack = danglingSequence.state.sequences[0]!.tracks[0]!;
    if (danglingSequenceTrack.kind === "caption") throw new Error("Expected clip track fixture");
    danglingSequenceTrack.clips[0]!.source = { kind: "sequence", sequenceId: ids.project };
    expect(videoProjectSnapshotV2Schema.safeParse(danglingSequence).success).toBe(false);
  });

  it("accepts authority-free command groups and rejects authority metadata", () => {
    const command = {
      type: "RemoveMarker" as const,
      commandId: ids.command,
      sequenceId: ids.project,
      markerId: ids.operation,
    };
    expect(projectCommandSchemaV2.parse(command)).toEqual(command);
    const request = {
      groupId: ids.group,
      projectId: ids.project,
      baseRevision: 0,
      commands: [command],
    };
    expect(commandGroupRequestSchema.parse(request)).toEqual(request);
    expect(() => commandGroupRequestSchema.parse({ ...request, committedAt: timestamp })).toThrow();
    expect(() => projectCommandSchemaV2.parse({ ...command, summary: "caller owned" })).toThrow();
  });

  it("accepts ripple delete while keeping its restore command private to history", async () => {
    const fixtureUrl = new URL(
      "../fixtures/project-v2/valid-relative-source.svpvideo",
      import.meta.url,
    );
    const fixture = videoProjectSnapshotV2Schema.parse(
      JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown,
    );
    const sequence = fixture.state.sequences[0]!;
    const track = sequence.tracks[0]!;
    if (track.kind === "caption") throw new Error("Expected clip track fixture");
    const clip = track.clips[0]!;
    const rippleDelete = {
      type: "RippleDeleteClip" as const,
      commandId: ids.command,
      sequenceId: sequence.id,
      trackId: track.id,
      clipId: clip.id,
    };
    const restore = {
      type: "RestoreRippleDeletedClip" as const,
      commandId: ids.command,
      sequenceId: sequence.id,
      trackId: track.id,
      index: 0,
      clip,
    };

    expect(projectCommandSchemaV2.parse(rippleDelete)).toEqual(rippleDelete);
    expect(projectCommandSchemaV2.parse(restore)).toEqual(restore);
    const historyEntry = {
      groupId: ids.group,
      summary: "Ripple deleted clip",
      forwardCommands: [rippleDelete],
      inverseCommands: [restore],
      affectedRanges: [],
      cacheInvalidations: ["timeline" as const],
    };
    expect(projectHistoryEntryV2Schema.parse(historyEntry)).toEqual(historyEntry);
    expect(
      projectHistoryEntryV2Schema.safeParse({
        ...historyEntry,
        forwardCommands: [restore],
        inverseCommands: [rippleDelete],
      }).success,
    ).toBe(false);
    expect(
      commandGroupRequestSchema.safeParse({
        groupId: ids.group,
        projectId: ids.project,
        baseRevision: 0,
        commands: [rippleDelete],
      }).success,
    ).toBe(true);
    expect(
      commandGroupRequestSchema.safeParse({
        groupId: ids.group,
        projectId: ids.project,
        baseRevision: 0,
        commands: [restore],
      }).success,
    ).toBe(false);
    expect(() => projectCommandSchemaV2.parse({ ...restore, index: -1 })).toThrow();
  });

  it("requires content identity only for live import groups", async () => {
    expect(projectCommandSchemaV2.parse(legacyImportCommand)).toEqual(legacyImportCommand);

    const liveRequest = commandGroupRequestSchema.safeParse({
      groupId: ids.group,
      projectId: ids.project,
      baseRevision: 0,
      commands: [legacyImportCommand],
    });
    expect(liveRequest.success).toBe(false);
    if (liveRequest.success) throw new Error("Expected a missing import identity to fail");
    expect(liveRequest.error.issues).toContainEqual(
      expect.objectContaining({ path: ["commands", 0, "asset", "contentIdentity"] }),
    );

    const fixtureUrl = new URL(
      "../fixtures/project-v2/valid-relative-source.svpvideo",
      import.meta.url,
    );
    const legacyProject = parseVideoProjectFile(
      JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown,
    );
    expect(legacyProject.schemaVersion).toBe(2);
    if (legacyProject.schemaVersion !== 2) throw new Error("Expected a V2 legacy fixture");
    expect(legacyProject.state.assets[0]?.contentIdentity).toBeUndefined();
  });

  it("preserves index and active-sequence fields used by semantic inverses", async () => {
    const fixtureUrl = new URL(
      "../fixtures/project-v2/valid-relative-source.svpvideo",
      import.meta.url,
    );
    const fixture = videoProjectSnapshotV2Schema.parse(
      JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown,
    );
    const asset = fixture.state.assets[0]!;
    const sequence = fixture.state.sequences[0]!;
    const track = sequence.tracks[0]!;
    if (track.kind === "caption") throw new Error("Expected clip track fixture");
    const clip = track.clips[0]!;
    const indexedCommands = [
      { type: "ImportAsset", commandId: ids.command, index: 2, asset },
      {
        type: "CreateSequence",
        commandId: ids.command,
        index: 1,
        activeSequenceId: sequence.id,
        sequence,
      },
      {
        type: "InsertClip",
        commandId: ids.command,
        sequenceId: sequence.id,
        trackId: track.id,
        index: 3,
        clip,
      },
      {
        type: "AddMarker",
        commandId: ids.command,
        sequenceId: sequence.id,
        index: 4,
        marker: { id: ids.operation, time: clip.timelineStart, label: "Restored marker" },
      },
      {
        type: "AddCaption",
        commandId: ids.command,
        sequenceId: sequence.id,
        trackId: track.id,
        index: 5,
        caption: {
          id: ids.operation,
          start: clip.timelineStart,
          end: clip.sourceOut,
          text: "Restored caption",
        },
      },
    ];
    for (const command of indexedCommands) {
      expect(projectCommandSchemaV2.parse(command)).toEqual(command);
    }
    expect(() => projectCommandSchemaV2.parse({ ...indexedCommands[0], index: -1 })).toThrow();
  });

  it("validates projections and recovery reports without private storage fields", () => {
    const projection = {
      projectId: ids.project,
      name: "Canonical fixture",
      revision: snapshot().revision,
      state: snapshot().state,
      canUndo: false,
      canRedo: false,
      lastCommand: null,
      sources: [],
      journalHealth: "healthy" as const,
      snapshotRevision: 0,
      recoveryStatus: "clean" as const,
      replayedRecordCount: 0,
    };
    expect(projectProjectionSchema.parse(projection)).toEqual(projection);
    expect(() =>
      projectProjectionSchema.parse({ ...projection, journalPath: "C:\\private" }),
    ).toThrow();
    expect(
      recoveryReportSchema.parse({
        status: "migrated_v1",
        recoveredRevision: 0,
        replayedRecordCount: 0,
        discardedTailBytes: 0,
        message: "Current state migrated; legacy history reset.",
        legacyHistoryReset: true,
      }),
    ).toBeTruthy();
  });
});
