import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseVideoProjectFile } from "./migrations.js";
import {
  commandGroupRequestSchema,
  projectCommandSchemaV2,
  setClipOpacityCommandSchemaV2,
  setTrackHiddenCommandSchemaV2,
  setTrackLockedCommandSchemaV2,
  setTrackMutedCommandSchemaV2,
} from "./project-commands-v2.js";
import {
  canToggleTrackVisibility,
  clipTransformSchema,
  isTrackHidden,
  isTrackLocked,
  isTrackMuted,
  projectHistoryEntryV2Schema,
  projectTrackSchema,
  videoProjectSnapshotV2Schema,
} from "./project-v2.js";
import {
  commandResultSchema,
  projectProjectionSchema,
  recoveryReportSchema,
} from "./project-service.js";

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

  it("preserves legacy tracks without a lock field while treating them as unlocked", () => {
    const legacyTracks = [
      { id: ids.project, name: "Video", kind: "video", clips: [] },
      { id: ids.project, name: "Audio", kind: "audio", clips: [] },
      { id: ids.project, name: "Captions", kind: "caption", captions: [] },
    ] as const;

    for (const legacyTrack of legacyTracks) {
      const parsed = projectTrackSchema.parse(legacyTrack);
      expect(parsed).toEqual(legacyTrack);
      expect(Object.hasOwn(parsed, "locked")).toBe(false);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(legacyTrack);
      expect(isTrackLocked(parsed)).toBe(false);

      for (const locked of [false, true]) {
        const persisted = projectTrackSchema.parse({ ...legacyTrack, locked });
        expect(persisted).toEqual({ ...legacyTrack, locked });
        expect(isTrackLocked(persisted)).toBe(locked);
      }
    }
  });

  it("preserves legacy tracks without mute state and restricts mute to AV tracks", () => {
    const legacyTracks = [
      { id: ids.project, name: "Video", kind: "video", clips: [] },
      { id: ids.operation, name: "Audio", kind: "audio", clips: [] },
      { id: ids.revision, name: "Captions", kind: "caption", captions: [] },
    ] as const;

    for (const legacyTrack of legacyTracks) {
      const parsed = projectTrackSchema.parse(legacyTrack);
      expect(parsed).toEqual(legacyTrack);
      expect(Object.hasOwn(parsed, "muted")).toBe(false);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(legacyTrack);
      expect(isTrackMuted(parsed)).toBe(false);

      if (legacyTrack.kind !== "caption") {
        for (const muted of [false, true]) {
          const persisted = projectTrackSchema.parse({ ...legacyTrack, muted });
          expect(persisted).toEqual({ ...legacyTrack, muted });
          expect(isTrackMuted(persisted)).toBe(muted);
        }
      }
    }

    const caption = legacyTracks[2];
    expect(projectTrackSchema.safeParse({ ...caption, muted: false }).success).toBe(false);
    expect(projectTrackSchema.safeParse({ ...caption, muted: true }).success).toBe(false);
  });

  it("preserves shown defaults and restricts visibility to visual tracks", () => {
    const visualTracks = [
      { id: ids.project, name: "Video", kind: "video" as const, clips: [] },
      { id: ids.revision, name: "Captions", kind: "caption" as const, captions: [] },
    ];

    for (const legacyTrack of visualTracks) {
      const parsed = projectTrackSchema.parse(legacyTrack);
      expect(parsed).toEqual(legacyTrack);
      expect(Object.hasOwn(parsed, "hidden")).toBe(false);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(legacyTrack);
      expect(isTrackHidden(parsed)).toBe(false);
      expect(canToggleTrackVisibility(parsed)).toBe(true);

      for (const hidden of [false, true]) {
        const persisted = projectTrackSchema.parse({ ...legacyTrack, hidden });
        expect(persisted).toEqual({ ...legacyTrack, hidden });
        expect(isTrackHidden(persisted)).toBe(hidden);
      }
    }

    const audio = {
      id: ids.operation,
      name: "Audio",
      kind: "audio" as const,
      clips: [],
    };
    const parsedAudio = projectTrackSchema.parse(audio);
    expect(isTrackHidden(parsedAudio)).toBe(false);
    expect(canToggleTrackVisibility(parsedAudio)).toBe(false);
    expect(projectTrackSchema.safeParse({ ...audio, hidden: false }).success).toBe(false);
    expect(projectTrackSchema.safeParse({ ...audio, hidden: true }).success).toBe(false);
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

  it("parses bounded SetClipOpacity commands and enforces canonical opacity bounds", () => {
    const opacityCommand = {
      type: "SetClipOpacity" as const,
      commandId: ids.command,
      sequenceId: ids.project,
      trackId: ids.operation,
      clipId: ids.revision,
      opacityPermille: 425,
    };

    expect(setClipOpacityCommandSchemaV2.parse(opacityCommand)).toEqual(opacityCommand);
    expect(projectCommandSchemaV2.parse(opacityCommand)).toEqual(opacityCommand);
    expect(
      commandGroupRequestSchema.parse({
        groupId: ids.group,
        projectId: ids.project,
        baseRevision: 0,
        commands: [opacityCommand],
      }).commands,
    ).toEqual([opacityCommand]);

    for (const opacityPermille of [0, 1_000]) {
      expect(setClipOpacityCommandSchemaV2.parse({ ...opacityCommand, opacityPermille })).toEqual({
        ...opacityCommand,
        opacityPermille,
      });
    }

    for (const opacityPermille of [-1, 1_001, 0.5, "500", Number.NaN]) {
      expect(
        setClipOpacityCommandSchemaV2.safeParse({ ...opacityCommand, opacityPermille }).success,
      ).toBe(false);
    }
    for (const idField of ["commandId", "sequenceId", "trackId", "clipId"] as const) {
      expect(
        setClipOpacityCommandSchemaV2.safeParse({ ...opacityCommand, [idField]: "not-a-uuid" })
          .success,
      ).toBe(false);
    }
    expect(
      setClipOpacityCommandSchemaV2.safeParse({ ...opacityCommand, transform: {} }).success,
    ).toBe(false);

    const transform = {
      positionXPermille: 125,
      positionYPermille: -250,
      scaleXPermille: 1_250,
      scaleYPermille: 750,
      rotationMilliDegrees: 45_000,
      opacityPermille: 425,
    };
    for (const opacityPermille of [0, 1_000]) {
      expect(clipTransformSchema.parse({ ...transform, opacityPermille })).toEqual({
        ...transform,
        opacityPermille,
      });
    }
    for (const opacityPermille of [-1, 1_001, 0.5]) {
      expect(clipTransformSchema.safeParse({ ...transform, opacityPermille }).success).toBe(false);
    }
  });

  it("validates SetTrackLocked as a public command accepted by groups and history", () => {
    const lockCommand = {
      type: "SetTrackLocked" as const,
      commandId: ids.command,
      sequenceId: ids.project,
      trackId: ids.operation,
      locked: true,
    };
    const unlockCommand = { ...lockCommand, locked: false };

    expect(setTrackLockedCommandSchemaV2.parse(lockCommand)).toEqual(lockCommand);
    expect(projectCommandSchemaV2.parse(lockCommand)).toEqual(lockCommand);
    expect(
      commandGroupRequestSchema.parse({
        groupId: ids.group,
        projectId: ids.project,
        baseRevision: 0,
        commands: [lockCommand],
      }).commands,
    ).toEqual([lockCommand]);

    const historyEntry = {
      groupId: ids.group,
      summary: "Locked track",
      forwardCommands: [lockCommand],
      inverseCommands: [unlockCommand],
      affectedRanges: [],
      cacheInvalidations: ["timeline" as const],
    };
    expect(projectHistoryEntryV2Schema.parse(historyEntry)).toEqual(historyEntry);

    expect(
      setTrackLockedCommandSchemaV2.safeParse({ ...lockCommand, locked: "true" }).success,
    ).toBe(false);
    expect(
      setTrackLockedCommandSchemaV2.safeParse({ ...lockCommand, visible: false }).success,
    ).toBe(false);
    expect(
      setTrackLockedCommandSchemaV2.safeParse({
        type: "SetTrackLocked",
        commandId: ids.command,
        sequenceId: ids.project,
        trackId: ids.operation,
      }).success,
    ).toBe(false);
  });

  it("validates strict SetTrackMuted commands in public groups and history", () => {
    const muteCommand = {
      type: "SetTrackMuted" as const,
      commandId: ids.command,
      sequenceId: ids.project,
      trackId: ids.operation,
      muted: true,
    };
    const unmuteCommand = { ...muteCommand, muted: false };

    expect(setTrackMutedCommandSchemaV2.parse(muteCommand)).toEqual(muteCommand);
    expect(projectCommandSchemaV2.parse(muteCommand)).toEqual(muteCommand);
    expect(
      commandGroupRequestSchema.parse({
        groupId: ids.group,
        projectId: ids.project,
        baseRevision: 0,
        commands: [muteCommand],
      }).commands,
    ).toEqual([muteCommand]);

    const historyEntry = {
      groupId: ids.group,
      summary: "Muted track",
      forwardCommands: [muteCommand],
      inverseCommands: [unmuteCommand],
      affectedRanges: [],
      cacheInvalidations: ["timeline" as const, "audio_mix" as const],
    };
    expect(projectHistoryEntryV2Schema.parse(historyEntry)).toEqual(historyEntry);

    expect(setTrackMutedCommandSchemaV2.safeParse({ ...muteCommand, muted: "true" }).success).toBe(
      false,
    );
    expect(setTrackMutedCommandSchemaV2.safeParse({ ...muteCommand, audible: false }).success).toBe(
      false,
    );
    expect(
      setTrackMutedCommandSchemaV2.safeParse({
        type: "SetTrackMuted",
        commandId: ids.command,
        sequenceId: ids.project,
        trackId: ids.operation,
      }).success,
    ).toBe(false);
    expect(
      setTrackMutedCommandSchemaV2.safeParse({ ...muteCommand, trackId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("validates strict SetTrackHidden commands in public groups and history", () => {
    const hideCommand = {
      type: "SetTrackHidden" as const,
      commandId: ids.command,
      sequenceId: ids.project,
      trackId: ids.operation,
      hidden: true,
    };
    const showCommand = { ...hideCommand, hidden: false };

    expect(setTrackHiddenCommandSchemaV2.parse(hideCommand)).toEqual(hideCommand);
    expect(projectCommandSchemaV2.parse(hideCommand)).toEqual(hideCommand);
    expect(
      commandGroupRequestSchema.parse({
        groupId: ids.group,
        projectId: ids.project,
        baseRevision: 0,
        commands: [hideCommand],
      }).commands,
    ).toEqual([hideCommand]);

    const historyEntry = {
      groupId: ids.group,
      summary: "Hid track",
      forwardCommands: [hideCommand],
      inverseCommands: [showCommand],
      affectedRanges: [],
      cacheInvalidations: [
        "timeline" as const,
        "preview" as const,
        "captions" as const,
        "render_plan" as const,
      ],
    };
    expect(projectHistoryEntryV2Schema.parse(historyEntry)).toEqual(historyEntry);

    expect(
      setTrackHiddenCommandSchemaV2.safeParse({ ...hideCommand, hidden: "true" }).success,
    ).toBe(false);
    expect(
      setTrackHiddenCommandSchemaV2.safeParse({ ...hideCommand, visible: false }).success,
    ).toBe(false);
    expect(
      setTrackHiddenCommandSchemaV2.safeParse({
        type: "SetTrackHidden",
        commandId: ids.command,
        sequenceId: ids.project,
        trackId: ids.operation,
      }).success,
    ).toBe(false);
    expect(
      setTrackHiddenCommandSchemaV2.safeParse({ ...hideCommand, trackId: "not-a-uuid" }).success,
    ).toBe(false);
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

  it("validates muted state through projections and command results", () => {
    const state = {
      assets: [],
      sequences: [
        {
          id: ids.revision,
          name: "Sequence",
          rate: { numerator: 30, denominator: 1 },
          width: 1920,
          height: 1080,
          audioSampleRate: 48_000,
          tracks: [
            {
              id: ids.operation,
              name: "Camera",
              kind: "video" as const,
              muted: true,
              clips: [],
            },
          ],
          markers: [],
        },
      ],
      activeSequenceId: ids.revision,
    };
    const newRevision = {
      ...snapshot().revision,
      number: 1,
      id: ids.generation,
      parentId: ids.revision,
    };
    const projection = {
      projectId: ids.project,
      name: "Canonical fixture",
      revision: newRevision,
      state,
      canUndo: true,
      canRedo: false,
      lastCommand: { operationId: ids.operation, groupId: ids.group, summary: "Muted track" },
      sources: [],
      journalHealth: "healthy" as const,
      snapshotRevision: 0,
      recoveryStatus: "clean" as const,
      replayedRecordCount: 1,
    };
    const result = {
      projectId: ids.project,
      operationId: ids.operation,
      groupId: ids.group,
      priorRevision: snapshot().revision,
      newRevision,
      stateHash: hash,
      projection,
      affectedRanges: [],
      cacheInvalidations: ["timeline" as const, "audio_mix" as const],
      events: [],
    };

    expect(projectProjectionSchema.parse(projection)).toEqual(projection);
    expect(commandResultSchema.parse(result)).toEqual(result);
    expect(() =>
      projectProjectionSchema.parse({ ...projection, journalPath: "C:\\private" }),
    ).toThrow();
  });

  it("validates recovery reports without private storage fields", () => {
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
