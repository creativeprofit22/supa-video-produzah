import type { ProjectProjection } from "@supa-video/contracts";
import type { FirstCutProposal } from "@supa-video/produce";

/** A first cut put on the timeline, with the tracks its command group inserted. */
export interface AppliedFirstCut {
  readonly firstCut: FirstCutProposal;
  readonly sequenceId: string;
  readonly trackIds: readonly string[];
}

/**
 * The applied first cut while every track it inserted is still in its
 * sequence. Undo (or deleting a first-cut track) hides it; redo restores it.
 * Revision numbers only grow, even on undo, so track presence is the signal.
 */
export function firstCutOnTimeline(
  applied: AppliedFirstCut | null,
  projection: ProjectProjection | null,
): FirstCutProposal | null {
  if (applied === null || projection === null) return null;
  if (applied.firstCut.projectId !== projection.projectId) return null;
  if (applied.trackIds.length === 0) return null;
  const sequence = projection.state.sequences.find(({ id }) => id === applied.sequenceId);
  if (sequence === undefined) return null;
  const present = new Set(sequence.tracks.map(({ id }) => id));
  return applied.trackIds.every((trackId) => present.has(trackId)) ? applied.firstCut : null;
}
