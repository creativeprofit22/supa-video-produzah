import { z } from "zod";

import { projectUuidSchema, videoProjectFileV1Schema } from "./project.js";

const nativePathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((path) => !path.includes("\0"), "Paths cannot contain NUL characters");

function isRecognizableAbsolutePath(path: string): boolean {
  const driveRooted = /^[a-zA-Z]:[\\/]/.test(path);
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/.test(path);
  return driveRooted || unc || path.startsWith("/");
}

export const absoluteNativePathSchema = nativePathSchema.refine(
  isRecognizableAbsolutePath,
  "Native project results must contain absolute paths",
);

export const videoSourceStatusSchema = z.enum(["resolved", "missing", "relink_required"]);
export type VideoSourceStatus = z.infer<typeof videoSourceStatusSchema>;

export const videoSourceRecordSchema = z.discriminatedUnion("status", [
  z
    .object({
      assetId: projectUuidSchema,
      status: z.literal("resolved"),
      resolvedPath: absoluteNativePathSchema,
    })
    .strict(),
  z
    .object({
      assetId: projectUuidSchema,
      status: z.literal("missing"),
      resolvedPath: z.null(),
    })
    .strict(),
  z
    .object({
      assetId: projectUuidSchema,
      status: z.literal("relink_required"),
      resolvedPath: z.null(),
    })
    .strict(),
]);
export type VideoSourceRecord = z.infer<typeof videoSourceRecordSchema>;

export const openedVideoProjectSchema = z
  .object({
    path: absoluteNativePathSchema,
    document: videoProjectFileV1Schema,
    sources: z.array(videoSourceRecordSchema),
  })
  .strict()
  .superRefine((openedProject, context) => {
    const currentRevision = openedProject.document.revisions.find(
      (revision) => revision.id === openedProject.document.currentRevisionId,
    );
    const currentAssetId = currentRevision?.state.asset?.id;
    const sourceIds = new Set<string>();

    for (const [index, source] of openedProject.sources.entries()) {
      if (sourceIds.has(source.assetId)) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "assetId"],
          message: "Opened project source records must have unique asset IDs",
        });
      }
      sourceIds.add(source.assetId);
      if (source.assetId !== currentAssetId) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "assetId"],
          message: "Opened project source must belong to the current revision",
        });
      }
    }

    if (currentAssetId === undefined && openedProject.sources.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "An empty current revision cannot contain source records",
      });
    }
    if (currentAssetId !== undefined && !sourceIds.has(currentAssetId)) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "The current revision asset requires one source record",
      });
    }
  });
export type OpenedVideoProject = z.infer<typeof openedVideoProjectSchema>;
