import {
  mediaContentIdentityV1Schema,
  mediaProbeSchema,
  projectUuidSchema,
  rationalRateSchema,
} from "@supa-video/contracts";
import { z } from "zod";

import {
  derivedMediaIdentityV1Schema,
  mediaProfileIdentityV1Schema,
  sourceFingerprintV1Schema,
} from "./identity.js";

export const absoluteMediaPathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((path) => !path.includes("\0"), "Paths cannot contain NUL characters")
  .refine(
    (path) =>
      /^[a-zA-Z]:[\\/]/.test(path) ||
      /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/.test(path) ||
      path.startsWith("/"),
    "Path must be absolute",
  );

export const prepareVideoAssetRequestSchema = z
  .object({
    projectId: projectUuidSchema,
    assetId: projectUuidSchema,
    path: absoluteMediaPathSchema,
    sequenceRate: rationalRateSchema.optional(),
  })
  .strict();
export type PrepareVideoAssetRequest = z.infer<typeof prepareVideoAssetRequestSchema>;

export const preparedVideoAssetSchema = z
  .object({
    sourceFingerprint: sourceFingerprintV1Schema,
    sourceIdentity: mediaContentIdentityV1Schema,
    sourceProbe: mediaProbeSchema,
    sequenceRate: rationalRateSchema,
    profileIdentity: mediaProfileIdentityV1Schema,
    proxyIdentity: derivedMediaIdentityV1Schema.refine(
      (identity) => identity.artifactKind === "proxy",
      "Proxy identity kind must be proxy",
    ),
    proxyPath: absoluteMediaPathSchema,
    proxyProbe: mediaProbeSchema,
    thumbnailIdentity: derivedMediaIdentityV1Schema.refine(
      (identity) => identity.artifactKind === "thumbnail_tile",
      "Thumbnail identity kind must be thumbnail_tile",
    ),
    thumbnailPath: absoluteMediaPathSchema,
  })
  .strict();
export type PreparedVideoAsset = z.infer<typeof preparedVideoAssetSchema>;
