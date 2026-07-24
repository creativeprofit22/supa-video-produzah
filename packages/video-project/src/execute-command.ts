import {
  type ProjectRevision,
  VideoDomainError,
  type VideoProjectCommand,
  type VideoProjectFileV1,
  type VideoProjectState,
  compareRationalTimes,
  microsecondsToSourceFrames,
  rateOf,
  ratesEqual,
  videoProjectCommandSchema,
  videoProjectFileV1Schema,
} from "@supa-video/contracts";

import { deepFreeze } from "./freeze.js";

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new VideoDomainError("invalid_command", message, details);
}

export function currentRevision(document: Readonly<VideoProjectFileV1>): ProjectRevision {
  const revision = document.revisions.find(
    (candidate) => candidate.id === document.currentRevisionId,
  );
  if (revision === undefined) {
    throw new VideoDomainError("invalid_project", "Current revision is missing");
  }
  return revision;
}

function validateSourceRange(
  state: VideoProjectState,
  sourceIn: { value: number; rateNumerator: number; rateDenominator: number },
  sourceOut: { value: number; rateNumerator: number; rateDenominator: number },
): void {
  if (state.asset === null || state.sequence === null) {
    invalid("A trim requires one asset and one sequence");
  }
  const sequenceRate = state.sequence.rate;
  if (!ratesEqual(rateOf(sourceIn), sequenceRate) || !ratesEqual(rateOf(sourceOut), sequenceRate)) {
    throw new VideoDomainError("mixed_rate", "Clip and sequence rates must match exactly");
  }
  if (compareRationalTimes(sourceIn, sourceOut) >= 0) {
    throw new VideoDomainError("invalid_range", "Trim must retain at least one source frame");
  }
  const sourceDuration = microsecondsToSourceFrames(
    state.asset.probe.durationMicroseconds,
    sequenceRate,
  );
  if (sourceOut.value > sourceDuration.value) {
    throw new VideoDomainError("invalid_range", "Trim exceeds the probed source duration", {
      sourceOut: sourceOut.value,
      sourceDuration: sourceDuration.value,
    });
  }
}

function applyCommand(state: VideoProjectState, command: VideoProjectCommand): VideoProjectState {
  switch (command.type) {
    case "ImportAsset": {
      if (state.asset !== null) {
        invalid("Phase 1 allows exactly one imported asset");
      }
      return { ...state, asset: command.asset };
    }
    case "CreateSequence": {
      if (state.asset === null) {
        invalid("Import an asset before creating its sequence");
      }
      if (state.sequence !== null) {
        invalid("Phase 1 allows exactly one sequence");
      }
      if (command.sequence.videoTracks[0].clips.length !== 0) {
        invalid("CreateSequence must start with an empty track");
      }
      if (!ratesEqual(command.sequence.rate, state.asset.probe.averageFrameRate)) {
        throw new VideoDomainError("mixed_rate", "Sequence rate must match the asset average rate");
      }
      return { ...state, sequence: command.sequence };
    }
    case "InsertClip": {
      if (state.asset === null || state.sequence === null) {
        invalid("InsertClip requires one asset and one sequence");
      }
      const track = state.sequence.videoTracks[0];
      if (command.sequenceId !== state.sequence.id || command.trackId !== track.id) {
        invalid("InsertClip references an unknown sequence or track");
      }
      if (track.clips.length !== 0) {
        invalid("Phase 1 allows exactly one clip");
      }
      if (command.clip.assetId !== state.asset.id) {
        invalid("InsertClip references an unknown asset");
      }
      validateSourceRange(state, command.clip.sourceIn, command.clip.sourceOut);
      return {
        ...state,
        sequence: {
          ...state.sequence,
          videoTracks: [{ ...track, clips: [command.clip] }],
        },
      };
    }
    case "TrimClip": {
      if (state.sequence === null) {
        invalid("TrimClip requires a sequence");
      }
      const track = state.sequence.videoTracks[0];
      const clip = track.clips[0];
      if (
        clip === undefined ||
        command.sequenceId !== state.sequence.id ||
        command.trackId !== track.id ||
        command.clipId !== clip.id
      ) {
        invalid("TrimClip references an unknown sequence, track, or clip");
      }
      validateSourceRange(state, command.sourceIn, command.sourceOut);
      return {
        ...state,
        sequence: {
          ...state.sequence,
          videoTracks: [
            {
              ...track,
              clips: [{ ...clip, sourceIn: command.sourceIn, sourceOut: command.sourceOut }],
            },
          ],
        },
      };
    }
  }
}

const commandSummaries: Record<VideoProjectCommand["type"], string> = {
  ImportAsset: "Imported asset",
  CreateSequence: "Created sequence",
  InsertClip: "Inserted clip",
  TrimClip: "Applied trim",
};

export function executeCommand(
  inputDocument: Readonly<VideoProjectFileV1>,
  inputCommand: unknown,
): Readonly<VideoProjectFileV1> {
  const documentResult = videoProjectFileV1Schema.safeParse(inputDocument);
  if (!documentResult.success) {
    throw new VideoDomainError(
      "invalid_project",
      "Cannot execute a command on an invalid project",
      {
        issues: documentResult.error.issues,
      },
    );
  }
  const commandResult = videoProjectCommandSchema.safeParse(inputCommand);
  if (!commandResult.success) {
    throw new VideoDomainError("invalid_command", "Command failed strict validation", {
      issues: commandResult.error.issues,
    });
  }
  const document = documentResult.data;
  const command = commandResult.data;
  const base = currentRevision(document);
  if (command.baseRevisionId !== base.id) {
    throw new VideoDomainError("stale_revision", "Command base revision is stale", {
      expected: base.id,
      received: command.baseRevisionId,
    });
  }
  if (document.revisions.some((revision) => revision.id === command.commandId)) {
    invalid("Command ID has already been committed", { commandId: command.commandId });
  }

  const baseIndex = document.revisions.findIndex((revision) => revision.id === base.id);
  const retainedRevisions = document.revisions.slice(0, baseIndex + 1);
  const state = applyCommand(base.state, command);
  const revision: ProjectRevision = {
    id: command.commandId,
    parentRevisionId: base.id,
    sequenceNumber: retainedRevisions.length,
    committedAt: command.issuedAt,
    commandSummary: commandSummaries[command.type],
    state,
  };
  const nextDocument = videoProjectFileV1Schema.parse({
    ...document,
    updatedAt: command.issuedAt,
    currentRevisionId: revision.id,
    revisions: [...retainedRevisions, revision],
  });
  return deepFreeze(nextDocument);
}
