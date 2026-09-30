import { type VideoAsset, videoAssetSchema } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { buildAssetIndex, fixtureEmbeddingSource, orientationOf } from "./asset-index.js";

function asset(id: string, name: string, width = 1920, height = 1080, digest?: string): VideoAsset {
  return videoAssetSchema.parse({
    id,
    displayName: name,
    locator: { relativePath: `media/${name}` },
    probe: {
      durationMicroseconds: 10_000_000,
      averageFrameRate: { numerator: 30, denominator: 1 },
      realFrameRate: { numerator: 30, denominator: 1 },
      variableFrameRate: false,
      width,
      height,
      videoCodecName: "h264",
      audio: null,
      fileSizeBytes: 1000,
    },
    ...(digest === undefined
      ? {}
      : { contentIdentity: { schemaVersion: 1, algorithm: "sha256", digest, byteLength: 1000 } }),
  });
}

const A = "30000000-0000-4000-8000-000000000001";
const B = "30000000-0000-4000-8000-000000000002";

describe("buildAssetIndex", () => {
  it("indexes names, tags and transcripts sorted by asset id", () => {
    const index = buildAssetIndex({
      assets: [asset(B, "Puente al atardecer.mp4", 1080, 1920), asset(A, "Río Grande.mov")],
      receipts: [],
      tags: { [A]: ["Kajak"] },
      transcripts: [
        {
          assetId: A,
          language: "de",
          words: [{ text: "Wasser", sourceStartUs: 2_000_000, sourceEndUs: 2_400_000 }],
        },
      ],
    });
    expect(index.entries.map((entry) => entry.assetId)).toEqual([A, B]);
    expect(index.entries[0]).toMatchObject({
      provenance: "owned",
      providerId: "local",
      descriptorTokens: ["grande", "kayak", "mov", "river"],
      transcriptTokens: ["water"],
      transcriptWords: [{ token: "water", startUs: 2_000_000 }],
      orientation: "landscape",
      embedding: null,
    });
    expect(index.entries[1]?.descriptorTokens).toEqual(["bridge", "mp4", "sunset"]);
    expect(index.entries[1]?.orientation).toBe("portrait");
    expect(index.embeddingModel).toBeNull();
  });

  it("keys embeddings by content identity, not asset id", () => {
    const digest = "a".repeat(64);
    const index = buildAssetIndex({
      assets: [asset(A, "clip.mp4", 1920, 1080, digest)],
      receipts: [],
      embeddings: fixtureEmbeddingSource({
        modelId: "fixture-clip",
        modelVersion: "1",
        content: { [`sha256:${digest}`]: [1, 0] },
        text: {},
        clusters: { [`sha256:${digest}`]: "cluster-river" },
      }),
    });
    expect(index.entries[0]).toMatchObject({
      identityKey: `sha256:${digest}`,
      embedding: [1, 0],
      visualClusterId: "cluster-river",
    });
    expect(index.embeddingModel).toEqual({ modelId: "fixture-clip", modelVersion: "1" });
  });

  it.each([
    [1920, 1080, "landscape"],
    [1080, 1920, "portrait"],
    [1000, 1020, "square"],
  ] as const)("classifies %ix%i as %s", (width, height, expected) => {
    expect(orientationOf(width, height)).toBe(expected);
  });
});
