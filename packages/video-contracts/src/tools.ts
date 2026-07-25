import { z } from "zod";

export const videoToolProblemSchema = z.enum([
  "not_found",
  "timed_out",
  "failed",
  "invalid_version",
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

export const videoToolStatusSchema = z
  .object({
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
