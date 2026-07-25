import { z } from "zod";

export const videoErrorCodes = [
  "invalid_time",
  "invalid_rate",
  "mixed_rate",
  "invalid_range",
  "invalid_project",
  "unsupported_schema",
  "invalid_command",
  "stale_revision",
  "phase1_limit",
  "invalid_path",
  "path_not_granted",
  "project_io",
  "tool_unavailable",
  "process_failed",
  "process_timeout",
  "process_cancelled",
  "process_output_limit",
  "invalid_media",
  "invalid_render_plan",
  "output_exists",
] as const;

export const videoErrorCodeSchema = z.enum(videoErrorCodes);

export type VideoErrorCode = z.infer<typeof videoErrorCodeSchema>;

export const videoCommandErrorSchema = z
  .object({
    code: videoErrorCodeSchema,
    message: z.string().trim().min(1).max(32_768),
    details: z.record(z.string(), z.unknown()),
  })
  .strict();

export type VideoCommandError = z.infer<typeof videoCommandErrorSchema>;

export class VideoDomainError extends Error {
  readonly code: VideoErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: VideoErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "VideoDomainError";
    this.code = code;
    this.details = details;
  }
}
