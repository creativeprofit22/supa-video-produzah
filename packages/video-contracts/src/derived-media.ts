import { z } from "zod";

import { mediaProbeSchema, projectUuidSchema } from "./project.js";
import { rationalRateSchema } from "./time.js";

const absolutePathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((path) => !path.includes("\0"), {
    message: "Paths cannot contain NUL characters",
  })
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
    path: absolutePathSchema,
    sequenceRate: rationalRateSchema,
  })
  .strict();

export type PrepareVideoAssetRequest = z.infer<typeof prepareVideoAssetRequestSchema>;

export const preparedVideoAssetSchema = z
  .object({
    proxyPath: absolutePathSchema,
    thumbnailPath: absolutePathSchema,
    proxyProbe: mediaProbeSchema,
  })
  .strict();

export type PreparedVideoAsset = z.infer<typeof preparedVideoAssetSchema>;
