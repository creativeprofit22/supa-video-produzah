import {
  type MediaContentIdentityV1,
  mediaContentIdentityV1Schema,
  sha256DigestSchema,
} from "@supa-video/contracts";
import { z } from "zod";

const safeNonNegativeInteger = z.number().int().safe().nonnegative();
const safePositiveInteger = z.number().int().safe().positive();
const nonBlankIdentity = z.string().trim().min(1).max(512);

export const sourceFingerprintV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("sha256"),
    digest: sha256DigestSchema,
    byteLength: safePositiveInteger,
    modifiedUnixSeconds: safeNonNegativeInteger,
    modifiedNanoseconds: safeNonNegativeInteger.max(999_999_999),
  })
  .strict();
export type SourceFingerprintV1 = z.infer<typeof sourceFingerprintV1Schema>;

export const mediaProfileIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: nonBlankIdentity,
    profileDigest: sha256DigestSchema,
  })
  .strict();
export type MediaProfileIdentityV1 = z.infer<typeof mediaProfileIdentityV1Schema>;

export const derivedArtifactKindSchema = z.enum(["proxy", "thumbnail_tile"]);
export type DerivedArtifactKind = z.infer<typeof derivedArtifactKindSchema>;

export const derivedMediaIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: derivedArtifactKindSchema,
    key: sha256DigestSchema,
    sourceIdentity: mediaContentIdentityV1Schema,
    toolchainId: nonBlankIdentity,
    profileIdentity: mediaProfileIdentityV1Schema,
    recipeDigest: sha256DigestSchema,
  })
  .strict();
export type DerivedMediaIdentityV1 = z.infer<typeof derivedMediaIdentityV1Schema>;

export const derivedProfileSchema = z
  .object({
    profileId: nonBlankIdentity,
    proxyMaxWidth: safePositiveInteger,
    proxyMaxHeight: safePositiveInteger,
    scaleFlags: nonBlankIdentity,
    proxyVideoEncoder: nonBlankIdentity,
    proxyVideoEncoderColorRange: nonBlankIdentity,
    proxyPreset: nonBlankIdentity,
    proxyCrf: safeNonNegativeInteger.max(63),
    proxyPixelFormat: nonBlankIdentity,
    proxySampleAspectRatio: nonBlankIdentity,
    proxyColorRange: nonBlankIdentity,
    proxyColorSpace: nonBlankIdentity,
    proxyColorPrimaries: nonBlankIdentity,
    proxyColorTransfer: nonBlankIdentity,
    proxyHdrLinearTransfer: nonBlankIdentity,
    proxyHdrNominalPeakLuminance: nonBlankIdentity,
    proxyHdrIntermediatePixelFormat: nonBlankIdentity,
    proxyHdrTonemap: nonBlankIdentity,
    proxyHdrTonemapDesaturation: nonBlankIdentity,
    proxyHdrSignalPeak: nonBlankIdentity,
    proxyHdrDither: nonBlankIdentity,
    proxyMovflags: nonBlankIdentity,
    proxyAudioEncoder: nonBlankIdentity,
    proxyAudioBitrate: nonBlankIdentity,
    proxyAudioSampleRate: safePositiveInteger,
    thumbnailCount: safePositiveInteger,
    thumbnailCellWidth: safePositiveInteger,
    thumbnailCellHeight: safePositiveInteger,
    thumbnailPadColor: nonBlankIdentity,
    thumbnailTileLayout: nonBlankIdentity,
    thumbnailEncoder: nonBlankIdentity,
    thumbnailQuality: safePositiveInteger.max(31),
  })
  .strict();
export type DerivedProfile = z.infer<typeof derivedProfileSchema>;

class IdentityEncoder {
  readonly #parts: Uint8Array[] = [];

  string(value: string): void {
    this.bytes(new TextEncoder().encode(value));
  }

  bytes(value: Uint8Array): void {
    if (value.byteLength > 0xffff_ffff) {
      throw new RangeError("Identity field exceeds the u32 length limit");
    }
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, value.byteLength, true);
    this.#parts.push(length, value);
  }

  safeInteger(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Identity integer must be a non-negative JavaScript-safe integer");
    }
    const encoded = new Uint8Array(8);
    new DataView(encoded.buffer).setBigUint64(0, BigInt(value), true);
    this.#parts.push(encoded);
  }

  finish(): Uint8Array {
    const length = this.#parts.reduce((total, part) => total + part.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of this.#parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
}

function digestBytes(digest: string): Uint8Array {
  sha256DigestSchema.parse(digest);
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stableBytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveSourceFingerprint(input: {
  canonicalPath: string;
  byteLength: number;
  modifiedUnixSeconds: number;
  modifiedNanoseconds: number;
}): Promise<SourceFingerprintV1> {
  const facts = sourceFingerprintV1Schema
    .pick({
      byteLength: true,
      modifiedUnixSeconds: true,
      modifiedNanoseconds: true,
    })
    .parse({
      byteLength: input.byteLength,
      modifiedUnixSeconds: input.modifiedUnixSeconds,
      modifiedNanoseconds: input.modifiedNanoseconds,
    });
  const encoder = new IdentityEncoder();
  encoder.string("supa-video/source-fingerprint/v1");
  encoder.string(input.canonicalPath);
  encoder.safeInteger(facts.byteLength);
  encoder.safeInteger(facts.modifiedUnixSeconds);
  encoder.safeInteger(facts.modifiedNanoseconds);
  return sourceFingerprintV1Schema.parse({
    schemaVersion: 1,
    algorithm: "sha256",
    digest: await sha256Hex(encoder.finish()),
    ...facts,
  });
}

const profileFields: readonly (keyof DerivedProfile)[] = [
  "profileId",
  "proxyMaxWidth",
  "proxyMaxHeight",
  "scaleFlags",
  "proxyVideoEncoder",
  "proxyVideoEncoderColorRange",
  "proxyPreset",
  "proxyCrf",
  "proxyPixelFormat",
  "proxySampleAspectRatio",
  "proxyColorRange",
  "proxyColorSpace",
  "proxyColorPrimaries",
  "proxyColorTransfer",
  "proxyHdrLinearTransfer",
  "proxyHdrNominalPeakLuminance",
  "proxyHdrIntermediatePixelFormat",
  "proxyHdrTonemap",
  "proxyHdrTonemapDesaturation",
  "proxyHdrSignalPeak",
  "proxyHdrDither",
  "proxyMovflags",
  "proxyAudioEncoder",
  "proxyAudioBitrate",
  "proxyAudioSampleRate",
  "thumbnailCount",
  "thumbnailCellWidth",
  "thumbnailCellHeight",
  "thumbnailPadColor",
  "thumbnailTileLayout",
  "thumbnailEncoder",
  "thumbnailQuality",
];

export async function deriveProfileIdentity(
  candidate: DerivedProfile,
): Promise<MediaProfileIdentityV1> {
  const profile = derivedProfileSchema.parse(candidate);
  const encoder = new IdentityEncoder();
  encoder.string("supa-video/media-profile/v1");
  for (const field of profileFields) {
    encoder.string(field);
    const value = profile[field];
    if (typeof value === "number") {
      encoder.safeInteger(value);
    } else {
      encoder.string(value);
    }
  }
  return {
    schemaVersion: 1,
    profileId: profile.profileId,
    profileDigest: await sha256Hex(encoder.finish()),
  };
}

export async function deriveRecipeDigest(input: {
  artifactKind: DerivedArtifactKind;
  argv: readonly string[];
  validationPolicy: readonly string[];
}): Promise<string> {
  const artifactKind = derivedArtifactKindSchema.parse(input.artifactKind);
  const tokens = z.array(z.string().max(32_768)).max(1_024).parse(input.argv);
  const validation = z.array(nonBlankIdentity).max(128).parse(input.validationPolicy);
  const encoder = new IdentityEncoder();
  encoder.string("supa-video/derived-recipe/v1");
  encoder.string(artifactKind);
  encoder.safeInteger(tokens.length);
  for (const token of tokens) encoder.string(token);
  encoder.safeInteger(validation.length);
  for (const rule of validation) encoder.string(rule);
  return sha256Hex(encoder.finish());
}

export async function deriveMediaIdentity(input: {
  artifactKind: DerivedArtifactKind;
  sourceIdentity: MediaContentIdentityV1;
  toolchainId: string;
  profileIdentity: MediaProfileIdentityV1;
  recipeDigest: string;
}): Promise<DerivedMediaIdentityV1> {
  const artifactKind = derivedArtifactKindSchema.parse(input.artifactKind);
  const sourceIdentity = mediaContentIdentityV1Schema.parse(input.sourceIdentity);
  const profileIdentity = mediaProfileIdentityV1Schema.parse(input.profileIdentity);
  const toolchainId = nonBlankIdentity.parse(input.toolchainId);
  const recipeDigest = sha256DigestSchema.parse(input.recipeDigest);
  const encoder = new IdentityEncoder();
  encoder.string("supa-video/derived-media/v1");
  encoder.string(artifactKind);
  encoder.bytes(digestBytes(sourceIdentity.digest));
  encoder.safeInteger(sourceIdentity.byteLength);
  encoder.string(toolchainId);
  encoder.string(profileIdentity.profileId);
  encoder.bytes(digestBytes(profileIdentity.profileDigest));
  encoder.bytes(digestBytes(recipeDigest));
  return {
    schemaVersion: 1,
    artifactKind,
    key: await sha256Hex(encoder.finish()),
    sourceIdentity,
    toolchainId,
    profileIdentity,
    recipeDigest,
  };
}
