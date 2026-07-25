import { describe, expect, it } from "vitest";

import {
  verifiedRenderOutputSchema,
  videoRenderEventSchema,
  videoRenderStartedSchema,
} from "./render-plan.js";

const identity = {
  jobId: "00000000-0000-4000-8000-000000000001",
  planId: "00000000-0000-4000-8000-000000000001",
  revisionId: "00000000-0000-4000-8000-000000000002",
} as const;

const probe = {
  durationMicroseconds: 4_000_000,
  averageFrameRate: { numerator: 30_000, denominator: 1_001 },
  realFrameRate: { numerator: 30_000, denominator: 1_001 },
  variableFrameRate: false,
  width: 1_920,
  height: 1_080,
  videoCodecName: "h264",
  audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
  fileSizeBytes: 12_000_000,
} as const;

const output = {
  outputPath: "C:\\Exports\\clip.mp4",
  previewPath: "C:\\Cache\\clip-preview.mp4",
  probe,
} as const;

const events = [
  { type: "started", ...identity },
  {
    type: "progress",
    ...identity,
    completedMicroseconds: 2_000_000,
    durationMicroseconds: 4_000_000,
  },
  { type: "completed", ...identity, output },
  {
    type: "failed",
    ...identity,
    error: {
      code: "process_failed",
      message: "The media tool process failed",
      details: { operation: "render", executable: "ffmpeg", exitCode: 1 },
    },
  },
  { type: "cancelled", ...identity },
] as const;

describe("render event contracts", () => {
  it("accepts strict started and verified-output DTOs", () => {
    expect(videoRenderStartedSchema.parse(identity)).toEqual(identity);
    expect(verifiedRenderOutputSchema.parse(output)).toEqual(output);
    expect(() => videoRenderStartedSchema.parse({ ...identity, extra: true })).toThrow();
    expect(() => verifiedRenderOutputSchema.parse({ ...output, rawOutput: "private" })).toThrow();
  });

  it.each(events)("accepts the $type event variant", (event) => {
    expect(videoRenderEventSchema.parse(event)).toEqual(event);
  });

  it("rejects malformed and non-strict render events", () => {
    expect(() =>
      videoRenderEventSchema.parse({
        type: "progress",
        ...identity,
        completedMicroseconds: -1,
        durationMicroseconds: 4_000_000,
      }),
    ).toThrow();
    expect(() =>
      videoRenderEventSchema.parse({
        ...events[3],
        error: { ...events[3].error, code: "shell_error" },
      }),
    ).toThrow();
    expect(() => videoRenderEventSchema.parse({ ...events[4], rawOutput: "private" })).toThrow();
  });
});
