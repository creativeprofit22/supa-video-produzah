import {
  VideoDomainError,
  createRationalRate,
  createRationalTime,
  type VideoAsset,
  type VideoClip,
  type VideoProjectCommand,
  type VideoProjectFileV1,
  type VideoSequence,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { createProject } from "./create-project.js";
import { currentRevision, executeCommand } from "./execute-command.js";
import { canRedo, canUndo, commit, createHistory, redo, undo } from "./history.js";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const createdAt = "2026-07-24T12:00:00.000Z";
const rate = createRationalRate(30, 1);

function asset(): VideoAsset {
  return {
    id: id(10),
    displayName: "clip.mp4",
    locator: { relativePath: "clip.mp4" },
    probe: {
      durationMicroseconds: 4_000_000,
      averageFrameRate: rate,
      realFrameRate: rate,
      variableFrameRate: false,
      width: 640,
      height: 360,
      videoCodecName: "h264",
      audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
      fileSizeBytes: 50_000,
    },
  };
}

function sequence(sequenceRate = rate): VideoSequence {
  return {
    id: id(20),
    rate: sequenceRate,
    width: 640,
    height: 360,
    audioSampleRate: 48_000,
    videoTracks: [{ id: id(21), clips: [] }],
  };
}

function clip(sourceIn = 0, sourceOut = 120): VideoClip {
  return {
    id: id(30),
    assetId: id(10),
    timelineStart: createRationalTime(0, rate),
    sourceIn: createRationalTime(sourceIn, rate),
    sourceOut: createRationalTime(sourceOut, rate),
  };
}

function emptyProject(): Readonly<VideoProjectFileV1> {
  return createProject({
    projectId: id(1),
    initialRevisionId: id(2),
    name: "Test project",
    createdAt,
  });
}

type CommandDraft<T = VideoProjectCommand> = T extends VideoProjectCommand
  ? Omit<T, "commandId" | "baseRevisionId" | "issuedAt">
  : never;

function command(
  value: CommandDraft,
  document: Readonly<VideoProjectFileV1>,
  commandId: string,
): VideoProjectCommand {
  return {
    ...value,
    commandId,
    baseRevisionId: document.currentRevisionId,
    issuedAt: `2026-07-24T12:00:${commandId.slice(-2)}.000Z`,
  } as VideoProjectCommand;
}

function withAsset(document = emptyProject(), commandId = id(3)): Readonly<VideoProjectFileV1> {
  return executeCommand(
    document,
    command({ type: "ImportAsset", asset: asset() }, document, commandId),
  );
}

function withSequence(document = withAsset(), commandId = id(4)): Readonly<VideoProjectFileV1> {
  return executeCommand(
    document,
    command({ type: "CreateSequence", sequence: sequence() }, document, commandId),
  );
}

function withClip(document = withSequence(), commandId = id(5)): Readonly<VideoProjectFileV1> {
  const nextClip = clip();
  return executeCommand(
    document,
    command(
      {
        type: "InsertClip",
        sequenceId: id(20),
        trackId: id(21),
        clip: nextClip,
      },
      document,
      commandId,
    ),
  );
}

describe("project commands", () => {
  it("creates an immutable project and executes the four-command path", () => {
    const imported = withAsset();
    const sequenced = withSequence(imported);
    const inserted = withClip(sequenced);
    const originalAsset = currentRevision(inserted).state.asset;
    const trimmed = executeCommand(
      inserted,
      command(
        {
          type: "TrimClip",
          sequenceId: id(20),
          trackId: id(21),
          clipId: id(30),
          sourceIn: createRationalTime(15, rate),
          sourceOut: createRationalTime(90, rate),
        },
        inserted,
        id(6),
      ),
    );
    const state = currentRevision(trimmed).state;
    expect(trimmed.revisions).toHaveLength(5);
    expect(state.sequence?.videoTracks[0].clips[0]?.sourceIn.value).toBe(15);
    expect(state.asset?.id).toBe(originalAsset?.id);
    expect(Object.isFrozen(trimmed)).toBe(true);
    expect(Object.isFrozen(state.sequence?.videoTracks[0].clips[0])).toBe(true);
  });

  it("rejects stale bases and duplicate command IDs", () => {
    const document = withAsset();
    const stale = command({ type: "CreateSequence", sequence: sequence() }, document, id(4));
    expect(() => executeCommand(document, { ...stale, baseRevisionId: id(2) })).toThrowError(
      VideoDomainError,
    );
    expect(() => executeCommand(document, { ...stale, commandId: id(3) })).toThrow(
      "already been committed",
    );
  });

  it("enforces one asset, sequence, track, and clip", () => {
    const imported = withAsset();
    expect(() =>
      executeCommand(
        imported,
        command({ type: "ImportAsset", asset: { ...asset(), id: id(11) } }, imported, id(4)),
      ),
    ).toThrow("exactly one imported asset");
    const inserted = withClip();
    expect(() =>
      executeCommand(
        inserted,
        command(
          {
            type: "InsertClip",
            sequenceId: id(20),
            trackId: id(21),
            clip: { ...clip(), id: id(31) },
          },
          inserted,
          id(6),
        ),
      ),
    ).toThrow("exactly one clip");
  });

  it("rejects mixed rates, missing references, empty and out-of-source trims", () => {
    const imported = withAsset();
    expect(() =>
      executeCommand(
        imported,
        command(
          { type: "CreateSequence", sequence: sequence(createRationalRate(25, 1)) },
          imported,
          id(4),
        ),
      ),
    ).toThrow("average rate");

    const inserted = withClip();
    const baseTrim = command(
      {
        type: "TrimClip",
        sequenceId: id(20),
        trackId: id(21),
        clipId: id(30),
        sourceIn: createRationalTime(10, rate),
        sourceOut: createRationalTime(20, rate),
      },
      inserted,
      id(6),
    );
    expect(() => executeCommand(inserted, { ...baseTrim, clipId: id(99) })).toThrow(
      "unknown sequence, track, or clip",
    );
    expect(() =>
      executeCommand(inserted, {
        ...baseTrim,
        sourceOut: createRationalTime(10, rate),
      }),
    ).toThrow("at least one");
    expect(() =>
      executeCommand(inserted, {
        ...baseTrim,
        sourceOut: createRationalTime(121, rate),
      }),
    ).toThrow("exceeds");
  });
});

describe("immutable history", () => {
  it("undoes, redoes, and truncates a branch after a new commit", () => {
    const inserted = withClip();
    const history = createHistory(inserted);
    const undone = undo(history);
    expect(canUndo(undone)).toBe(true);
    expect(canRedo(undone)).toBe(true);
    expect(currentRevision(undone.document).state.sequence?.videoTracks[0].clips).toHaveLength(0);
    expect(redo(undone).document.currentRevisionId).toBe(inserted.currentRevisionId);

    const branched = commit(
      undone,
      command(
        {
          type: "InsertClip",
          sequenceId: id(20),
          trackId: id(21),
          clip: { ...clip(10, 100), id: id(31) },
        },
        undone.document,
        id(7),
      ),
    );
    expect(branched.document.revisions).toHaveLength(4);
    expect(canRedo(branched)).toBe(false);
    expect(branched.document.currentRevisionId).toBe(id(7));
  });
});
