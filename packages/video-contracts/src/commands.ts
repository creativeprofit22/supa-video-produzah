import { z } from "zod";

import { videoAssetSchema, videoClipSchema, videoSequenceSchema } from "./project.js";
import { rationalTimeSchema } from "./time.js";

const commandEnvelope = {
  commandId: z.string().uuid(),
  baseRevisionId: z.string().uuid(),
  issuedAt: z.string().datetime({ offset: true }),
};

export const importAssetCommandSchema = z
  .object({
    type: z.literal("ImportAsset"),
    ...commandEnvelope,
    asset: videoAssetSchema,
  })
  .strict();

export const createSequenceCommandSchema = z
  .object({
    type: z.literal("CreateSequence"),
    ...commandEnvelope,
    sequence: videoSequenceSchema,
  })
  .strict();

export const insertClipCommandSchema = z
  .object({
    type: z.literal("InsertClip"),
    ...commandEnvelope,
    sequenceId: z.string().uuid(),
    trackId: z.string().uuid(),
    clip: videoClipSchema,
  })
  .strict();

export const trimClipCommandSchema = z
  .object({
    type: z.literal("TrimClip"),
    ...commandEnvelope,
    sequenceId: z.string().uuid(),
    trackId: z.string().uuid(),
    clipId: z.string().uuid(),
    sourceIn: rationalTimeSchema,
    sourceOut: rationalTimeSchema,
  })
  .strict();

export const videoProjectCommandSchema = z.discriminatedUnion("type", [
  importAssetCommandSchema,
  createSequenceCommandSchema,
  insertClipCommandSchema,
  trimClipCommandSchema,
]);

export type ImportAssetCommand = z.infer<typeof importAssetCommandSchema>;
export type CreateSequenceCommand = z.infer<typeof createSequenceCommandSchema>;
export type InsertClipCommand = z.infer<typeof insertClipCommandSchema>;
export type TrimClipCommand = z.infer<typeof trimClipCommandSchema>;
export type VideoProjectCommand = z.infer<typeof videoProjectCommandSchema>;
