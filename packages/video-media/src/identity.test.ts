import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  deriveMediaIdentity,
  deriveProfileIdentity,
  deriveRecipeDigest,
  deriveSourceFingerprint,
  derivedMediaIdentityV1Schema,
  derivedProfileSchema,
  sourceFingerprintV1Schema,
  type DerivedProfile,
} from "./identity.js";

export const previewProfile: DerivedProfile = {
  profileId: "preview-v1",
  proxyMaxWidth: 1280,
  proxyMaxHeight: 720,
  scaleFlags: "lanczos",
  proxyVideoEncoder: "libx264",
  proxyVideoEncoderColorRange: "limited",
  proxyPreset: "medium",
  proxyCrf: 23,
  proxyPixelFormat: "yuv420p",
  proxySampleAspectRatio: "1",
  proxyColorRange: "tv",
  proxyColorSpace: "bt709",
  proxyColorPrimaries: "bt709",
  proxyColorTransfer: "bt709",
  proxyHdrLinearTransfer: "linear",
  proxyHdrNominalPeakLuminance: "100",
  proxyHdrIntermediatePixelFormat: "gbrpf32le",
  proxyHdrTonemap: "hable",
  proxyHdrTonemapDesaturation: "2",
  proxyHdrSignalPeak: "10",
  proxyHdrDither: "error_diffusion",
  proxyMovflags: "+faststart",
  proxyAudioEncoder: "aac",
  proxyAudioBitrate: "192k",
  proxyAudioSampleRate: 48000,
  thumbnailCount: 10,
  thumbnailCellWidth: 160,
  thumbnailCellHeight: 90,
  thumbnailPadColor: "black",
  thumbnailTileLayout: "10x1",
  thumbnailEncoder: "mjpeg",
  thumbnailQuality: 2,
};

const sourceIdentity = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "0123456789abcdef".repeat(4),
  byteLength: 123456,
} as const;

const proxyRecipe = {
  artifactKind: "proxy" as const,
  argv: ["-i", "{source}", "-map", "0:v:0", "-c:v", "libx264", "{destination}"],
  validationPolicy: ["regular_nonzero", "probe_size_exact", "h264_yuv420p"],
};

describe("deterministic media identity", () => {
  it("matches the shared length-delimited identity vector", async () => {
    const vector = JSON.parse(
      await readFile(new URL("../fixtures/identity-v1.json", import.meta.url), "utf8"),
    ) as {
      fingerprintInput: Parameters<typeof deriveSourceFingerprint>[0];
      sourceFingerprint: unknown;
      profile: DerivedProfile;
      profileIdentity: unknown;
      recipeInput: Parameters<typeof deriveRecipeDigest>[0];
      recipeDigest: string;
      sourceIdentity: Parameters<typeof deriveMediaIdentity>[0]["sourceIdentity"];
      toolchainId: string;
      derivedIdentity: unknown;
    };
    expect(await deriveSourceFingerprint(vector.fingerprintInput)).toEqual(
      vector.sourceFingerprint,
    );
    const profileIdentity = await deriveProfileIdentity(vector.profile);
    expect(profileIdentity).toEqual(vector.profileIdentity);
    const recipeDigest = await deriveRecipeDigest(vector.recipeInput);
    expect(recipeDigest).toBe(vector.recipeDigest);
    expect(
      await deriveMediaIdentity({
        artifactKind: vector.recipeInput.artifactKind,
        sourceIdentity: vector.sourceIdentity,
        toolchainId: vector.toolchainId,
        profileIdentity,
        recipeDigest,
      }),
    ).toEqual(vector.derivedIdentity);
  });

  it("derives strict, path-sensitive source hints", async () => {
    const first = await deriveSourceFingerprint({
      canonicalPath: "C:\\Media\\café.mp4",
      byteLength: 123456,
      modifiedUnixSeconds: 1720000000,
      modifiedNanoseconds: 123456789,
    });
    const renamed = await deriveSourceFingerprint({
      canonicalPath: "C:\\Media\\renamed.mp4",
      byteLength: 123456,
      modifiedUnixSeconds: 1720000000,
      modifiedNanoseconds: 123456789,
    });
    expect(sourceFingerprintV1Schema.parse(first)).toEqual(first);
    expect(renamed.digest).not.toBe(first.digest);
  });

  it("invalidates profile identity for every output field", async () => {
    const baseline = await deriveProfileIdentity(previewProfile);
    for (const key of Object.keys(previewProfile) as (keyof DerivedProfile)[]) {
      const current = previewProfile[key];
      const changed = {
        ...previewProfile,
        [key]: typeof current === "number" ? current + 1 : `${current}-changed`,
      };
      expect(
        (await deriveProfileIdentity(derivedProfileSchema.parse(changed))).profileDigest,
      ).not.toBe(baseline.profileDigest);
    }
  });

  it("invalidates recipe and derived keys for ordered recipe/toolchain/source inputs", async () => {
    const profileIdentity = await deriveProfileIdentity(previewProfile);
    const recipeDigest = await deriveRecipeDigest(proxyRecipe);
    const identity = await deriveMediaIdentity({
      artifactKind: "proxy",
      sourceIdentity,
      toolchainId: "ffmpeg-test-v1",
      profileIdentity,
      recipeDigest,
    });
    expect(derivedMediaIdentityV1Schema.parse(identity)).toEqual(identity);

    const reorderedRecipe = await deriveRecipeDigest({
      ...proxyRecipe,
      argv: [...proxyRecipe.argv].reverse(),
    });
    expect(reorderedRecipe).not.toBe(recipeDigest);
    expect(
      (
        await deriveMediaIdentity({
          ...identity,
          toolchainId: "ffmpeg-test-v2",
        })
      ).key,
    ).not.toBe(identity.key);
    expect(
      (
        await deriveMediaIdentity({
          ...identity,
          sourceIdentity: { ...sourceIdentity, digest: `1${sourceIdentity.digest.slice(1)}` },
        })
      ).key,
    ).not.toBe(identity.key);
  });

  it("rejects unknown schema fields", () => {
    expect(() => derivedProfileSchema.parse({ ...previewProfile, hidden: true })).toThrow();
  });
});
