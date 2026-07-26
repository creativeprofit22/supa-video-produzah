import { VideoDomainError } from "./errors.js";
import { videoProjectSnapshotV2Schema } from "./project-v2.js";
import { type VideoProjectFile, videoProjectFileV1Schema } from "./project.js";

export function parseVideoProjectFile(input: unknown): VideoProjectFile {
  if (typeof input !== "object" || input === null || !("schemaVersion" in input)) {
    throw new VideoDomainError(
      "invalid_project",
      "This is not a Supa Video Producer project: schemaVersion is missing",
    );
  }

  const schemaVersion = (input as { schemaVersion?: unknown }).schemaVersion;
  if (
    typeof schemaVersion !== "number" ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    throw new VideoDomainError(
      "invalid_project",
      "This is not a Supa Video Producer project: schemaVersion must be a positive safe integer",
      { schemaVersion },
    );
  }
  if (schemaVersion > 2) {
    throw new VideoDomainError(
      "unsupported_schema",
      `Project schema ${String(schemaVersion)} is not supported by this version`,
      { schemaVersion },
    );
  }

  const schema = schemaVersion === 1 ? videoProjectFileV1Schema : videoProjectSnapshotV2Schema;
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new VideoDomainError(
      "invalid_project",
      `Project file failed strict V${String(schemaVersion)} validation`,
      { issues: result.error.issues },
    );
  }
  return result.data;
}
