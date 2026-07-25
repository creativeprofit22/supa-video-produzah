import { describe, expect, it } from "vitest";

import { prepareVideoAssetRequestSchema, preparedVideoAssetSchema } from "./derived-media.js";

const request = {
  projectId: "00000000-0000-4000-8000-000000000001",
  assetId: "00000000-0000-4000-8000-000000000002",
  path: "C:\\Media\\clip.mp4",
  sequenceRate: { numerator: 30_000, denominator: 1_001 },
} as const;

const proxyProbe = {
  durationMicroseconds: 4_000_000,
  averageFrameRate: request.sequenceRate,
  realFrameRate: request.sequenceRate,
  variableFrameRate: false,
  width: 1_280,
  height: 720,
  videoCodecName: "h264",
  audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
  fileSizeBytes: 5_000_000,
} as const;

const prepared = {
  proxyPath: "C:\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Cache\\thumbnail.jpg",
  proxyProbe,
} as const;

describe("derived-media contracts", () => {
  it("accepts the strict prepare request", () => {
    expect(prepareVideoAssetRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects malformed prepare requests", () => {
    expect(() =>
      prepareVideoAssetRequestSchema.parse({
        ...request,
        sequenceRate: { numerator: 60, denominator: 2 },
      }),
    ).toThrow("reduced");
    expect(() => prepareVideoAssetRequestSchema.parse({ ...request, path: "clip.mp4" })).toThrow(
      "absolute",
    );
    expect(() =>
      prepareVideoAssetRequestSchema.parse({
        ...request,
        projectId: "00000000-0000-4000-7000-000000000001",
      }),
    ).toThrow("UUID");
    expect(() => prepareVideoAssetRequestSchema.parse({ ...request, extra: true })).toThrow();
  });

  it("accepts the strict prepared response and rejects malformed output", () => {
    expect(preparedVideoAssetSchema.parse(prepared)).toEqual(prepared);
    expect(() =>
      preparedVideoAssetSchema.parse({ ...prepared, proxyProbe: { ...proxyProbe, width: 0 } }),
    ).toThrow();
    expect(() => preparedVideoAssetSchema.parse({ ...prepared, rawOutput: "private" })).toThrow();
  });
});
