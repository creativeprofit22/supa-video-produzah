import { describe, expect, it } from "vitest";

import { videoProjectCommandSchema } from "./commands.js";
import { VideoDomainError } from "./errors.js";
import { parseVideoProjectFile } from "./migrations.js";
import {
  assetLocatorSchema,
  type ProjectRevision,
  type VideoAsset,
  type VideoProjectFileV1,
  videoProjectFileV1Schema,
} from "./project.js";
import { renderPlanV1Schema } from "./render-plan.js";
import { createRationalRate, createRationalTime } from "./time.js";

const ids = {
  project: "00000000-0000-4000-8000-000000000001",
  revision: "00000000-0000-4000-8000-000000000002",
  asset: "00000000-0000-4000-8000-000000000003",
  command: "00000000-0000-4000-8000-000000000004",
  plan: "00000000-0000-4000-8000-000000000005",
} as const;
const timestamp = "2026-07-24T12:00:00.000Z";
const rate = createRationalRate(30_000, 1_001);

function makeAsset(): VideoAsset {
  return {
    id: ids.asset,
    displayName: "single-clip.mp4",
    locator: { relativePath: "single-clip.mp4", absolutePath: "C:\\Media\\single-clip.mp4" },
    probe: {
      durationMicroseconds: 4_000_000,
      averageFrameRate: rate,
      realFrameRate: rate,
      variableFrameRate: false,
      width: 640,
      height: 360,
      videoCodecName: "h264",
      audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
      fileSizeBytes: 100_000,
    },
  };
}

function makeProject(): VideoProjectFileV1 {
  const revision: ProjectRevision = {
    id: ids.revision,
    parentRevisionId: null,
    sequenceNumber: 0,
    committedAt: timestamp,
    commandSummary: "Created project",
    state: { asset: null, sequence: null },
  };
  return {
    schemaVersion: 1,
    id: ids.project,
    name: "Fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    currentRevisionId: revision.id,
    revisions: [revision],
  };
}

describe("project contracts", () => {
  it("accepts a strict linear V1 document", () => {
    expect(parseVideoProjectFile(makeProject())).toEqual(makeProject());
  });

  it("fails malformed, unknown, and future documents actionably", () => {
    expect(() => parseVideoProjectFile({})).toThrowError(VideoDomainError);
    expect(() => parseVideoProjectFile({ schemaVersion: 2 })).toThrow("schema 2");
    expect(() => videoProjectFileV1Schema.parse({ ...makeProject(), surprise: true })).toThrow();
  });

  it("requires safe source locators", () => {
    expect(() => assetLocatorSchema.parse({})).toThrow("requires");
    expect(() => assetLocatorSchema.parse({ relativePath: "../escape.mp4" })).toThrow("escape");
    expect(assetLocatorSchema.parse({ relativePath: "media/clip.mp4" })).toEqual({
      relativePath: "media/clip.mp4",
    });
  });

  it("accepts strict discriminated commands and rejects extras", () => {
    const command = {
      type: "ImportAsset",
      commandId: ids.command,
      baseRevisionId: ids.revision,
      issuedAt: timestamp,
      asset: makeAsset(),
    };
    expect(videoProjectCommandSchema.parse(command)).toEqual(command);
    expect(() => videoProjectCommandSchema.parse({ ...command, shell: "ffmpeg" })).toThrow();
  });

  it("requires render paths in the exact argv positions", () => {
    const inputPath = "C:\\Media\\single-clip.mp4";
    const outputPath = "C:\\Exports\\trim.mp4";
    const plan = {
      schemaVersion: 1,
      planId: ids.plan,
      revisionId: ids.revision,
      executable: "ffmpeg",
      inputPath,
      outputPath,
      expected: { durationFrames: 30, rate, width: 640, height: 360, audio: true },
      argv: ["-i", inputPath, outputPath],
    } as const;
    expect(renderPlanV1Schema.parse(plan)).toEqual(plan);
    expect(() =>
      renderPlanV1Schema.parse({ ...plan, argv: [outputPath, "-i", inputPath] }),
    ).toThrow("final");
  });

  it("leaves trim range semantics to command execution", () => {
    const zero = createRationalTime(0, rate);
    const command = {
      type: "TrimClip",
      commandId: ids.command,
      baseRevisionId: ids.revision,
      issuedAt: timestamp,
      sequenceId: ids.project,
      trackId: ids.asset,
      clipId: ids.plan,
      sourceIn: zero,
      sourceOut: zero,
    };
    expect(videoProjectCommandSchema.parse(command).type).toBe("TrimClip");
  });
});
