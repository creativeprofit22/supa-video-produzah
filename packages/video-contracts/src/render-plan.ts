import { z } from "zod";

import { clipSpeedSchema, clipTimelineDuration } from "./clip-timing.js";
import { videoCommandErrorSchema } from "./errors.js";
import { mediaProbeSchema, projectUuidSchema } from "./project.js";
import { clipFadesSchema, clipTransformGeometrySchema } from "./project-v2-entities.js";
import {
  rationalRateSchema,
  rationalTimeSchema,
  rateOf,
  rationalTimeToMicroseconds,
} from "./time.js";

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

/** Exact source boundaries and retimed output duration travel together, never as a float. */
export const renderClipTimingV2Schema = z
  .object({
    sourceIn: rationalTimeSchema,
    sourceOut: rationalTimeSchema,
    speed: clipSpeedSchema,
    outputDuration: rationalTimeSchema,
  })
  .strict()
  .superRefine((timing, context) => {
    try {
      const expected = clipTimelineDuration(
        { in: timing.sourceIn, out: timing.sourceOut },
        rateOf(timing.outputDuration),
        timing.speed,
      );
      if (expected.value !== timing.outputDuration.value) {
        context.addIssue({
          code: "custom",
          path: ["outputDuration"],
          message: "Output duration must exactly match the retimed source range",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "Render timing must have valid exact frame boundaries",
      });
    }
  });
export type RenderClipTimingV2 = z.infer<typeof renderClipTimingV2Schema>;

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
    timing: renderClipTimingV2Schema.optional(),
    fades: clipFadesSchema.optional(),
    gainMilliDecibels: z.number().int().safe().min(-96_000).max(24_000).optional(),
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
    for (const [index, videoInput] of plan.videoInputs.entries()) {
      const timing = videoInput.timing;
      if (videoInput.fades !== undefined) {
        try {
          const { inFrames, outFrames } = videoInput.fades;
          if (BigInt(inFrames) + BigInt(outFrames) > BigInt(plan.expected.durationFrames))
            throw new Error("fade sum");
          const seconds = (frames: number) => {
            const us = rationalTimeToMicroseconds(
              {
                value: frames,
                rateNumerator: plan.expected.rate.numerator,
                rateDenominator: plan.expected.rate.denominator,
              },
              "nearestTiesAwayFromZero",
            );
            if (frames > 0 && us === 0) throw new Error("zero fade duration");
            return `${Math.floor(us / 1_000_000)}.${String(us % 1_000_000).padStart(6, "0")}`;
          };
          const duration = seconds(plan.expected.durationFrames);
          let audio = "asetpts=PTS-STARTPTS";
          if (timing !== undefined) {
            const percent = (timing.speed.numerator * 100) / timing.speed.denominator;
            const tempo = `${Math.floor(percent / 100)}.${String(percent % 100).padStart(2, "0")}`;
            const tempoFilter =
              percent < 100
                ? `rubberband=tempo=${tempo}:window=short:transients=smooth`
                : `atempo=${tempo}`;
            audio = `atrim=duration=${seconds(timing.sourceOut.value - timing.sourceIn.value)},asetpts=PTS-STARTPTS,${tempoFilter},atrim=duration=${duration}`;
          } else if (inFrames > 0 || outFrames > 0) {
            audio = `atrim=duration=${duration},asetpts=PTS-STARTPTS,atrim=duration=${duration}`;
          }
          const gain = videoInput.gainMilliDecibels ?? 0;
          if (gain !== 0)
            audio += `,volume=${gain < 0 ? "-" : ""}${Math.floor(Math.abs(gain) / 1000)}.${String(Math.abs(gain) % 1000).padStart(3, "0")}dB`;
          if (inFrames > 0) audio += `,afade=t=in:st=0.000000:d=${seconds(inFrames)}:curve=tri`;
          if (outFrames > 0)
            audio += `,afade=t=out:st=${seconds(plan.expected.durationFrames - outFrames)}:d=${seconds(outFrames)}:curve=tri`;
          const filters = plan.argv[plan.argv.indexOf("-filter_complex") + 1]?.split(";") ?? [];
          const branch = `[${index}:a:0]${audio}[a${index}]`;
          if (
            (!videoInput.muted && videoInput.hasAudio
              ? filters.filter((part) => part === branch).length !== 1
              : filters.some((part) => part.startsWith(`[${index}:a:0]`))) ||
            plan.argv[plan.argv.lastIndexOf("-t") + 1] !== duration
          )
            throw new Error("fade graph");
        } catch {
          context.addIssue({
            code: "custom",
            message: "Audio fades must match exact output duration and filter context",
          });
        }
      }
      if (timing !== undefined) {
        try {
          const times = [timing.sourceIn, timing.sourceOut, timing.outputDuration];
          if (
            times.some(
              (time) =>
                time.rateNumerator !== plan.expected.rate.numerator ||
                time.rateDenominator !== plan.expected.rate.denominator,
            ) ||
            timing.outputDuration.value !== plan.expected.durationFrames ||
            rationalTimeToMicroseconds(timing.sourceIn, "nearestTiesAwayFromZero") !==
              videoInput.sourceInMicroseconds
          ) {
            context.addIssue({
              code: "custom",
              message: "Clip timing must match the render rate, duration and source offset",
            });
          }
        } catch {
          context.addIssue({
            code: "custom",
            message: "Clip timing exceeds the render time boundary",
          });
        }
      }
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
