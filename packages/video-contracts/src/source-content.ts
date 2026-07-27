import { z } from "zod";

export const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const mediaContentIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("sha256"),
    digest: sha256DigestSchema,
    byteLength: z.number().int().safe().positive(),
  })
  .strict();

export type MediaContentIdentityV1 = z.infer<typeof mediaContentIdentityV1Schema>;
