import type { ProjectProjection } from "@supa-video/contracts";
import type { NarrativeBeat } from "@supa-video/produce";
import { evaluateEditorial, type EditorialEvaluation } from "@supa-video/qc";

/**
 * Editorial evaluation for the exact revision being exported. The render
 * worker rejects the request unless this matches the open revision's state
 * hash, so it must be computed from the same projection the plan came from.
 */
export async function editorialEvaluationFor(
  projection: Readonly<ProjectProjection>,
  beats: readonly NarrativeBeat[] = [],
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
  });
}
