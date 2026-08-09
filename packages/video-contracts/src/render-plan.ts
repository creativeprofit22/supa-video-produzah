import { z } from "zod";

import { videoCommandErrorSchema } from "./errors.js";
import { mediaProbeSchema, projectUuidSchema } from "./project.js";
import { clipTransformGeometrySchema } from "./project-v2-entities.js";
import { rationalRateSchema } from "./time.js";

const safePositiveIntegerSchema = z.number().int().safe().positive();
const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
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

const renderExpectationSchema = z
  .object({
    durationFrames: safePositiveIntegerSchema,
    rate: rationalRateSchema,
    width: safePositiveIntegerSchema.refine((value) => value % 2 === 0, "Width must be even"),
    height: safePositiveIntegerSchema.refine((value) => value % 2 === 0, "Height must be even"),
    audio: z.boolean(),
  })
  .strict();

export const renderCaptionInputV2Schema = z
  .object({
    trackId: projectUuidSchema,
    captionId: projectUuidSchema,
    startMicroseconds: safeNonNegativeIntegerSchema,
    endMicroseconds: safePositiveIntegerSchema,
    text: z
      .string()
      .min(1)
      .max(16_384)
      .refine((value) => !value.includes("\0"), {
        message: "Caption text cannot contain NUL characters",
      }),
  })
  .strict()
  .refine((caption) => caption.endMicroseconds > caption.startMicroseconds, {
    message: "Caption end must be after its start",
  });

export type RenderCaptionInputV2 = z.infer<typeof renderCaptionInputV2Schema>;

export const renderPlanV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().uuid(),
    revisionId: z.string().uuid(),
    executable: z.literal("ffmpeg"),
    inputPath: pathSchema,
    captions: z.array(renderCaptionInputV2Schema).max(100_000).optional(),
    outputPath: pathSchema,
    expected: renderExpectationSchema.extend({ videoHidden: z.boolean().optional() }).strict(),
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

/**
 * Geometry values use the canonical clip composition semantics declared by
 * clipTransformGeometrySchema. Render metadata carries exact integers so preview and
 * export cannot disagree through floating-point serialization or implicit defaults.
 */
export const renderVideoInputV2Schema = z
  .object({
    assetId: projectUuidSchema,
    path: pathSchema,
    sourceInMicroseconds: safeNonNegativeIntegerSchema,
    ...clipTransformGeometrySchema.shape,
    opacityPermille: z.number().int().safe().min(0).max(1_000),
    hidden: z.boolean(),
    muted: z.boolean(),
    hasAudio: z.boolean(),
  })
  .strict();

export type RenderVideoInputV2 = z.infer<typeof renderVideoInputV2Schema>;

export const renderPlanV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    planId: z.string().uuid(),
    revisionId: z.string().uuid(),
    executable: z.literal("ffmpeg"),
    inputPathsByAssetId: z.record(projectUuidSchema, pathSchema),
    videoInputs: z.array(renderVideoInputV2Schema).min(1).max(1_000),
    captions: z.array(renderCaptionInputV2Schema).max(100_000).optional(),
    outputPath: pathSchema,
    expected: renderExpectationSchema,
    argv: z.array(argumentSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.argv.at(-1) !== plan.outputPath) {
      context.addIssue({
        code: "custom",
        message: "Render output must be the final FFmpeg argument",
      });
    }
    const entries = Object.entries(plan.inputPathsByAssetId);
    if (entries.length === 0) {
      context.addIssue({ code: "custom", message: "A render requires at least one input asset" });
    }
    for (const videoInput of plan.videoInputs) {
      if (plan.inputPathsByAssetId[videoInput.assetId] !== videoInput.path) {
        context.addIssue({
          code: "custom",
          message: "Every ordered video input must match its asset path",
        });
      }
    }
  });

export type RenderPlanV2 = z.infer<typeof renderPlanV2Schema>;

export const renderPlanSchema = z.discriminatedUnion("schemaVersion", [
  renderPlanV1Schema,
  renderPlanV2Schema,
]);

export type RenderPlan = z.infer<typeof renderPlanSchema>;

const renderEventIdentityShape = {
  jobId: projectUuidSchema,
  planId: projectUuidSchema,
  revisionId: projectUuidSchema,
};

export const videoRenderStartedSchema = z.object(renderEventIdentityShape).strict();

export type VideoRenderStarted = z.infer<typeof videoRenderStartedSchema>;

export const verifiedRenderOutputSchema = z
  .object({
    outputPath: pathSchema,
    previewPath: pathSchema,
    probe: mediaProbeSchema,
  })
  .strict();

export type VerifiedRenderOutput = z.infer<typeof verifiedRenderOutputSchema>;

export const videoRenderEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("started"),
      ...renderEventIdentityShape,
    })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      ...renderEventIdentityShape,
      completedMicroseconds: z.number().int().safe().nonnegative(),
      durationMicroseconds: z.number().int().safe().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("completed"),
      ...renderEventIdentityShape,
      output: verifiedRenderOutputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      ...renderEventIdentityShape,
      error: videoCommandErrorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("cancelled"),
      ...renderEventIdentityShape,
    })
    .strict(),
]);

export type VideoRenderEvent = z.infer<typeof videoRenderEventSchema>;
