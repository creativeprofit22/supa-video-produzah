import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import type { CaptionArtifactV1 } from "./caption.js";
import { commandGroupRequestSchema, projectCommandSchemaV2 } from "./project-commands-v2.js";
import {
  projectHistoryEntryV2Schema,
  projectTrackSchema,
  videoProjectSnapshotV2Schema,
} from "./project-v2.js";

const ids = {
  project: "11111111-1111-4111-8111-111111111111",
  revision: "22222222-2222-4222-8222-222222222222",
  operation: "33333333-3333-4333-8333-333333333333",
  sequence: "44444444-4444-4444-8444-444444444444",
  track: "55555555-5555-4555-8555-555555555555",
  generation: "66666666-6666-4666-8666-666666666666",
  group: "77777777-7777-4777-8777-777777777777",
  command: "88888888-8888-4888-8888-888888888888",
  inverseCommand: "99999999-9999-4999-8999-999999999999",
  caption: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const timestamp = "2026-08-08T00:00:00.000Z";
const hash = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

let fixture: CaptionArtifactV1;

beforeAll(async () => {
  fixture = JSON.parse(
    await readFile(
      new URL("../../video-media/fixtures/caption-artifact-v1.json", import.meta.url),
      "utf8",
    ),
  ) as CaptionArtifactV1;
});

function applyCommand(artifact: unknown = fixture) {
  return {
    type: "ApplyCaptionArtifact" as const,
    commandId: ids.command,
    sequenceId: ids.sequence,
    trackId: ids.track,
    artifact,
  };
}

function restoreCommand(artifact?: unknown) {
  return {
    type: "RestoreActiveCaptionArtifact" as const,
    commandId: ids.inverseCommand,
    sequenceId: ids.sequence,
    trackId: ids.track,
    ...(artifact === undefined ? {} : { artifact }),
  };
}

function legacyCaption() {
  return {
    id: ids.caption,
    start: { value: 0, rateNumerator: 24, rateDenominator: 1 },
    end: { value: 24, rateNumerator: 24, rateDenominator: 1 },
    text: "A legacy, manually authored caption",
    language: "en-US",
  };
}

function snapshot(activeArtifact?: unknown) {
  const artifact = arguments.length === 0 ? fixture : activeArtifact;
  const track = {
    id: ids.track,
    name: "Captions",
    kind: "caption" as const,
    captions: [legacyCaption()],
    ...(artifact === undefined ? {} : { activeCaptionArtifact: artifact }),
  };
  return {
    schemaVersion: 2 as const,
    id: ids.project,
    name: "Caption application fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    storageGenerationId: ids.generation,
    revision: fixture.trackLink.projectRevision,
    state: {
      assets: [],
      sequences: [
        {
          id: ids.sequence,
          name: "Main",
          rate: { numerator: 24, denominator: 1 },
          width: 1920,
          height: 1080,
          audioSampleRate: 48_000,
          tracks: [track],
          markers: [],
        },
      ],
      activeSequenceId: ids.sequence,
    },
    history: {
      undoStack: [
        {
          groupId: ids.group,
          summary: "Apply generated captions",
          forwardCommands: [applyCommand()],
          inverseCommands: [restoreCommand(fixture)],
          affectedRanges: [],
          cacheInvalidations: ["captions" as const, "render_plan" as const],
        },
      ],
      redoStack: [],
    },
    lastAppliedRecordNumber: 7,
    lastRecordHash: hash,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("caption artifact project application contracts", () => {
  it("accepts public ApplyCaptionArtifact commands and command groups", () => {
    expect(projectCommandSchemaV2.parse(applyCommand())).toEqual(applyCommand());
    expect(
      commandGroupRequestSchema.safeParse({
        groupId: ids.group,
        projectId: ids.project,
        baseRevision: 7,
        commands: [applyCommand()],
      }).success,
    ).toBe(true);
  });

  it("allows private RestoreActiveCaptionArtifact only in inverse history", () => {
    const entry = snapshot().history.undoStack[0]!;
    expect(projectHistoryEntryV2Schema.parse(entry)).toEqual(entry);

    expect(
      projectHistoryEntryV2Schema.safeParse({
        ...entry,
        forwardCommands: [restoreCommand(fixture)],
        inverseCommands: [applyCommand()],
      }).success,
    ).toBe(false);
  });

  it("accepts caption tracks with an active artifact present or absent", () => {
    const present = snapshot();
    const absent = snapshot(undefined);
    expect(videoProjectSnapshotV2Schema.safeParse(present).success).toBe(true);
    expect(videoProjectSnapshotV2Schema.safeParse(absent).success).toBe(true);
    expect(Object.hasOwn(absent.state.sequences[0]!.tracks[0]!, "activeCaptionArtifact")).toBe(
      false,
    );
  });

  it("round-trips the exact full snapshot JSON and artifact provenance", () => {
    const input = snapshot();
    const serialized = JSON.stringify(input);
    const parsed = videoProjectSnapshotV2Schema.parse(JSON.parse(serialized) as unknown);

    expect(JSON.stringify(parsed)).toBe(serialized);
    expect(parsed).toEqual(input);
    const track = parsed.state.sequences[0]!.tracks[0]!;
    expect(track.kind).toBe("caption");
    if (track.kind !== "caption") throw new Error("Expected caption track");
    expect(track.activeCaptionArtifact).toEqual(fixture);
    expect(track.activeCaptionArtifact!.trackLink.projectRevision).toEqual(
      fixture.trackLink.projectRevision,
    );
    expect(parsed.history.undoStack[0]!.forwardCommands[0]).toEqual(applyCommand());
    expect(parsed.history.undoStack[0]!.inverseCommands[0]).toEqual(restoreCommand(fixture));
  });

  it("leaves legacy ProjectCaption rows unchanged beside the active artifact", () => {
    const input = snapshot();
    const parsed = videoProjectSnapshotV2Schema.parse(input);
    const track = parsed.state.sequences[0]!.tracks[0]!;
    if (track.kind !== "caption") throw new Error("Expected caption track");

    expect(track.captions).toEqual([legacyCaption()]);
    expect(JSON.stringify(track.captions)).toBe(
      JSON.stringify(input.state.sequences[0]!.tracks[0]!.captions),
    );
  });

  it.each([
    ["malformed", (artifact: CaptionArtifactV1) => ({ ...artifact, cues: "not-an-array" })],
    ["unknown-version", (artifact: CaptionArtifactV1) => ({ ...artifact, schemaVersion: 2 })],
    [
      "semantic-cue-profile",
      (artifact: CaptionArtifactV1) => ({
        ...artifact,
        validationProfile: { ...artifact.validationProfile, maxCharactersPerLine: 5 },
      }),
    ],
  ])("rejects %s caption artifacts", (_name, mutate) => {
    expect(projectCommandSchemaV2.safeParse(applyCommand(mutate(clone(fixture)))).success).toBe(
      false,
    );
  });

  it("rejects cue timing that violates the artifact's semantic profile", () => {
    const artifact = clone(fixture);
    artifact.cues[1]!.start.value = 12;
    expect(projectCommandSchemaV2.safeParse(applyCommand(artifact)).success).toBe(false);
  });

  it.each([
    [
      "sequence",
      (artifact: CaptionArtifactV1) => {
        artifact.trackLink.sequenceId = ids.other;
      },
    ],
    [
      "track",
      (artifact: CaptionArtifactV1) => {
        artifact.trackLink.captionTrackId = ids.other;
      },
    ],
    [
      "project",
      (artifact: CaptionArtifactV1) => {
        artifact.trackLink.projectId = ids.other;
      },
    ],
    [
      "rate",
      (artifact: CaptionArtifactV1) => {
        artifact.timelineRate = { numerator: 12, denominator: 1 };
        for (const cue of artifact.cues) {
          cue.start.rateNumerator = 12;
          cue.end.rateNumerator = 12;
        }
      },
    ],
  ])("rejects an artifact linked to the wrong containing %s", (_name, mutate) => {
    const artifact = clone(fixture);
    mutate(artifact);
    expect(videoProjectSnapshotV2Schema.safeParse(snapshot(artifact)).success).toBe(false);
  });

  it.each(["sequenceId", "trackId"] as const)(
    "rejects wrong command target linkage through %s",
    (field) => {
      expect(
        projectCommandSchemaV2.safeParse({ ...applyCommand(), [field]: ids.other }).success,
      ).toBe(false);
      expect(
        projectCommandSchemaV2.safeParse({ ...restoreCommand(fixture), [field]: ids.other })
          .success,
      ).toBe(false);
    },
  );

  it("rejects direct submission of the private restore command", () => {
    expect(projectCommandSchemaV2.safeParse(restoreCommand()).success).toBe(true);
    expect(
      commandGroupRequestSchema.safeParse({
        groupId: ids.group,
        projectId: ids.project,
        baseRevision: 7,
        commands: [restoreCommand()],
      }).success,
    ).toBe(false);
  });

  it("preserves compatibility omissions without materializing new fields", () => {
    const legacyTrack = {
      id: ids.track,
      name: "Captions",
      kind: "caption" as const,
      captions: [legacyCaption()],
    };
    const parsedTrack = projectTrackSchema.parse(legacyTrack);
    expect(parsedTrack).toEqual(legacyTrack);
    expect(Object.hasOwn(parsedTrack, "activeCaptionArtifact")).toBe(false);
    expect(JSON.parse(JSON.stringify(parsedTrack))).toEqual(legacyTrack);

    const restore = projectCommandSchemaV2.parse(restoreCommand());
    expect(Object.hasOwn(restore, "artifact")).toBe(false);
    expect(restore).toEqual(restoreCommand());
  });
});
