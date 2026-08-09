import {
  commandGroupRequestSchema,
  isTrackLocked,
  projectProjectionSchema,
  rateOf,
  rescaleRationalTime,
  type CommandGroupRequest,
  type MediaContentIdentityV1,
  type ProjectClip,
  type ProjectProjection,
  type ProjectRevisionDescriptorV2,
  type RationalTime,
} from "@supa-video/contracts";
import { transcriptArtifactV1Schema, type TranscriptArtifactV1 } from "@supa-video/media";

import { prepareTranscriptEditCaptionLifecycleV1 } from "./split-clip-caption-lifecycle.js";
import {
  compileCommandDrafts,
  derivedUuid,
  materializeCommands,
  proposalSeed,
} from "./transcript-edit-command-compiler.js";
import {
  compareStrings,
  identitiesEqual,
  projectTranscriptToTimeline,
  resolveScope,
  time,
  transcriptError,
  type ProjectTranscriptScopeInput,
  type TranscriptFrameRange,
  type TranscriptTimelineOccurrence,
} from "./transcript-edit-mapping.js";

export interface TranscriptEditWordSnapshot {
  readonly occurrenceId: string;
  readonly wordId: string;
  readonly text: string;
  readonly sourceStartUs: number;
  readonly sourceEndUs: number;
}

export interface TranscriptEditKeptRange {
  readonly clipId: string;
  readonly assetId: string;
  readonly sourceRange: TranscriptFrameRange;
  readonly originalTimelineRange: TranscriptFrameRange;
  readonly previewTimelineRange: TranscriptFrameRange;
}

export interface TranscriptEditDeletedRange extends TranscriptEditKeptRange {
  readonly selectedWords: readonly TranscriptEditWordSnapshot[];
}

export interface TranscriptEditAssetIdentity {
  readonly assetId: string;
  readonly contentIdentity: MediaContentIdentityV1;
}

export interface TranscriptEditProposal {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly artifactIdentityKey: string;
  readonly sourceIdentity: MediaContentIdentityV1;
  readonly projectId: string;
  readonly projectRevision: ProjectRevisionDescriptorV2;
  readonly sequenceId: string;
  readonly trackId: string;
  readonly selectedOccurrenceIds: readonly string[];
  readonly assetIdentities: readonly TranscriptEditAssetIdentity[];
  readonly selectedWords: readonly TranscriptEditWordSnapshot[];
  readonly keptRanges: readonly TranscriptEditKeptRange[];
  readonly deletedRanges: readonly TranscriptEditDeletedRange[];
  readonly commandGroup: CommandGroupRequest;
}

export interface CreateTranscriptEditProposalInput extends ProjectTranscriptScopeInput {
  readonly deletedOccurrenceIds: readonly string[];
}

interface MergedDeletion {
  readonly clip: ProjectClip;
  readonly assetId: string;
  readonly sourceStart: number;
  sourceEnd: number;
  readonly selectedWords: readonly TranscriptEditWordSnapshot[];
  readonly originalTimelineStart: number;
  originalTimelineEnd: number;
}

function sourceFrameToTimelineFrame(
  clip: ProjectClip,
  sourceFrame: number,
  sequenceRate: { readonly numerator: number; readonly denominator: number },
): number {
  const sourceOffset = time(sourceFrame - clip.sourceIn.value, clip.sourceIn);
  return clip.timelineStart.value + rescaleRationalTime(sourceOffset, sequenceRate, "exact").value;
}

function rangeFromValues(start: number, end: number, template: RationalTime): TranscriptFrameRange {
  return Object.freeze({ start: time(start, template), end: time(end, template) });
}

function snapshot(occurrence: TranscriptTimelineOccurrence): TranscriptEditWordSnapshot {
  return Object.freeze({
    occurrenceId: occurrence.occurrenceId,
    wordId: occurrence.wordId,
    text: occurrence.text,
    sourceStartUs: occurrence.sourceStartUs,
    sourceEndUs: occurrence.sourceEndUs,
  });
}

function mergeSelectedOccurrences(
  selected: readonly TranscriptTimelineOccurrence[],
  scope: ReturnType<typeof resolveScope>,
): MergedDeletion[] {
  const byClip = new Map<string, TranscriptTimelineOccurrence[]>();
  for (const occurrence of selected) {
    const occurrences = byClip.get(occurrence.clipId) ?? [];
    occurrences.push(occurrence);
    byClip.set(occurrence.clipId, occurrences);
  }

  const merged: MergedDeletion[] = [];
  for (const [clipId, occurrences] of byClip) {
    const clip = scope.track.clips.find(({ id }) => id === clipId);
    if (clip === undefined || clip.source.kind !== "asset") {
      throw transcriptError(
        "invalid_project",
        "Selected transcript occurrence is stale",
        "stale_clip",
        {
          clipId,
        },
      );
    }
    occurrences.sort(
      (left, right) =>
        left.sourceRange.start.value - right.sourceRange.start.value ||
        left.sourceRange.end.value - right.sourceRange.end.value ||
        compareStrings(left.occurrenceId, right.occurrenceId),
    );
    for (const occurrence of occurrences) {
      const last = merged.at(-1);
      if (
        last !== undefined &&
        last.clip.id === clip.id &&
        occurrence.sourceRange.start.value <= last.sourceEnd
      ) {
        last.sourceEnd = Math.max(last.sourceEnd, occurrence.sourceRange.end.value);
        last.originalTimelineEnd = sourceFrameToTimelineFrame(
          clip,
          last.sourceEnd,
          scope.sequence.rate,
        );
        (last.selectedWords as TranscriptEditWordSnapshot[]).push(snapshot(occurrence));
      } else {
        const sourceStart = occurrence.sourceRange.start.value;
        const sourceEnd = occurrence.sourceRange.end.value;
        merged.push({
          clip,
          assetId: clip.source.assetId,
          sourceStart,
          sourceEnd,
          selectedWords: [snapshot(occurrence)],
          originalTimelineStart: sourceFrameToTimelineFrame(clip, sourceStart, scope.sequence.rate),
          originalTimelineEnd: sourceFrameToTimelineFrame(clip, sourceEnd, scope.sequence.rate),
        });
      }
    }
  }
  return merged.sort(
    (left, right) =>
      left.originalTimelineStart - right.originalTimelineStart ||
      left.originalTimelineEnd - right.originalTimelineEnd ||
      compareStrings(left.clip.id, right.clip.id),
  );
}

function deletedDurationBefore(deletions: readonly MergedDeletion[], frame: number): number {
  return deletions.reduce(
    (total, deletion) =>
      total +
      (deletion.originalTimelineEnd <= frame
        ? deletion.originalTimelineEnd - deletion.originalTimelineStart
        : 0),
    0,
  );
}

function buildPreviewRanges(deletions: readonly MergedDeletion[]): {
  keptRanges: readonly TranscriptEditKeptRange[];
  deletedRanges: readonly TranscriptEditDeletedRange[];
} {
  const keptRanges: TranscriptEditKeptRange[] = [];
  const byClip = new Map<string, MergedDeletion[]>();
  for (const deletion of deletions) {
    const values = byClip.get(deletion.clip.id) ?? [];
    values.push(deletion);
    byClip.set(deletion.clip.id, values);
  }

  for (const clipDeletions of byClip.values()) {
    const clip = clipDeletions[0]!.clip;
    const assetId = clipDeletions[0]!.assetId;
    let sourceStart = clip.sourceIn.value;
    for (const deletion of clipDeletions) {
      if (sourceStart < deletion.sourceStart) {
        const timelineStart = sourceFrameToTimelineFrame(
          clip,
          sourceStart,
          rateOf(clip.timelineStart),
        );
        const timelineEnd = deletion.originalTimelineStart;
        keptRanges.push(
          Object.freeze({
            clipId: clip.id,
            assetId,
            sourceRange: rangeFromValues(sourceStart, deletion.sourceStart, clip.sourceIn),
            originalTimelineRange: rangeFromValues(timelineStart, timelineEnd, clip.timelineStart),
            previewTimelineRange: rangeFromValues(
              timelineStart - deletedDurationBefore(deletions, timelineStart),
              timelineEnd - deletedDurationBefore(deletions, timelineEnd),
              clip.timelineStart,
            ),
          }),
        );
      }
      sourceStart = deletion.sourceEnd;
    }
    if (sourceStart < clip.sourceOut.value) {
      const timelineStart = sourceFrameToTimelineFrame(
        clip,
        sourceStart,
        rateOf(clip.timelineStart),
      );
      const timelineEnd = sourceFrameToTimelineFrame(
        clip,
        clip.sourceOut.value,
        rateOf(clip.timelineStart),
      );
      keptRanges.push(
        Object.freeze({
          clipId: clip.id,
          assetId,
          sourceRange: rangeFromValues(sourceStart, clip.sourceOut.value, clip.sourceIn),
          originalTimelineRange: rangeFromValues(timelineStart, timelineEnd, clip.timelineStart),
          previewTimelineRange: rangeFromValues(
            timelineStart - deletedDurationBefore(deletions, timelineStart),
            timelineEnd - deletedDurationBefore(deletions, timelineEnd),
            clip.timelineStart,
          ),
        }),
      );
    }
  }

  const deletedRanges = deletions.map((deletion) => {
    const previewFrame =
      deletion.originalTimelineStart -
      deletedDurationBefore(deletions, deletion.originalTimelineStart);
    return Object.freeze({
      clipId: deletion.clip.id,
      assetId: deletion.assetId,
      sourceRange: rangeFromValues(
        deletion.sourceStart,
        deletion.sourceEnd,
        deletion.clip.sourceIn,
      ),
      originalTimelineRange: rangeFromValues(
        deletion.originalTimelineStart,
        deletion.originalTimelineEnd,
        deletion.clip.timelineStart,
      ),
      previewTimelineRange: rangeFromValues(
        previewFrame,
        previewFrame,
        deletion.clip.timelineStart,
      ),
      selectedWords: Object.freeze([...deletion.selectedWords]),
    });
  });

  return {
    keptRanges: Object.freeze(
      keptRanges.sort(
        (left, right) =>
          left.originalTimelineRange.start.value - right.originalTimelineRange.start.value ||
          compareStrings(left.clipId, right.clipId),
      ),
    ),
    deletedRanges: Object.freeze(deletedRanges),
  };
}

export async function createTranscriptEditProposal(
  input: CreateTranscriptEditProposalInput,
): Promise<TranscriptEditProposal> {
  if (input.deletedOccurrenceIds.length === 0) {
    throw transcriptError(
      "invalid_range",
      "Transcript deletion selection cannot be empty",
      "empty_selection",
    );
  }
  const timeline = projectTranscriptToTimeline(input);
  const scope = resolveScope(input);
  const occurrencesById = new Map(
    timeline.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const selectedOccurrenceIds = [...new Set(input.deletedOccurrenceIds)].sort(compareStrings);
  const selected = selectedOccurrenceIds.map((id) => {
    const occurrence = occurrencesById.get(id);
    if (occurrence === undefined) {
      throw transcriptError(
        "invalid_range",
        "Transcript deletion contains an unknown occurrence",
        "unknown_occurrence",
        {
          occurrenceId: id,
        },
      );
    }
    return occurrence;
  });
  const deletions = mergeSelectedOccurrences(selected, scope);
  if (deletions.length === 0) {
    throw transcriptError(
      "invalid_range",
      "Transcript deletion does not remove timeline media",
      "no_op_selection",
    );
  }

  const seed = proposalSeed(input, scope.projection, selectedOccurrenceIds);
  const drafts = compileCommandDrafts(deletions, scope.sequence.id, scope.track.id);
  if (drafts.length > 100) {
    throw transcriptError(
      "invalid_range",
      "Transcript edit exceeds the atomic command limit",
      "command_limit_exceeded",
      { commandCount: drafts.length, commandLimit: 100 },
    );
  }
  const geometryCommands = await materializeCommands(drafts, seed);
  const commands = await prepareTranscriptEditCaptionLifecycleV1({
    projection: scope.projection,
    transcriptArtifact: input.artifact,
    commands: geometryCommands,
    createCommandId: (captionTrackId, ordinal) =>
      derivedUuid(seed, `caption-application:${ordinal}:${captionTrackId}`),
  });
  const groupId = await derivedUuid(seed, "command-group");
  const commandGroup = commandGroupRequestSchema.parse({
    groupId,
    projectId: scope.projection.projectId,
    baseRevision: scope.projection.revision.number,
    commands,
  });
  const { keptRanges, deletedRanges } = buildPreviewRanges(deletions);
  const selectedWords = Object.freeze(selected.map(snapshot));
  const usedAssetIds = [...new Set(selected.map(({ assetId }) => assetId))].sort(compareStrings);
  const assetIdentities = Object.freeze(
    usedAssetIds.map((assetId) => {
      const asset = scope.projection.state.assets.find(({ id }) => id === assetId);
      if (asset?.contentIdentity === undefined) {
        throw transcriptError(
          "invalid_project",
          "Transcript asset identity is not committed",
          "missing_asset_identity",
          {
            assetId,
          },
        );
      }
      return Object.freeze({ assetId, contentIdentity: asset.contentIdentity });
    }),
  );

  return Object.freeze({
    schemaVersion: 1,
    proposalId: await derivedUuid(seed, "proposal"),
    artifactIdentityKey: input.artifact.identity.key,
    sourceIdentity: input.artifact.identity.sourceIdentity,
    projectId: scope.projection.projectId,
    projectRevision: scope.projection.revision,
    sequenceId: scope.sequence.id,
    trackId: scope.track.id,
    selectedOccurrenceIds: Object.freeze(selectedOccurrenceIds),
    assetIdentities,
    selectedWords,
    keptRanges,
    deletedRanges,
    commandGroup,
  });
}

export interface AssertTranscriptEditProposalCurrentInput {
  readonly proposal: TranscriptEditProposal;
  readonly artifact: TranscriptArtifactV1;
  readonly projection: ProjectProjection;
}

function revisionsEqual(
  left: ProjectRevisionDescriptorV2,
  right: ProjectRevisionDescriptorV2,
): boolean {
  return (
    left.number === right.number &&
    left.id === right.id &&
    left.parentId === right.parentId &&
    left.committedAt === right.committedAt &&
    left.operationId === right.operationId &&
    left.stateHash === right.stateHash
  );
}

export function assertTranscriptEditProposalCurrent(
  input: AssertTranscriptEditProposalCurrentInput,
): void {
  transcriptArtifactV1Schema.parse(input.artifact);
  const projection = projectProjectionSchema.parse(input.projection);
  if (
    input.artifact.identity.key !== input.proposal.artifactIdentityKey ||
    !identitiesEqual(input.artifact.identity.sourceIdentity, input.proposal.sourceIdentity)
  ) {
    throw transcriptError(
      "invalid_project",
      "Transcript edit proposal uses a stale transcript",
      "stale_transcript",
    );
  }
  if (projection.projectId !== input.proposal.projectId) {
    throw transcriptError(
      "invalid_project",
      "Transcript edit proposal targets another project",
      "stale_project",
    );
  }
  if (!revisionsEqual(projection.revision, input.proposal.projectRevision)) {
    throw transcriptError(
      "invalid_project",
      "Transcript edit proposal uses a stale project revision",
      "stale_revision",
      {
        expectedRevision: input.proposal.projectRevision.number,
        actualRevision: projection.revision.number,
      },
    );
  }
  if (
    input.proposal.commandGroup.projectId !== projection.projectId ||
    input.proposal.commandGroup.baseRevision !== projection.revision.number
  ) {
    throw transcriptError(
      "invalid_project",
      "Transcript edit command group is stale",
      "stale_command_group",
    );
  }
  const sequence = projection.state.sequences.find(({ id }) => id === input.proposal.sequenceId);
  const track = sequence?.tracks.find(({ id }) => id === input.proposal.trackId);
  if (
    sequence === undefined ||
    track === undefined ||
    track.kind === "caption" ||
    isTrackLocked(track)
  ) {
    throw transcriptError(
      "invalid_project",
      "Transcript edit target scope is no longer editable",
      "stale_target_scope",
    );
  }
  for (const expected of input.proposal.assetIdentities) {
    const asset = projection.state.assets.find(({ id }) => id === expected.assetId);
    if (
      asset?.contentIdentity === undefined ||
      !identitiesEqual(asset.contentIdentity, expected.contentIdentity) ||
      !identitiesEqual(asset.contentIdentity, input.proposal.sourceIdentity)
    ) {
      throw transcriptError(
        "invalid_project",
        "Transcript edit asset identity changed",
        "stale_asset_identity",
        {
          assetId: expected.assetId,
        },
      );
    }
  }
}
