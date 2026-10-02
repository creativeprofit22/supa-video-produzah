import { type VideoCommandError, VideoDomainError } from "./errors.js";
import { migrateGraphicsClip } from "./project-graphics.js";
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

  const unsupportedGraphics = schemaVersion === 2 ? findUnsupportedGraphicsClip(input) : undefined;
  if (unsupportedGraphics !== undefined) {
    throw new VideoDomainError(
      unsupportedGraphics.code,
      unsupportedGraphics.message,
      unsupportedGraphics.details,
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Runs every raw graphics clip through `migrateGraphicsClip` and returns the first
 * `unsupported_schema` failure (a clip from a newer build). Other failures are left to the strict
 * snapshot parse so malformed clips still surface as `invalid_project`.
 */
function findUnsupportedGraphicsClip(input: object): VideoCommandError | undefined {
  const state = "state" in input ? input.state : undefined;
  const sequences = isRecord(state) ? state.sequences : undefined;
  if (!Array.isArray(sequences)) return undefined;
  for (const sequence of sequences) {
    const tracks = isRecord(sequence) ? sequence.tracks : undefined;
    if (!Array.isArray(tracks)) continue;
    for (const track of tracks) {
      if (!isRecord(track) || track.kind !== "graphics" || !Array.isArray(track.graphicsClips))
        continue;
      for (const clip of track.graphicsClips) {
        const migrated = migrateGraphicsClip(clip);
        if (!migrated.ok && migrated.error.code === "unsupported_schema") return migrated.error;
      }
    }
  }
  return undefined;
}
