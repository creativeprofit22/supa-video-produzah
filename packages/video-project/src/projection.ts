import {
  isMediaTrack,
  type ProjectClip,
  type ProjectProjection,
  projectProjectionSchema,
  type ProjectTrack,
  type VideoSequenceV2,
} from "@supa-video/contracts";

export interface ActiveClipSelection {
  readonly sequence: VideoSequenceV2;
  readonly track: Extract<ProjectTrack, { kind: "video" | "audio" }>;
  readonly clip: ProjectClip;
}

export function selectActiveClip(projectionInput: ProjectProjection): ActiveClipSelection | null {
  const projection = projectProjectionSchema.parse(projectionInput);
  const sequence = projection.state.sequences.find(
    (candidate) => candidate.id === projection.state.activeSequenceId,
  );
  if (sequence === undefined) return null;
  for (const track of sequence.tracks) {
    if (isMediaTrack(track) && track.clips[0] !== undefined) {
      return { sequence, track, clip: track.clips[0] };
    }
  }
  return null;
}

export function renderableRevision(projectionInput: ProjectProjection) {
  const projection = projectProjectionSchema.parse(projectionInput);
  return Object.freeze({ revision: projection.revision, state: projection.state });
}
