import { type VideoProjectFileV1, videoProjectFileV1Schema } from "@supa-video/contracts";

import { deepFreeze } from "./freeze.js";

export interface CreateProjectInput {
  readonly projectId: string;
  readonly initialRevisionId: string;
  readonly name: string;
  readonly createdAt: string;
}

export function createProject(input: CreateProjectInput): Readonly<VideoProjectFileV1> {
  const project = videoProjectFileV1Schema.parse({
    schemaVersion: 1,
    id: input.projectId,
    name: input.name,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    currentRevisionId: input.initialRevisionId,
    revisions: [
      {
        id: input.initialRevisionId,
        parentRevisionId: null,
        sequenceNumber: 0,
        committedAt: input.createdAt,
        commandSummary: "Created project",
        state: { asset: null, sequence: null },
      },
    ],
  });
  return deepFreeze(project);
}
