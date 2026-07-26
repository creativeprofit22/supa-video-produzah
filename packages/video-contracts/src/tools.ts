import { z } from "zod";

export const videoToolProblemSchema = z.enum([
  "not_found",
  "timed_out",
  "failed",
  "invalid_version",
  "integrity_failed",
  "incompatible_build",
]);

export type VideoToolProblem = z.infer<typeof videoToolProblemSchema>;

export const videoToolInfoSchema = z
  .object({
    available: z.boolean(),
    version: z.string().trim().min(1).max(256).optional(),
    problem: videoToolProblemSchema.optional(),
  })
  .strict()
  .superRefine((tool, context) => {
    if (tool.available && tool.version === undefined) {
      context.addIssue({ code: "custom", message: "Available tools require a version" });
    }
    if (tool.available && tool.problem !== undefined) {
      context.addIssue({ code: "custom", message: "Available tools cannot report a problem" });
    }
    if (!tool.available && tool.version !== undefined) {
      context.addIssue({ code: "custom", message: "Unavailable tools cannot report a version" });
    }
    if (!tool.available && tool.problem === undefined) {
      context.addIssue({ code: "custom", message: "Unavailable tools require a problem" });
    }
  });

export type VideoToolInfo = z.infer<typeof videoToolInfoSchema>;

export const videoToolSourceSchema = z.literal("bundled");

export type VideoToolSource = z.infer<typeof videoToolSourceSchema>;

export const videoToolStatusSchema = z
  .object({
    source: videoToolSourceSchema,
    toolchainId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    ffmpeg: videoToolInfoSchema,
    ffprobe: videoToolInfoSchema,
    ready: z.boolean(),
  })
  .strict()
  .refine((status) => status.ready === (status.ffmpeg.available && status.ffprobe.available), {
    message: "Tool readiness must match FFmpeg and FFprobe availability",
    path: ["ready"],
  });

export type VideoToolStatus = z.infer<typeof videoToolStatusSchema>;
