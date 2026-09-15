import {
  VideoDomainError,
  isTrackLocked,
  type ProjectCommandV2,
  type ProjectProjection,
  type ProjectTrack,
  type VideoProjectStateV2,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import type { CaptionArtifactV1, TranscriptArtifactV1 } from "@supa-video/media";

import { identitiesEqual } from "./transcript-edit-mapping.js";

export type MediaProjectTrack = Exclude<ProjectTrack, { readonly kind: "caption" }>;
export type CaptionProjectTrack = Extract<ProjectTrack, { readonly kind: "caption" }>;
export type ApplyCaptionArtifactCommandV2 = Extract<
  ProjectCommandV2,
  { readonly type: "ApplyCaptionArtifact" }
>;

type LifecycleErrorCode = "invalid_project" | "invalid_range";

export interface CaptionLifecycleFailureReasons {
  readonly sequenceMissing: string;
  readonly sourceTrackMissing: string;
  readonly sourceTrackLocked: string;
  readonly sourceClipMissing: string;
  readonly sourceLineageMismatch: string;
  readonly sourceLineageAmbiguous: string;
  readonly captionTrackMissing: string;
  readonly captionTrackLocked: string;
  readonly activeArtifactMissing: string;
  readonly captionProjectMismatch: string;
  readonly captionSequenceMismatch: string;
  readonly captionTrackMismatch: string;
  readonly captionRevisionStale: string;
  readonly transcriptLineageMismatch: string;
}

export const captionLifecycleFailureReasons = Object.freeze({
  sequenceMissing: "caption_lifecycle_sequence_missing",
  sourceTrackMissing: "caption_lifecycle_source_track_missing",
  sourceTrackLocked: "caption_lifecycle_source_track_locked",
  sourceClipMissing: "caption_lifecycle_source_clip_missing",
  sourceLineageMismatch: "caption_lifecycle_source_lineage_mismatch",
  sourceLineageAmbiguous: "caption_lifecycle_source_lineage_ambiguous",
  captionTrackMissing: "caption_lifecycle_caption_track_missing",
  captionTrackLocked: "caption_lifecycle_caption_track_locked",
  activeArtifactMissing: "caption_lifecycle_active_artifact_missing",
  captionProjectMismatch: "caption_lifecycle_caption_project_mismatch",
  captionSequenceMismatch: "caption_lifecycle_caption_sequence_mismatch",
  captionTrackMismatch: "caption_lifecycle_caption_track_mismatch",
  captionRevisionStale: "caption_lifecycle_caption_revision_stale",
  transcriptLineageMismatch: "caption_lifecycle_transcript_lineage_mismatch",
} satisfies CaptionLifecycleFailureReasons);

export interface ActiveCaptionLifecycleTrack {
  readonly track: CaptionProjectTrack;
  readonly artifact: CaptionArtifactV1;
}

export interface CaptionLifecycleContext {
  readonly projection: ProjectProjection;
  readonly transcript: TranscriptArtifactV1;
  readonly state: VideoProjectStateV2;
  readonly sequence: VideoSequenceV2;
  readonly sourceTrack: MediaProjectTrack;
  readonly sourceAsset: VideoProjectStateV2["assets"][number];
  readonly sourceClip?: MediaProjectTrack["clips"][number];
  readonly activeCaptionTracks: readonly ActiveCaptionLifecycleTrack[];
}

export interface ResolveCaptionLifecycleContextInput {
  readonly projection: ProjectProjection;
  readonly transcript: TranscriptArtifactV1;
  readonly state: VideoProjectStateV2;
  readonly sequenceId: string;
  readonly sourceTrackId: string;
  readonly sourceClipId?: string;
  readonly captionTrackIds?: readonly string[];
  readonly reasons?: CaptionLifecycleFailureReasons;
}

export function captionLifecycleError(
  code: LifecycleErrorCode,
  message: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): VideoDomainError {
  return new VideoDomainError(code, message, { reason, ...details });
}

export function freezeLifecycleResult<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeLifecycleResult(child);
    Object.freeze(value);
  }
  return value;
}

function fail(
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw captionLifecycleError("invalid_project", message, reason, details);
}

export function resolveCaptionLifecycleContext(
  input: ResolveCaptionLifecycleContextInput,
): CaptionLifecycleContext {
  const reasons = input.reasons ?? captionLifecycleFailureReasons;
  const sequence = input.state.sequences.find(({ id }) => id === input.sequenceId);
  if (sequence === undefined) {
    fail(reasons.sequenceMissing, "Caption lifecycle target sequence does not exist", {
      sequenceId: input.sequenceId,
    });
  }

  const sourceTrack = sequence.tracks.find(({ id }) => id === input.sourceTrackId);
  if (sourceTrack === undefined || sourceTrack.kind === "caption") {
    fail(reasons.sourceTrackMissing, "Caption lifecycle source media track does not exist", {
      trackId: input.sourceTrackId,
    });
  }
  if (isTrackLocked(sourceTrack)) {
    fail(reasons.sourceTrackLocked, "Caption lifecycle source media track is locked", {
      trackId: sourceTrack.id,
    });
  }

  const sourceClip =
    input.sourceClipId === undefined
      ? undefined
      : sourceTrack.clips.find(({ id }) => id === input.sourceClipId);
  if (input.sourceClipId !== undefined && sourceClip === undefined) {
    fail(reasons.sourceClipMissing, "Caption lifecycle source clip does not exist", {
      clipId: input.sourceClipId,
    });
  }

  const requestedCaptionTrackIds =
    input.captionTrackIds === undefined ? undefined : new Set(input.captionTrackIds);
  const activeCaptionTracks: ActiveCaptionLifecycleTrack[] = [];
  for (const track of sequence.tracks) {
    if (track.kind !== "caption") continue;
    if (requestedCaptionTrackIds !== undefined && !requestedCaptionTrackIds.has(track.id)) continue;
    const artifact = track.activeCaptionArtifact;
    if (artifact === undefined) {
      if (requestedCaptionTrackIds !== undefined) {
        fail(reasons.activeArtifactMissing, "Caption target track has no active artifact", {
          trackId: track.id,
        });
      }
      continue;
    }
    if (isTrackLocked(track)) {
      fail(reasons.captionTrackLocked, "Caption target track is locked", { trackId: track.id });
    }
    if (artifact.trackLink.projectId !== input.projection.projectId) {
      fail(reasons.captionProjectMismatch, "Active caption artifact belongs to another project", {
        trackId: track.id,
      });
    }
    if (artifact.trackLink.sequenceId !== sequence.id) {
      fail(reasons.captionSequenceMismatch, "Active caption artifact belongs to another sequence", {
        trackId: track.id,
      });
    }
    if (artifact.trackLink.captionTrackId !== track.id) {
      fail(
        reasons.captionTrackMismatch,
        "Active caption artifact belongs to another caption track",
        {
          trackId: track.id,
        },
      );
    }
    if (artifact.trackLink.projectRevision.number >= input.projection.revision.number) {
      fail(reasons.captionRevisionStale, "Active caption artifact revision is not older", {
        trackId: track.id,
      });
    }
    if (
      input.transcript.identity.key !== artifact.transcriptArtifactIdentityKey ||
      !identitiesEqual(input.transcript.identity.sourceIdentity, artifact.sourceIdentity)
    ) {
      fail(reasons.transcriptLineageMismatch, "Transcript lineage does not match active captions", {
        trackId: track.id,
      });
    }
    activeCaptionTracks.push({ track, artifact });
  }

  if (requestedCaptionTrackIds !== undefined) {
    for (const trackId of requestedCaptionTrackIds) {
      const track = sequence.tracks.find(({ id }) => id === trackId);
      if (track === undefined || track.kind !== "caption") {
        fail(reasons.captionTrackMissing, "Caption target track does not exist", { trackId });
      }
    }
  }

  const matchingAssets = input.state.assets.filter(
    ({ contentIdentity }) =>
      contentIdentity !== undefined &&
      identitiesEqual(contentIdentity, input.transcript.identity.sourceIdentity),
  );
  if (matchingAssets.length !== 1) {
    fail(
      matchingAssets.length === 0 ? reasons.sourceLineageMismatch : reasons.sourceLineageAmbiguous,
      matchingAssets.length === 0
        ? "Transcript source identity does not match a project asset"
        : "Transcript source identity matches multiple project assets",
      { sourceDigest: input.transcript.identity.sourceIdentity.digest },
    );
  }
  const sourceAsset = matchingAssets[0]!;
  if (
    sourceClip !== undefined &&
    (sourceClip.source.kind !== "asset" || sourceClip.source.assetId !== sourceAsset.id)
  ) {
    fail(reasons.sourceLineageMismatch, "Source clip does not match the caption transcript", {
      clipId: sourceClip.id,
    });
  }

  if (
    sourceClip?.speed !== undefined &&
    sourceClip.speed.numerator !== sourceClip.speed.denominator
  ) {
    fail(
      "caption_lifecycle_speed_unsupported",
      "Managed caption lifecycle does not support retimed clips",
      { clipId: sourceClip.id },
    );
  }
  return {
    projection: input.projection,
    transcript: input.transcript,
    state: input.state,
    sequence,
    sourceTrack,
    sourceAsset,
    ...(sourceClip === undefined ? {} : { sourceClip }),
    activeCaptionTracks,
  };
}

export function buildApplyCaptionArtifactCommand(
  commandId: string,
  track: ActiveCaptionLifecycleTrack["track"],
  artifact: CaptionArtifactV1,
): ApplyCaptionArtifactCommandV2 {
  return {
    type: "ApplyCaptionArtifact",
    commandId,
    sequenceId: artifact.trackLink.sequenceId,
    trackId: track.id,
    artifact,
  };
}
