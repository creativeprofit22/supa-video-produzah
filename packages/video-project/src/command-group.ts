import {
  type CommandGroupRequest,
  type ProjectCommandV2,
  commandGroupRequestSchema,
  projectCommandSchemaV2,
} from "@supa-video/contracts";

export interface CommandGroupInput {
  readonly groupId: string;
  readonly projectId: string;
  readonly baseRevision: number;
  readonly commands: readonly ProjectCommandV2[];
}

export function buildCommandGroup(input: CommandGroupInput): Readonly<CommandGroupRequest> {
  return Object.freeze(
    commandGroupRequestSchema.parse({
      groupId: input.groupId,
      projectId: input.projectId,
      baseRevision: input.baseRevision,
      commands: input.commands.map((command) => projectCommandSchemaV2.parse(command)),
    }),
  );
}

export function buildProjectCommand(command: ProjectCommandV2): Readonly<ProjectCommandV2> {
  return Object.freeze(projectCommandSchemaV2.parse(command));
}
