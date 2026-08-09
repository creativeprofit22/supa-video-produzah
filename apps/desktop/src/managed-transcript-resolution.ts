import { VideoDomainError, type ProjectProjection } from "@supa-video/contracts";
import type { CaptionArtifactV1, TranscriptArtifactV1 } from "@supa-video/media";
import { selectRippleDeleteAffectedCaptionTracksV1 } from "@supa-video/project";

import type { VideoBackend } from "./video-ipc";

export type AffectedCaptionOperation =
  | {
      readonly type: "split" | "move" | "trim";
      readonly sequenceId: string;
    }
  | {
      readonly type: "ripple-delete";
      readonly sequenceId: string;
      readonly trackId: string;
      readonly clipId: string;
    };

export interface AffectedCaptionReference {
  readonly sequenceId: string;
  readonly captionTrackId: string;
  readonly activeCaptionArtifact: CaptionArtifactV1;
}

export interface ResolvedManagedTranscriptArtifact {
  readonly key: string;
  readonly artifact: TranscriptArtifactV1;
}

function activeCaptionReferences(
  projection: ProjectProjection,
  sequenceId: string,
): readonly AffectedCaptionReference[] {
  const sequence = projection.state.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) return [];

  return sequence.tracks.flatMap((track) =>
    track.kind === "caption" && track.activeCaptionArtifact !== undefined
      ? [
          {
            sequenceId,
            captionTrackId: track.id,
            activeCaptionArtifact: track.activeCaptionArtifact,
          },
        ]
      : [],
  );
}

export function selectAffectedCaptionReferences(
  projection: ProjectProjection,
  operation: AffectedCaptionOperation,
): readonly AffectedCaptionReference[] {
  if (operation.type !== "ripple-delete")
    return activeCaptionReferences(projection, operation.sequenceId);

  return selectRippleDeleteAffectedCaptionTracksV1({
    projection,
    sequenceId: operation.sequenceId,
    trackId: operation.trackId,
    clipId: operation.clipId,
  }).map((track) => ({
    sequenceId: operation.sequenceId,
    captionTrackId: track.id,
    activeCaptionArtifact: track.activeCaptionArtifact!,
  }));
}

function safeBackendDiagnostics(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof VideoDomainError) {
    const category =
      typeof error.details.category === "string" ? error.details.category : undefined;
    return {
      backendCode: error.code,
      ...(category === undefined ? {} : { backendCategory: category }),
    };
  }
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as Readonly<Record<string, unknown>>;
  return {
    ...(typeof candidate.code === "string" ? { backendCode: candidate.code } : {}),
    ...(typeof candidate.category === "string" ? { backendCategory: candidate.category } : {}),
  };
}

export async function resolveManagedTranscriptArtifacts(
  references: readonly AffectedCaptionReference[],
  loadManagedTranscriptArtifact: VideoBackend["loadManagedTranscriptArtifact"],
): Promise<readonly ResolvedManagedTranscriptArtifact[]> {
  const requestedKeys = [
    ...new Set(
      references.map(
        ({ activeCaptionArtifact }) => activeCaptionArtifact.transcriptArtifactIdentityKey,
      ),
    ),
  ];
  const resolved: ResolvedManagedTranscriptArtifact[] = [];

  for (const key of requestedKeys) {
    let artifact: TranscriptArtifactV1;
    try {
      artifact = await loadManagedTranscriptArtifact(key);
    } catch (error) {
      throw new VideoDomainError(
        "invalid_project",
        "The managed transcript artifact required by this timeline edit is unavailable",
        {
          reason: "managed_transcript_artifact_missing",
          transcriptArtifactIdentityKey: key,
          ...safeBackendDiagnostics(error),
        },
      );
    }
    if (artifact.identity.key !== key) {
      throw new VideoDomainError(
        "invalid_project",
        "The managed transcript artifact does not match the requested identity",
        {
          reason: "managed_transcript_artifact_key_mismatch",
          transcriptArtifactIdentityKey: key,
          returnedTranscriptArtifactIdentityKey: artifact.identity.key,
        },
      );
    }
    resolved.push({ key, artifact });
  }

  return resolved;
}
