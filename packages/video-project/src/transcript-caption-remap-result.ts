import {
  VideoDomainError,
  createRationalTime,
  type ProjectRevisionDescriptorV2,
  type RationalRate,
  type RationalTime,
} from "@supa-video/contracts";
import {
  captionArtifactV1Schema,
  unicodeScalarLength,
  validateCaptionArtifactV1,
  type CaptionArtifactV1,
  type CaptionCueV1,
  type CaptionValidationProfileV1,
} from "@supa-video/media";

import { sourceLinks } from "./transcript-caption-artifact.js";
import { displayUnits, wrapUnits } from "./transcript-caption-display.js";
import { compareTranscriptTimelineOccurrences } from "./transcript-edit-mapping.js";
import { frameConstraintsFor } from "./transcript-caption-input.js";
import { remapError, type ValidatedRemapInput } from "./transcript-caption-remap-input.js";
import type {
  CaptionRemapOutcome,
  ClassifiedCue,
  CueCandidate,
} from "./transcript-caption-remap-outcome.js";
import type { FrameConstraints } from "./transcript-caption-internal.js";

export interface CaptionRemapTargetCue {
  readonly cueId: string;
  readonly start: RationalTime;
  readonly end: RationalTime;
}

export interface CaptionCueRemapRecord {
  readonly sourceCueId: string;
  readonly outcome: CaptionRemapOutcome;
  readonly targetCues: readonly CaptionRemapTargetCue[];
}

export interface CaptionRemapReport {
  readonly schemaVersion: 1;
  readonly sourceProjectRevision: ProjectRevisionDescriptorV2;
  readonly targetProjectRevision: ProjectRevisionDescriptorV2;
  readonly cues: readonly CaptionCueRemapRecord[];
}

export interface RemapCaptionArtifactV1Result {
  readonly artifact: CaptionArtifactV1;
  readonly report: CaptionRemapReport;
}

interface BuiltCueCandidate extends CueCandidate {
  readonly cue: CaptionCueV1;
}

function assignCueIds(
  candidates: readonly BuiltCueCandidate[],
  sourceCueIds: readonly string[],
): readonly BuiltCueCandidate[] {
  const reservedIds = new Set(sourceCueIds);
  const assignedIds = new Set<string>();
  let generatedOrdinal = 1;
  const nextGeneratedId = (): string => {
    while (true) {
      const candidate = `caption-remap-${String(generatedOrdinal).padStart(6, "0")}`;
      generatedOrdinal += 1;
      if (!reservedIds.has(candidate) && !assignedIds.has(candidate)) return candidate;
    }
  };

  const bySource = new Map<number, BuiltCueCandidate[]>();
  for (const candidate of candidates) {
    const siblings = bySource.get(candidate.sourceOrdinal) ?? [];
    siblings.push(candidate);
    bySource.set(candidate.sourceOrdinal, siblings);
  }
  const result: BuiltCueCandidate[] = [];
  for (const sourceOrdinal of [...bySource.keys()].sort((left, right) => left - right)) {
    const siblings = bySource.get(sourceOrdinal)!.sort(compareBuiltCandidates);
    siblings.forEach((candidate, siblingIndex) => {
      const cueId = siblingIndex === 0 ? candidate.sourceCue.cueId : nextGeneratedId();
      assignedIds.add(cueId);
      result.push({ ...candidate, cue: { ...candidate.cue, cueId } });
    });
  }
  return result;
}

function compareBuiltCandidates(left: BuiltCueCandidate, right: BuiltCueCandidate): number {
  return (
    left.cue.start.value - right.cue.start.value ||
    left.cue.end.value - right.cue.end.value ||
    left.sourceOrdinal - right.sourceOrdinal ||
    left.placement.translation - right.placement.translation
  );
}

function candidateStart(candidate: CueCandidate): number {
  return (
    candidate.cue?.start.value ??
    Math.min(
      ...candidate.placement.occurrences.map(({ timelineRange }) => timelineRange.start.value),
    )
  );
}

function minimumCpsFrames(
  scalarCount: number,
  rate: RationalRate,
  maximumCharactersPerSecond: number,
): number | null {
  const numerator = BigInt(scalarCount) * BigInt(rate.numerator);
  const denominator = BigInt(maximumCharactersPerSecond) * BigInt(rate.denominator);
  const value = (numerator + denominator - 1n) / denominator;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function constraintsUnsatisfied(
  cueId: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw remapError(
    "invalid_range",
    "Caption remap constraints cannot be satisfied",
    "caption_remap_constraints_unsatisfied",
    { cueId, ...details },
  );
}

function buildPartialCue(
  candidate: CueCandidate,
  timelineRate: RationalRate,
  constraints: FrameConstraints,
  artifactIdentityKey: string,
  validationProfile: CaptionValidationProfileV1,
  nextStart?: number,
): CaptionCueV1 {
  const occurrences = [...candidate.placement.occurrences].sort(
    compareTranscriptTimelineOccurrences,
  );
  try {
    const lines = wrapUnits(displayUnits(occurrences), validationProfile);
    if (lines === null)
      constraintsUnsatisfied(candidate.sourceCue.cueId, { constraint: "wrapping" });
    const start = candidateStart(candidate);
    const rawEnd = Math.max(...occurrences.map(({ timelineRange }) => timelineRange.end.value));
    const scalarCount = lines.reduce((total, line) => total + unicodeScalarLength(line), 0);
    const cpsFrames = minimumCpsFrames(
      scalarCount,
      timelineRate,
      validationProfile.maxCharactersPerSecond,
    );
    if (cpsFrames === null)
      constraintsUnsatisfied(candidate.sourceCue.cueId, { constraint: "cps" });
    const end = Math.max(rawEnd, start + constraints.minimumDurationFrames, start + cpsFrames);
    const latestEnd = Math.min(
      start + constraints.maximumDurationFrames,
      nextStart ?? Number.MAX_SAFE_INTEGER,
    );
    if (!Number.isSafeInteger(end) || end <= start || end > latestEnd) {
      constraintsUnsatisfied(candidate.sourceCue.cueId, { constraint: "duration" });
    }
    return {
      schemaVersion: 1,
      cueId: candidate.sourceCue.cueId,
      start: createRationalTime(start, timelineRate),
      end: createRationalTime(end, timelineRate),
      lines: [...lines],
      anchor: { ...candidate.sourceCue.anchor },
      sourceLinks: [...sourceLinks(occurrences, artifactIdentityKey)],
    };
  } catch (error) {
    if (
      error instanceof VideoDomainError &&
      error.details.reason === "caption_remap_constraints_unsatisfied"
    ) {
      throw error;
    }
    constraintsUnsatisfied(candidate.sourceCue.cueId, { constraint: "wrapping" });
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function buildCandidates(
  candidates: readonly CueCandidate[],
  artifact: CaptionArtifactV1,
): readonly BuiltCueCandidate[] {
  let constraints: FrameConstraints;
  try {
    constraints = frameConstraintsFor(
      artifact.validationProfile,
      artifact.timelineRate,
      candidates.length > 0,
    );
  } catch {
    constraintsUnsatisfied("$artifact", { constraint: "durationProfile" });
  }

  const ordered = [...candidates].sort(
    (left, right) =>
      candidateStart(left) - candidateStart(right) ||
      left.sourceOrdinal - right.sourceOrdinal ||
      left.placement.translation - right.placement.translation,
  );
  const built = ordered.map((candidate, index): BuiltCueCandidate => {
    const nextStart =
      ordered[index + 1] === undefined ? undefined : candidateStart(ordered[index + 1]!);
    return {
      ...candidate,
      cue:
        candidate.cue ??
        buildPartialCue(
          candidate,
          artifact.timelineRate,
          constraints,
          artifact.transcriptArtifactIdentityKey,
          artifact.validationProfile,
          nextStart,
        ),
    };
  });
  if (built.length > 100_000) constraintsUnsatisfied("$artifact", { constraint: "cueCount" });
  const canonical = [...built].sort(compareBuiltCandidates);
  for (let index = 1; index < canonical.length; index += 1) {
    const previous = canonical[index - 1]!.cue;
    const current = canonical[index]!.cue;
    if (current.start.value < previous.end.value) {
      constraintsUnsatisfied(current.cueId, {
        constraint: "overlap",
        previousCueId: previous.cueId,
      });
    }
  }
  return [
    ...assignCueIds(
      canonical,
      artifact.cues.map(({ cueId }) => cueId),
    ),
  ].sort(compareBuiltCandidates);
}

export function buildRemapResult(
  validated: ValidatedRemapInput,
  classified: readonly ClassifiedCue[],
): RemapCaptionArtifactV1Result {
  const built = buildCandidates(
    classified.flatMap(({ candidates }) => candidates),
    validated.artifact,
  );
  const candidate = {
    ...validated.artifact,
    trackLink: {
      ...validated.artifact.trackLink,
      projectRevision: validated.timeline.projectRevision,
    },
    cues: built.map(({ cue }) => cue),
  };
  const validation = validateCaptionArtifactV1(candidate);
  if (!validation.valid) {
    throw remapError(
      "invalid_range",
      "Generated caption artifact failed strict validation",
      "generated_caption_invalid",
      { issues: validation.issues },
    );
  }
  const artifact = captionArtifactV1Schema.parse(candidate);
  const report: CaptionRemapReport = {
    schemaVersion: 1,
    sourceProjectRevision: validated.artifact.trackLink.projectRevision,
    targetProjectRevision: validated.timeline.projectRevision,
    cues: classified.map(({ sourceCue, outcome }, sourceOrdinal) => ({
      sourceCueId: sourceCue.cueId,
      outcome,
      targetCues: built
        .filter((target) => target.sourceOrdinal === sourceOrdinal)
        .sort(compareBuiltCandidates)
        .map(({ cue }) => ({ cueId: cue.cueId, start: cue.start, end: cue.end })),
    })),
  };
  return freezeDeep({ artifact, report });
}
