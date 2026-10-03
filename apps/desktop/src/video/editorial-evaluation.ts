import type { ProjectProjection } from "@supa-video/contracts";
import type { NarrativeBeat } from "@supa-video/produce";

import type { MusicBeatQcInput } from "../use-music-beats";
import { evaluateEditorial, type EditorialEvaluation } from "@supa-video/qc";

const noMusicBeats: MusicBeatQcInput = { musicBeatsUs: [], musicBeatsFromTempoFallback: false };

/**
 * Editorial evaluation for the exact revision being exported. The render
 * worker rejects the request unless this matches the open revision's state
 * hash, so it must be computed from the same projection the plan came from.
 * `musicBeats` are the timeline music beats of that projection
 * (`musicBeatQcInputForProjection`); they are never narrative beats.
 */
export async function editorialEvaluationFor(
  projection: Readonly<ProjectProjection>,
  beats: readonly NarrativeBeat[] = [],
  musicBeats: MusicBeatQcInput = noMusicBeats,
): Promise<EditorialEvaluation> {
  const sequence = projection.state.sequences.find(
    (candidate) => candidate.id === projection.state.activeSequenceId,
  );
  if (sequence === undefined) throw new Error("The project has no active sequence to check");
  return evaluateEditorial({
    revisionId: projection.revision.id,
    revisionStateHash: projection.revision.stateHash,
    sequence,
    assets: projection.state.assets,
    beats,
    musicBeatsUs: musicBeats.musicBeatsUs,
    musicBeatsFromTempoFallback: musicBeats.musicBeatsFromTempoFallback,
  });
}
