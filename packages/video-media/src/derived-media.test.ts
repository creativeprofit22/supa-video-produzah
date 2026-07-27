import { describe, expect, it } from "vitest";

import { prepareVideoAssetRequestSchema, preparedVideoAssetSchema } from "./derived-media.js";

const request = {
  projectId: "00000000-0000-4000-8000-000000000001",
  assetId: "00000000-0000-4000-8000-000000000002",
  path: "C:\\Media\\clip.mp4",
  sequenceRate: { numerator: 30000, denominator: 1001 },
} as const;
const sourceIdentity = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "01".repeat(32),
  byteLength: 5000000,
} as const;
const profileIdentity = {
  schemaVersion: 1,
  profileId: "preview-v1",
  profileDigest: "02".repeat(32),
} as const;
const sourceProbe = {
  durationMicroseconds: 4000000,
  averageFrameRate: request.sequenceRate,
  realFrameRate: request.sequenceRate,
  variableFrameRate: false,
  width: 1280,
  height: 720,
  videoCodecName: "h264",
  audio: { codecName: "aac", channels: 2, sampleRate: 48000 },
  fileSizeBytes: sourceIdentity.byteLength,
} as const;
const identityBase = {
  schemaVersion: 1,
  sourceIdentity,
  toolchainId: "ffmpeg-test-v1",
  profileIdentity,
  recipeDigest: "03".repeat(32),
} as const;
const prepared = {
  sourceFingerprint: {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: "04".repeat(32),
    byteLength: sourceIdentity.byteLength,
    modifiedUnixSeconds: 1720000000,
    modifiedNanoseconds: 42,
  },
  sourceIdentity,
  sourceProbe,
  sequenceRate: request.sequenceRate,
  profileIdentity,
  proxyIdentity: { ...identityBase, artifactKind: "proxy", key: "05".repeat(32) },
  proxyPath: "C:\\Cache\\proxy.mp4",
  proxyProbe: sourceProbe,
  thumbnailIdentity: {
    ...identityBase,
    artifactKind: "thumbnail_tile",
    key: "06".repeat(32),
  },
  thumbnailPath: "C:\\Cache\\thumbnail.jpg",
} as const;

describe("media preparation contracts", () => {
  it("accepts strict requests with an optional sequence rate", () => {
    expect(prepareVideoAssetRequestSchema.parse(request)).toEqual(request);
    const withoutRate = {
      projectId: request.projectId,
      assetId: request.assetId,
      path: request.path,
    };
    expect(prepareVideoAssetRequestSchema.parse(withoutRate)).toEqual(withoutRate);
  });

  it("rejects malformed requests", () => {
    expect(() =>
      prepareVideoAssetRequestSchema.parse({
        ...request,
        sequenceRate: { numerator: 60, denominator: 2 },
      }),
    ).toThrow("reduced");
    expect(() => prepareVideoAssetRequestSchema.parse({ ...request, path: "clip.mp4" })).toThrow(
      "absolute",
    );
    expect(() => prepareVideoAssetRequestSchema.parse({ ...request, extra: true })).toThrow();
  });

  it("accepts only the strict sanitized prepared response", () => {
    expect(preparedVideoAssetSchema.parse(prepared)).toEqual(prepared);
    expect(() =>
      preparedVideoAssetSchema.parse({
        ...prepared,
        proxyIdentity: { ...prepared.proxyIdentity, artifactKind: "thumbnail_tile" },
      }),
    ).toThrow();
    expect(() => preparedVideoAssetSchema.parse({ ...prepared, objectPath: "private" })).toThrow();
  });
});
