import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { videoProjectCommandSchema } from "./commands.js";
import { VideoDomainError, videoErrorCodes } from "./errors.js";
import { parseVideoProjectFile } from "./migrations.js";
import {
  assetLocatorSchema,
  type ProjectRevision,
  type VideoAsset,
  type VideoProjectFileV1,
  videoProjectFileV1Schema,
} from "./project.js";
import { renderPlanSchema, renderPlanV1Schema, renderPlanV2Schema } from "./render-plan.js";
import { createRationalRate, createRationalTime } from "./time.js";
import { videoToolStatusSchema } from "./tools.js";

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

interface ProjectParityCase {
  readonly name: string;
  readonly path: string;
  readonly expected: "valid" | "invalid_project" | "unsupported_schema";
  readonly canonicalPath?: string;
}

interface ProjectParityManifest {
  readonly cases: readonly ProjectParityCase[];
}

async function loadParityManifest(): Promise<{
  readonly manifest: ProjectParityManifest;
  readonly manifestUrl: URL;
}> {
  const manifestUrl = new URL("../fixtures/project-v1/manifest.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as ProjectParityManifest;
  return { manifest, manifestUrl };
}

describe("project contracts", () => {
  it("exposes render plan and output collision error codes", () => {
    expect(videoErrorCodes).toContain("invalid_render_plan");
    expect(videoErrorCodes).toContain("output_exists");
  });
  it("accepts a strict linear V1 document", () => {
    expect(parseVideoProjectFile(makeProject())).toEqual(makeProject());
  });

  it("fails malformed, unknown, and future documents actionably", () => {
    expect(() => parseVideoProjectFile({})).toThrowError(VideoDomainError);
    expect(() => parseVideoProjectFile({ schemaVersion: 2 })).toThrow("strict V2");
    for (const schemaVersion of ["1", 1.5, 0, -1, null]) {
      try {
        parseVideoProjectFile({ schemaVersion });
        expect.unreachable("malformed schema version must fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_project" });
      }
    }
    expect(() => videoProjectFileV1Schema.parse({ ...makeProject(), surprise: true })).toThrow();
  });

  it("requires safe source locators", () => {
    expect(() => assetLocatorSchema.parse({})).toThrow("requires");
    for (const relativePath of [
      "../escape.mp4",
      "media//clip.mp4",
      "media\\\\clip.mp4",
      "C:clip.mp4",
      "C:\\clip.mp4",
      "/clip.mp4",
      "\\\\server\\share\\clip.mp4",
    ]) {
      expect(() => assetLocatorSchema.parse({ relativePath })).toThrow("escape");
    }
    for (const absolutePath of ["clip.mp4", "media/clip.mp4", "C:clip.mp4"]) {
      expect(() => assetLocatorSchema.parse({ absolutePath })).toThrow("absolute");
    }
    for (const absolutePath of [
      "/media/clip.mp4",
      "C:\\Media\\clip.mp4",
      "\\\\server\\share\\clip.mp4",
    ]) {
      expect(assetLocatorSchema.parse({ absolutePath })).toEqual({ absolutePath });
    }
    expect(assetLocatorSchema.parse({ relativePath: "media/clip.mp4" })).toEqual({
      relativePath: "media/clip.mp4",
    });
  });

  it("matches every shared V1 parity corpus result", async () => {
    const { manifest, manifestUrl } = await loadParityManifest();

    for (const parityCase of manifest.cases) {
      const document = JSON.parse(
        await readFile(new URL(parityCase.path, manifestUrl), "utf8"),
      ) as unknown;
      try {
        parseVideoProjectFile(document);
        expect(parityCase.expected, parityCase.name).toBe("valid");
      } catch (error) {
        expect(error, parityCase.name).toBeInstanceOf(VideoDomainError);
        expect((error as VideoDomainError).code, parityCase.name).toBe(parityCase.expected);
      }
    }
  });

  it("normalizes and serializes padded non-blank fields to the shared canonical structure", async () => {
    const { manifest, manifestUrl } = await loadParityManifest();
    const parityCase = manifest.cases.find((candidate) => candidate.canonicalPath !== undefined);
    expect(parityCase).toBeDefined();

    const input = JSON.parse(
      await readFile(new URL(parityCase!.path, manifestUrl), "utf8"),
    ) as unknown;
    const expected = JSON.parse(
      await readFile(new URL(parityCase!.canonicalPath!, manifestUrl), "utf8"),
    ) as unknown;
    const parsed = parseVideoProjectFile(input);

    expect(parsed).toEqual(expected);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(expected);
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
    expect(
      renderPlanV1Schema.parse({ ...plan, expected: { ...plan.expected, videoHidden: true } }),
    ).toEqual({ ...plan, expected: { ...plan.expected, videoHidden: true } });
    expect(() =>
      renderPlanV1Schema.parse({ ...plan, expected: { ...plan.expected, videoHidden: "true" } }),
    ).toThrow();
    expect(() =>
      renderPlanV1Schema.parse({ ...plan, expected: { ...plan.expected, hidden: true } }),
    ).toThrow();
    expect(() =>
      renderPlanV1Schema.parse({ ...plan, argv: [outputPath, "-i", inputPath] }),
    ).toThrow("final");
  });

  it("binds V2 render argv inputs to ordered structured video metadata", () => {
    const inputPath = "C:\\Media\\top.mp4";
    const outputPath = "C:\\Exports\\stack.mp4";
    const plan = {
      schemaVersion: 2,
      planId: ids.plan,
      revisionId: ids.revision,
      executable: "ffmpeg",
      inputPathsByAssetId: { [ids.asset]: inputPath },
      videoInputs: [
        {
          assetId: ids.asset,
          path: inputPath,
          sourceInMicroseconds: 500_000,
          hidden: false,
          muted: true,
          hasAudio: true,
        },
      ],
      outputPath,
      expected: { durationFrames: 30, rate, width: 640, height: 360, audio: false },
      argv: ["-i", inputPath, outputPath],
    } as const;
    expect(renderPlanV2Schema.parse(plan)).toEqual(plan);
    expect(renderPlanSchema.parse(plan)).toEqual(plan);

    const caption = {
      trackId: ids.project,
      captionId: ids.command,
      startMicroseconds: 0,
      endMicroseconds: 1_000_000,
      text: "Strict caption",
    } as const;
    const planWithCaption = { ...plan, captions: [caption] } as const;
    expect(renderPlanV2Schema.parse(planWithCaption)).toEqual(planWithCaption);

    const forbiddenFieldMutations = [
      { ...plan, surprise: true },
      { ...plan, expected: { ...plan.expected, videoHidden: false } },
      { ...plan, expected: { ...plan.expected, surprise: true } },
      { ...plan, expected: { ...plan.expected, rate: { ...plan.expected.rate, surprise: true } } },
      { ...plan, videoInputs: [{ ...plan.videoInputs[0], surprise: true }] },
      { ...planWithCaption, captions: [{ ...caption, surprise: true }] },
    ];
    for (const mutation of forbiddenFieldMutations) {
      expect(renderPlanV2Schema.safeParse(mutation).success).toBe(false);
      expect(renderPlanSchema.safeParse(mutation).success).toBe(false);
    }

    expect(() =>
      renderPlanV2Schema.parse({
        ...plan,
        videoInputs: [{ ...plan.videoInputs[0], path: "C:\\Media\\other.mp4" }],
      }),
    ).toThrow("match its asset path");
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

  it("validates media-tool readiness and availability invariants", () => {
    const ready = {
      source: "bundled",
      toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
      ffmpeg: { available: true, version: "8.1.2" },
      ffprobe: { available: true, version: "8.1.2" },
      ready: true,
    };
    expect(videoToolStatusSchema.parse(ready)).toEqual(ready);

    const blocked = {
      source: "bundled",
      toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
      ffmpeg: { available: false, problem: "integrity_failed" },
      ffprobe: { available: false, problem: "timed_out" },
      ready: false,
    };
    expect(videoToolStatusSchema.parse(blocked)).toEqual(blocked);

    const ffprobeMissing = {
      ...ready,
      ffprobe: { available: false, problem: "not_found" },
      ready: false,
    };
    const ffmpegIncompatible = {
      ...ready,
      ffmpeg: { available: false, problem: "incompatible_build" },
      ready: false,
    };
    expect(videoToolStatusSchema.parse(ffprobeMissing)).toEqual(ffprobeMissing);
    expect(videoToolStatusSchema.parse(ffmpegIncompatible)).toEqual(ffmpegIncompatible);
    expect(() => videoToolStatusSchema.parse({ ...ffprobeMissing, ready: true })).toThrow(
      "readiness",
    );

    for (const problem of [
      "not_found",
      "integrity_failed",
      "incompatible_build",
      "timed_out",
      "failed",
    ] as const) {
      expect(
        videoToolStatusSchema.parse({
          ...blocked,
          ffmpeg: { available: false, problem },
          ffprobe: { available: false, problem },
        }).ready,
      ).toBe(false);
    }
    expect(() => videoToolStatusSchema.parse({ ...ready, ready: false })).toThrow("readiness");
    expect(() => videoToolStatusSchema.parse({ ...ready, source: "system" })).toThrow();
    expect(() =>
      videoToolStatusSchema.parse({ ...ready, toolchainId: "C:\\tools\\ffmpeg" }),
    ).toThrow();
    expect(() =>
      videoToolStatusSchema.parse({
        ...blocked,
        ffmpeg: { available: false },
      }),
    ).toThrow("problem");
    expect(() =>
      videoToolStatusSchema.parse({
        ...ready,
        ffmpeg: { ...ready.ffmpeg, rawOutput: "hidden" },
      }),
    ).toThrow();
  });
});
