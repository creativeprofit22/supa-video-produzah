import { createRationalTime, type RationalRate, type RationalTime } from "@supa-video/contracts";
import {
  captionArtifactV1Schema,
  validateCaptionArtifactV1,
  type CaptionArtifactV1,
  type CaptionCueV1,
  type CaptionSourceLinkV1,
} from "@supa-video/media";

import { wrapUnits } from "./transcript-caption-display.js";
import { finalCueEnd, type CueGroup } from "./transcript-caption-grouping.js";
import {
  captionError,
  spansOverlap,
  type FrameConstraints,
  type LogicalOccurrence,
  type ValidatedCaptionInput,
} from "./transcript-caption-internal.js";

export function sourceLinks(
  occurrences: readonly LogicalOccurrence[],
  artifactIdentityKey: string,
): readonly CaptionSourceLinkV1[] {
  const links: CaptionSourceLinkV1[] = [];
  for (const occurrence of occurrences) {
    let merged: CaptionSourceLinkV1 = {
      transcriptArtifactIdentityKey: artifactIdentityKey,
      sourceStartUs: occurrence.sourceStartUs,
      sourceEndUs: occurrence.sourceEndUs,
      transcriptWordIds: [occurrence.wordId],
    };
    while (links.length > 0 && spansOverlap(links.at(-1)!, merged)) {
      const previous = links.pop()!;
      const transcriptWordIds = [...previous.transcriptWordIds];
      for (const wordId of merged.transcriptWordIds) {
        if (!transcriptWordIds.includes(wordId)) transcriptWordIds.push(wordId);
      }
      merged = {
        transcriptArtifactIdentityKey: artifactIdentityKey,
        sourceStartUs: Math.min(previous.sourceStartUs, merged.sourceStartUs),
        sourceEndUs: Math.max(previous.sourceEndUs, merged.sourceEndUs),
        transcriptWordIds,
      };
    }
    links.push(merged);
  }
  return links;
}

function anchorFor(input: ValidatedCaptionInput): CaptionCueV1["anchor"] {
  const { alignment } = input.style;
  const { safeArea } = input.validationProfile;
  const horizontalStart = safeArea.leftPermille;
  const horizontalEnd = 1_000 - safeArea.rightPermille;
  const verticalStart = safeArea.topPermille;
  const verticalEnd = 1_000 - safeArea.bottomPermille;
  return {
    xPermille:
      alignment.horizontal === "left"
        ? horizontalStart
        : alignment.horizontal === "right"
          ? horizontalEnd
          : Math.floor((horizontalStart + horizontalEnd) / 2),
    yPermille:
      alignment.vertical === "top"
        ? verticalStart
        : alignment.vertical === "bottom"
          ? verticalEnd
          : Math.floor((verticalStart + verticalEnd) / 2),
  };
}

function cueTime(value: number, rate: RationalRate): RationalTime {
  return createRationalTime(value, rate);
}

function buildCues(
  groups: readonly CueGroup[],
  input: ValidatedCaptionInput,
  constraints: FrameConstraints,
): readonly CaptionCueV1[] {
  return groups.map((group, index) => {
    const nextStart = groups[index + 1]?.occurrences[0]?.timelineRange.start.value;
    const end = finalCueEnd(group, input, constraints, nextStart);
    if (end === null) {
      throw captionError(
        "invalid_range",
        "Caption constraints cannot be satisfied",
        "caption_constraints_unsatisfied",
        { cueOrdinal: index + 1 },
      );
    }
    const lines = wrapUnits(group.units, input.validationProfile)!;
    return {
      schemaVersion: 1,
      cueId: `caption-${String(index + 1).padStart(6, "0")}`,
      start: cueTime(group.occurrences[0]!.timelineRange.start.value, input.timeline.timelineRate),
      end: cueTime(end, input.timeline.timelineRate),
      lines: [...lines],
      anchor: anchorFor(input),
      sourceLinks: [...sourceLinks(group.occurrences, input.artifact.identity.key)],
    };
  });
}

export function buildCaptionArtifactV1(
  input: ValidatedCaptionInput,
  groups: readonly CueGroup[],
  constraints: FrameConstraints,
): CaptionArtifactV1 {
  const candidate = {
    schemaVersion: 1 as const,
    trackLink: {
      schemaVersion: 1 as const,
      projectId: input.timeline.projectId,
      projectRevision: input.timeline.projectRevision,
      sequenceId: input.timeline.sequenceId,
      captionTrackId: input.captionTrackId,
    },
    sourceIdentity: input.artifact.identity.sourceIdentity,
    transcriptArtifactIdentityKey: input.artifact.identity.key,
    language: input.language,
    timelineRate: input.timeline.timelineRate,
    style: input.style,
    validationProfile: input.validationProfile,
    cues: buildCues(groups, input, constraints),
  };
  const validation = validateCaptionArtifactV1(candidate);
  if (!validation.valid) {
    throw captionError(
      "invalid_range",
      "Generated caption artifact failed strict validation",
      "generated_caption_invalid",
      { issues: validation.issues },
    );
  }
  return captionArtifactV1Schema.parse(candidate);
}
