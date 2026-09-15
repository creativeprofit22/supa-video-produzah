import {
  clipSpeedSchema,
  clipTimelineDuration,
  isTrackLocked,
  videoProjectStateV2Schema,
  type ClipSpeed,
  type ProjectCommandV2,
  type VideoProjectStateV2,
} from "@supa-video/contracts";

export interface BulkClipTarget {
  sequenceId: string;
  trackId: string;
  clipId: string;
}
export type BulkClipAction =
  { type: "speed"; speed: ClipSpeed } | { type: "move"; deltaFrames: number } | { type: "delete" };

/** One private snapshot, commands against original targets, and only final-state validation. */
export function planBulkClipEdit(
  state: VideoProjectStateV2,
  targets: readonly BulkClipTarget[],
  action: BulkClipAction,
  newId: () => string,
): ProjectCommandV2[] {
  if (!targets.length || targets.length > 100)
    throw new Error("Select between 1 and 100 media clips; no changes were applied.");
  if (action.type === "move" && !Number.isSafeInteger(action.deltaFrames))
    throw new Error("Relative move requires a signed whole number of sequence frames.");
  const speed = action.type === "speed" ? clipSpeedSchema.parse(action.speed) : undefined;
  const next = structuredClone(state);
  const nested = new Set<string>();
  const index = new Map<
    string,
    {
      sequence: (typeof next.sequences)[number];
      track: Exclude<(typeof next.sequences)[number]["tracks"][number], { kind: "caption" }>;
      clip: Exclude<
        (typeof next.sequences)[number]["tracks"][number],
        { kind: "caption" }
      >["clips"][number];
    }
  >();
  const managed = new Set<string>();
  for (const sequence of next.sequences)
    for (const track of sequence.tracks) {
      if (track.kind === "caption") {
        if (track.activeCaptionArtifact) managed.add(sequence.id);
        continue;
      }
      for (const clip of track.clips) {
        if (clip.source.kind === "sequence") nested.add(clip.source.sequenceId);
        index.set(`${sequence.id}:${track.id}:${clip.id}`, { sequence, track, clip });
      }
    }
  const seen = new Set<string>();
  const removed = new Set<string>();
  const affected = new Set<string>();
  const commands: ProjectCommandV2[] = [];
  for (const selected of targets) {
    // Inspector metadata is not part of the strict canonical command target.
    const target: BulkClipTarget = {
      sequenceId: selected.sequenceId,
      trackId: selected.trackId,
      clipId: selected.clipId,
    };
    const key = `${target.sequenceId}:${target.trackId}:${target.clipId}`;
    const entry = index.get(key);
    if (!entry || seen.has(key))
      throw new Error("Selection is stale or duplicated; no changes were applied.");
    seen.add(key);
    const { sequence, track, clip } = entry;
    if (isTrackLocked(track))
      throw new Error("All selected tracks must be unlocked; no changes were applied.");
    if (clip.source.kind !== "asset" || nested.has(sequence.id))
      throw new Error(
        "Bulk timing and deletion in nested sequence contexts are unsupported; no changes were applied.",
      );
    if (managed.has(sequence.id))
      throw new Error(
        "Bulk timing and deletion with managed captions are unsupported. Captions cannot be silently detached; no changes were applied.",
      );
    affected.add(sequence.id);
    if (action.type === "speed") {
      if (track.kind !== "video")
        throw new Error(
          "Bulk speed supports direct video clips only; audio selections are unsupported.",
        );
      if (
        (clip.speed?.numerator ?? 1) * speed!.denominator ===
        speed!.numerator * (clip.speed?.denominator ?? 1)
      )
        continue;
      clip.speed = speed!;
      commands.push({ type: "SetClipSpeed", commandId: newId(), ...target, speed: speed! });
    } else if (action.type === "move") {
      const value = clip.timelineStart.value + action.deltaFrames;
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("Relative move is negative or out of bounds; no changes were applied.");
      if (action.deltaFrames === 0) continue;
      clip.timelineStart = { ...clip.timelineStart, value };
      commands.push({
        type: "MoveClip",
        commandId: newId(),
        ...target,
        timelineStart: clip.timelineStart,
      });
    } else {
      removed.add(key);
      commands.push({ type: "RemoveClip", commandId: newId(), ...target });
    }
  }
  for (const sequence of next.sequences) {
    if (!affected.has(sequence.id)) continue;
    for (const track of sequence.tracks) {
      if (track.kind === "caption") continue;
      track.clips = track.clips.filter(
        (clip) => !removed.has(`${sequence.id}:${track.id}:${clip.id}`),
      );
      const ordered = [...track.clips].sort(
        (a, b) => a.timelineStart.value - b.timelineStart.value,
      );
      let end = 0;
      for (const clip of ordered) {
        if (clip.timelineStart.value < end)
          throw new Error("Bulk edit would cause a final clip overlap; no changes were applied.");
        end =
          clip.timelineStart.value +
          clipTimelineDuration(
            { in: clip.sourceIn, out: clip.sourceOut },
            sequence.rate,
            clip.speed,
          ).value;
        if (!Number.isSafeInteger(end)) throw new Error("Bulk edit exceeds timeline bounds.");
      }
    }
  }
  videoProjectStateV2Schema.parse(next);
  return commands;
}
