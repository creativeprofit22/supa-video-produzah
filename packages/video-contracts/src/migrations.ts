import { VideoDomainError } from "./errors.js";
import { type VideoProjectFile, videoProjectFileV1Schema } from "./project.js";

export function parseVideoProjectFile(input: unknown): VideoProjectFile {
  if (typeof input !== "object" || input === null || !("schemaVersion" in input)) {
    throw new VideoDomainError(
      "invalid_project",
      "This is not a Supa Video Producer project: schemaVersion is missing",
    );
  }

  const schemaVersion = (input as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== 1) {
    throw new VideoDomainError(
      "unsupported_schema",
      `Project schema ${String(schemaVersion)} is not supported by this version`,
      { schemaVersion },
    );
  }

  const result = videoProjectFileV1Schema.safeParse(input);
  if (!result.success) {
    throw new VideoDomainError("invalid_project", "Project file failed strict V1 validation", {
      issues: result.error.issues,
    });
  }
  return result.data;
}
