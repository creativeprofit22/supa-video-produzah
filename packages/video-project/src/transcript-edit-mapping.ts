import {
  VideoDomainError,
  createRationalTime,
  isTrackLocked,
  projectProjectionSchema,
  rateOf,
  ratesEqual,
  rescaleRationalTime,
  type MediaContentIdentityV1,
  type ProjectProjection,
  type ProjectRevisionDescriptorV2,
  type RationalTime,
} from "@supa-video/contracts";
import {
  transcriptArtifactV1Schema,
  type TranscriptArtifactV1,
  type TranscriptWordV1,
} from "@supa-video/media";

export interface TranscriptSourceWordMapping {
  readonly artifactIdentityKey: string;
  readonly sourceIdentity: MediaContentIdentityV1;
  readonly wordId: string;
  readonly text: string;
  readonly sourceStartUs: number;
  readonly sourceEndUs: number;
}

export interface TranscriptTimelineOccurrence extends TranscriptSourceWordMapping {
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly projectRevision: ProjectRevisionDescriptorV2;
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly assetId: string;
  readonly sourceRange: TranscriptFrameRange;
  readonly timelineRange: TranscriptFrameRange;
}

export interface TranscriptTimelineProjection {
  readonly schemaVersion: 1;
  readonly artifactIdentityKey: string;
  readonly sourceIdentity: MediaContentIdentityV1;
  readonly projectId: string;
  readonly projectRevision: ProjectRevisionDescriptorV2;
  readonly sequenceId: string;
  readonly trackId: string;
  readonly occurrences: readonly TranscriptTimelineOccurrence[];
}

export interface TranscriptFrameRange {
  readonly start: RationalTime;
  readonly end: RationalTime;
}

export interface ProjectTranscriptScopeInput {
  readonly artifact: TranscriptArtifactV1;
  readonly projection: ProjectProjection;
  readonly sequenceId: string;
  readonly trackId: string;
}

export function transcriptError(
  code: "invalid_project" | "invalid_range",
  message: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): VideoDomainError {
  return new VideoDomainError(code, message, { reason, ...details });
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function identitiesEqual(
  left: MediaContentIdentityV1,
  right: MediaContentIdentityV1,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.byteLength === right.byteLength
  );
}

export function time(value: number, template: RationalTime): RationalTime {
  return createRationalTime(value, rateOf(template));
}

function microsecondsToFrames(
  microseconds: number,
  template: RationalTime,
  mode: "floor" | "ceil",
): RationalTime {
  return rescaleRationalTime(
    createRationalTime(microseconds, { numerator: 1_000_000, denominator: 1 }),
    rateOf(template),
    mode,
  );
}

function occurrenceId(input: {
  artifactIdentityKey: string;
  sequenceId: string;
  trackId: string;
  clipId: string;
  assetId: string;
  wordId: string;
  sourceStart: number;
  sourceEnd: number;
}): string {
  return [
    "transcript-occurrence-v1",
    input.artifactIdentityKey,
    input.sequenceId,
    input.trackId,
    input.clipId,
    input.assetId,
    input.wordId,
    input.sourceStart,
    input.sourceEnd,
  ]
    .map((part) => `${String(part).length}:${String(part)}`)
    .join("|");
}

export function resolveScope(input: ProjectTranscriptScopeInput) {
  transcriptArtifactV1Schema.parse(input.artifact);
  const projection = projectProjectionSchema.parse(input.projection);
  const sequence = projection.state.sequences.find(({ id }) => id === input.sequenceId);
  if (sequence === undefined) {
    throw transcriptError(
      "invalid_project",
      "Transcript target sequence does not exist",
      "unknown_sequence",
      {
        sequenceId: input.sequenceId,
      },
    );
  }
  const track = sequence.tracks.find(({ id }) => id === input.trackId);
  if (track === undefined) {
    throw transcriptError(
      "invalid_project",
      "Transcript target track does not exist",
      "unknown_track",
      {
        trackId: input.trackId,
      },
    );
  }
  if (track.kind === "caption") {
    throw transcriptError(
      "invalid_project",
      "Transcript edits require an asset-backed media track",
      "caption_track",
      {
        trackId: track.id,
      },
    );
  }
  if (isTrackLocked(track)) {
    throw transcriptError(
      "invalid_project",
      "Transcript edits cannot target a locked track",
      "locked_track",
      {
        trackId: track.id,
      },
    );
  }

  const matchingAssets = projection.state.assets.filter(
    (asset) =>
      asset.contentIdentity !== undefined &&
      identitiesEqual(asset.contentIdentity, input.artifact.identity.sourceIdentity),
  );
  if (matchingAssets.length === 0) {
    throw transcriptError(
      "invalid_project",
      "Transcript source identity does not match a committed project asset",
      "source_identity_mismatch",
      { sourceDigest: input.artifact.identity.sourceIdentity.digest },
    );
  }
  return { projection, sequence, track, matchingAssets };
}

export function mapTranscriptToSource(
  artifact: TranscriptArtifactV1,
): readonly TranscriptSourceWordMapping[] {
  transcriptArtifactV1Schema.parse(artifact);
  return Object.freeze(
    artifact.words.map((word) =>
      Object.freeze({
        artifactIdentityKey: artifact.identity.key,
        sourceIdentity: artifact.identity.sourceIdentity,
        wordId: word.wordId,
        text: word.text,
        sourceStartUs: word.sourceStartUs,
        sourceEndUs: word.sourceEndUs,
      }),
    ),
  );
}

function projectWordToClip(
  word: TranscriptWordV1,
  input: ProjectTranscriptScopeInput,
  scope: ReturnType<typeof resolveScope>,
  clip: (typeof scope.track.clips)[number],
): TranscriptTimelineOccurrence | null {
  const assetId = clip.source.kind === "asset" ? clip.source.assetId : null;
  if (assetId === null || !scope.matchingAssets.some(({ id }) => id === assetId)) return null;
  if (!ratesEqual(rateOf(clip.sourceIn), rateOf(clip.sourceOut))) {
    throw transcriptError(
      "invalid_project",
      "Clip source geometry uses mixed rates",
      "mixed_clip_source_rate",
      {
        clipId: clip.id,
      },
    );
  }

  const wordStart = microsecondsToFrames(word.sourceStartUs, clip.sourceIn, "floor");
  const wordEnd = microsecondsToFrames(word.sourceEndUs, clip.sourceIn, "ceil");
  const sourceStart = Math.max(wordStart.value, clip.sourceIn.value);
  const sourceEnd = Math.min(wordEnd.value, clip.sourceOut.value);
  if (sourceEnd <= sourceStart) return null;

  const sourceOffsetStart = time(sourceStart - clip.sourceIn.value, clip.sourceIn);
  const sourceOffsetEnd = time(sourceEnd - clip.sourceIn.value, clip.sourceIn);
  const timelineOffsetStart = rescaleRationalTime(sourceOffsetStart, scope.sequence.rate, "exact");
  const timelineOffsetEnd = rescaleRationalTime(sourceOffsetEnd, scope.sequence.rate, "exact");
  const timelineStart = time(
    clip.timelineStart.value + timelineOffsetStart.value,
    clip.timelineStart,
  );
  const timelineEnd = time(clip.timelineStart.value + timelineOffsetEnd.value, clip.timelineStart);
  const sourceRange = Object.freeze({
    start: time(sourceStart, clip.sourceIn),
    end: time(sourceEnd, clip.sourceIn),
  });
  const timelineRange = Object.freeze({ start: timelineStart, end: timelineEnd });

  return Object.freeze({
    artifactIdentityKey: input.artifact.identity.key,
    sourceIdentity: input.artifact.identity.sourceIdentity,
    wordId: word.wordId,
    text: word.text,
    sourceStartUs: word.sourceStartUs,
    sourceEndUs: word.sourceEndUs,
    occurrenceId: occurrenceId({
      artifactIdentityKey: input.artifact.identity.key,
      sequenceId: scope.sequence.id,
      trackId: scope.track.id,
      clipId: clip.id,
      assetId,
      wordId: word.wordId,
      sourceStart,
      sourceEnd,
    }),
    projectId: scope.projection.projectId,
    projectRevision: scope.projection.revision,
    sequenceId: scope.sequence.id,
    trackId: scope.track.id,
    clipId: clip.id,
    assetId,
    sourceRange,
    timelineRange,
  });
}

export function projectTranscriptToTimeline(
  input: ProjectTranscriptScopeInput,
): TranscriptTimelineProjection {
  const scope = resolveScope(input);
  const occurrences = input.artifact.words
    .flatMap((word) =>
      scope.track.clips.flatMap((clip) => {
        const occurrence = projectWordToClip(word, input, scope, clip);
        return occurrence === null ? [] : [occurrence];
      }),
    )
    .sort(
      (left, right) =>
        left.timelineRange.start.value - right.timelineRange.start.value ||
        left.timelineRange.end.value - right.timelineRange.end.value ||
        left.sourceRange.start.value - right.sourceRange.start.value ||
        compareStrings(left.clipId, right.clipId) ||
        compareStrings(left.wordId, right.wordId),
    );

  return Object.freeze({
    schemaVersion: 1,
    artifactIdentityKey: input.artifact.identity.key,
    sourceIdentity: input.artifact.identity.sourceIdentity,
    projectId: scope.projection.projectId,
    projectRevision: scope.projection.revision,
    sequenceId: scope.sequence.id,
    trackId: scope.track.id,
    occurrences: Object.freeze(occurrences),
  });
}
