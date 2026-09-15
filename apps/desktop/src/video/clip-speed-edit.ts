import {
  clipSpeedSchema,
  clipTimelineDuration,
  isTrackLocked,
  videoProjectStateV2Schema,
  VideoDomainError,
  type ClipSpeed,
  type VideoProjectStateV2,
} from "@supa-video/contracts";

export interface ClipSpeedEdit {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly speed: ClipSpeed;
}

/** Frontend preflight; the native atomic command service remains authoritative. */
export function prepareClipSpeedState(
  state: VideoProjectStateV2,
  edit: ClipSpeedEdit,
  validateFinal = true,
  contextOnly = false,
): VideoProjectStateV2 {
  const fail = (message: string, category: string): never => {
    throw new VideoDomainError("invalid_range", message, { category });
  };
  const speed = clipSpeedSchema.parse(edit.speed);
  const next = structuredClone(state);
  const sequence = next.sequences.find(({ id }) => id === edit.sequenceId);
  const track = sequence?.tracks.find(({ id }) => id === edit.trackId);
  if (!sequence || track?.kind !== "video")
    return fail("Speed requires a direct-asset video track", "speed_video_asset_only");
  if (!contextOnly && isTrackLocked(track))
    return fail("Unlock the track before changing speed", "track_locked");
  const clip = track.clips.find(({ id }) => id === edit.clipId);
  if (!clip || clip.source.kind !== "asset")
    return fail("Speed requires a direct video asset", "speed_video_asset_only");
  const asset = next.assets.find(
    ({ id }) => clip.source.kind === "asset" && id === clip.source.assetId,
  );
  if (!asset) return fail("Speed requires a video asset", "speed_video_asset_only");
  const nested = next.sequences.some((candidate) =>
    candidate.tracks.some(
      (candidateTrack) =>
        candidateTrack.kind !== "caption" &&
        candidateTrack.clips.some(
          (item) => item.source.kind === "sequence" && item.source.sequenceId === sequence.id,
        ),
    ),
  );
  if (nested)
    return fail(
      "Speed is unavailable inside nested child sequences",
      "speed_nested_sequence_unsupported",
    );
  const managed = sequence.tracks
    .filter((item) => item.kind === "caption")
    .flatMap((item) =>
      item.activeCaptionArtifact ? [item.activeCaptionArtifact.sourceIdentity] : [],
    );
  if (
    managed.some(
      (identity) =>
        !asset.contentIdentity ||
        (identity.digest === asset.contentIdentity.digest &&
          identity.byteLength === asset.contentIdentity.byteLength),
    )
  )
    return fail("Speed cannot retime managed captions", "speed_managed_captions_unsupported");
  if (contextOnly) return next;
  clipTimelineDuration({ in: clip.sourceIn, out: clip.sourceOut }, sequence.rate, speed);
  if (speed.numerator === speed.denominator) delete clip.speed;
  else clip.speed = speed;
  if (validateFinal) {
    const clips = [...track.clips].sort((a, b) => a.timelineStart.value - b.timelineStart.value);
    for (let i = 1; i < clips.length; i += 1) {
      const previous = clips[i - 1]!;
      const end =
        previous.timelineStart.value +
        clipTimelineDuration(
          { in: previous.sourceIn, out: previous.sourceOut },
          sequence.rate,
          previous.speed,
        ).value;
      if (end > clips[i]!.timelineStart.value)
        return fail("Speed would overlap the next clip. Move or trim it first.", "clip_overlap");
    }
    return videoProjectStateV2Schema.parse(next);
  }
  return next;
}
