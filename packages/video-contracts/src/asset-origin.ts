import { z } from "zod";

/**
 * Marks an asset created by Rust's acquisition command. Local imports omit it.
 * Rust never trusts this field alone: render validation looks inputs up by
 * content digest, and a mismatched receipt id fails validation.
 */
export const assetOriginSchema = z
  .object({
    kind: z.literal("acquired"),
    acquisitionReceiptId: z.uuid(),
  })
  .strict();
export type AssetOrigin = z.infer<typeof assetOriginSchema>;
