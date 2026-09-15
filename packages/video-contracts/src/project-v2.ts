import { z } from "zod";

import { projectCommandSchemaV2 } from "./project-commands-v2.js";
import { projectRevisionDescriptorV2Schema } from "./project-revision.js";
import { projectUuidSchema } from "./project.js";
import { rationalTimeSchema } from "./time.js";
import { videoProjectStateV2Schema } from "./project-v2-entities.js";

export * from "./project-v2-entities.js";
export * from "./project-revision.js";

const dateTimeSchema = z.string().datetime({ offset: true });
const nonBlankSchema = z.string().trim().min(1).max(512);
const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
const stateHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Half-open range; producers must explicitly convert endpoints to one common rate. */
export const affectedRangeSchema = z
  .object({
    sequenceId: projectUuidSchema,
    start: rationalTimeSchema,
    end: rationalTimeSchema,
  })
  .strict()
  .refine(
    (range) =>
      range.start.rateNumerator === range.end.rateNumerator &&
      range.start.rateDenominator === range.end.rateDenominator,
    "Affected range endpoints must use a common rate",
  )
  .refine((range) => range.end.value > range.start.value, "Affected range must be nonempty");
export const cacheInvalidationSchema = z.enum([
  "timeline",
  "preview",
  "audio_mix",
  "captions",
  "render_plan",
  "asset_source",
]);

export const projectHistoryEntryV2Schema = z
  .object({
    groupId: projectUuidSchema,
    summary: nonBlankSchema,
    forwardCommands: z.array(projectCommandSchemaV2).min(1).max(100),
    inverseCommands: z.array(projectCommandSchemaV2).min(1).max(100),
    affectedRanges: z.array(affectedRangeSchema).max(10_000),
    cacheInvalidations: z.array(cacheInvalidationSchema).max(6),
  })
  .strict()
  .refine(
    (entry) =>
      entry.forwardCommands.every(
        (command) =>
          command.type !== "RestoreRippleDeletedClip" &&
          command.type !== "RestoreActiveCaptionArtifact" &&
          command.type !== "RestoreClipSpeed" && command.type !== "RestoreClipFades",
      ),
    { message: "Private inverse commands cannot be stored as forward history" },
  );
export type ProjectHistoryEntryV2 = z.infer<typeof projectHistoryEntryV2Schema>;

export const projectHistoryV2Schema = z
  .object({
    undoStack: z.array(projectHistoryEntryV2Schema).max(10_000),
    redoStack: z.array(projectHistoryEntryV2Schema).max(10_000),
  })
  .strict();

export const videoProjectSnapshotV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: projectUuidSchema,
    name: nonBlankSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    storageGenerationId: projectUuidSchema,
    revision: projectRevisionDescriptorV2Schema,
    state: videoProjectStateV2Schema,
    history: projectHistoryV2Schema,
    lastAppliedRecordNumber: safeNonNegativeIntegerSchema,
    lastRecordHash: stateHashSchema,
  })
  .strict()
  .refine(
    (snapshot) => Date.parse(snapshot.updatedAt) >= Date.parse(snapshot.createdAt),
    "Project update time cannot precede creation",
  )
  .superRefine((snapshot, context) => {
    snapshot.state.sequences.forEach((sequence, sequenceIndex) => {
      sequence.tracks.forEach((track, trackIndex) => {
        if (
          track.kind === "caption" &&
          track.activeCaptionArtifact !== undefined &&
          track.activeCaptionArtifact.trackLink.projectId !== snapshot.id
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "state",
              "sequences",
              sequenceIndex,
              "tracks",
              trackIndex,
              "activeCaptionArtifact",
              "trackLink",
              "projectId",
            ],
            message: "Active caption artifact project must match its containing snapshot",
          });
        }
      });
    });

    for (const [stackName, entries] of [
      ["undoStack", snapshot.history.undoStack],
      ["redoStack", snapshot.history.redoStack],
    ] as const) {
      entries.forEach((entry, entryIndex) => {
        for (const [commandListName, commands] of [
          ["forwardCommands", entry.forwardCommands],
          ["inverseCommands", entry.inverseCommands],
        ] as const) {
          commands.forEach((command, commandIndex) => {
            const artifact =
              command.type === "ApplyCaptionArtifact" ||
              command.type === "RestoreActiveCaptionArtifact"
                ? command.artifact
                : undefined;
            if (artifact !== undefined && artifact.trackLink.projectId !== snapshot.id) {
              context.addIssue({
                code: "custom",
                path: [
                  "history",
                  stackName,
                  entryIndex,
                  commandListName,
                  commandIndex,
                  "artifact",
                  "trackLink",
                  "projectId",
                ],
                message: "Historical caption artifact project must match its containing snapshot",
              });
            }
          });
        }
      });
    }
  });
export type VideoProjectSnapshotV2 = z.infer<typeof videoProjectSnapshotV2Schema>;
