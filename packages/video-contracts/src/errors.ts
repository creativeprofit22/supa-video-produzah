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
  "invalid_render_plan",
] as const;

export type VideoErrorCode = (typeof videoErrorCodes)[number];

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
