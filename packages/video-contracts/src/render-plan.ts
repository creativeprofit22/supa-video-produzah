import { z } from "zod";

import { rationalRateSchema } from "./time.js";

const safePositiveIntegerSchema = z.number().int().safe().positive();
const pathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes("\0"), {
    message: "Render paths cannot contain NUL characters",
  });
const argumentSchema = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes("\0"), {
    message: "FFmpeg arguments cannot contain NUL characters",
  });

export const renderPlanV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().uuid(),
    revisionId: z.string().uuid(),
    executable: z.literal("ffmpeg"),
    inputPath: pathSchema,
    outputPath: pathSchema,
    expected: z
      .object({
        durationFrames: safePositiveIntegerSchema,
        rate: rationalRateSchema,
        width: safePositiveIntegerSchema.refine((value) => value % 2 === 0, "Width must be even"),
        height: safePositiveIntegerSchema.refine((value) => value % 2 === 0, "Height must be even"),
        audio: z.boolean(),
      })
      .strict(),
    argv: z.array(argumentSchema).min(1).max(128),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.argv.at(-1) !== plan.outputPath) {
      context.addIssue({
        code: "custom",
        message: "Render output must be the final FFmpeg argument",
      });
    }
    const inputIndex = plan.argv.indexOf("-i");
    if (inputIndex < 0 || plan.argv[inputIndex + 1] !== plan.inputPath) {
      context.addIssue({ code: "custom", message: "Render input must immediately follow -i" });
    }
  });

export type RenderPlanV1 = z.infer<typeof renderPlanV1Schema>;
