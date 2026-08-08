import { z } from "zod";

import { projectUuidSchema } from "./project.js";

const dateTimeSchema = z.string().datetime({ offset: true });
const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
const stateHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const projectRevisionDescriptorV2Schema = z
  .object({
    number: safeNonNegativeIntegerSchema,
    id: projectUuidSchema,
    parentId: projectUuidSchema.nullable(),
    committedAt: dateTimeSchema,
    operationId: projectUuidSchema,
    stateHash: stateHashSchema,
  })
  .strict();
export type ProjectRevisionDescriptorV2 = z.infer<typeof projectRevisionDescriptorV2Schema>;
