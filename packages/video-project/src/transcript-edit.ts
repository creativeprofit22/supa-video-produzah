import {
  VideoDomainError,
  commandGroupRequestSchema,
  createRationalTime,
  isTrackLocked,
  projectProjectionSchema,
  rateOf,
  ratesEqual,
  rescaleRationalTime,
  type CommandGroupRequest,
  type MediaContentIdentityV1,
  type ProjectClip,
  type ProjectCommandV2,
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

function transcriptError(
  code: "invalid_project" | "invalid_range",
  message: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): VideoDomainError {
  return new VideoDomainError(code, message, { reason, ...details });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identitiesEqual(left: MediaContentIdentityV1, right: MediaContentIdentityV1): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.byteLength === right.byteLength
  );
}

function time(value: number, template: RationalTime): RationalTime {
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

function resolveScope(input: ProjectTranscriptScopeInput) {
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

class FramedSeedEncoder {
  readonly #parts: Uint8Array[] = [];

  string(value: string): void {
    const bytes = new TextEncoder().encode(value);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.byteLength, true);
    this.#parts.push(length, bytes);
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.#parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of this.#parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}

function bytesToUuid(bytes: Uint8Array): string {
  const uuidBytes = bytes.slice(0, 16);
  uuidBytes[6] = ((uuidBytes[6] ?? 0) & 0x0f) | 0x40;
  uuidBytes[8] = ((uuidBytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(uuidBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function derivedUuid(seed: Uint8Array, role: string): Promise<string> {
  const encoder = new FramedSeedEncoder();
  encoder.string("supa-video/transcript-edit-id/v1");
  encoder.string(role);
  encoder.string(Array.from(seed, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  return bytesToUuid(await sha256(encoder.finish()));
}

function proposalSeed(
  input: CreateTranscriptEditProposalInput,
  projection: ProjectProjection,
  selectedOccurrenceIds: readonly string[],
): Uint8Array {
  const encoder = new FramedSeedEncoder();
  encoder.string("supa-video/transcript-edit-proposal/v1");
  encoder.string(input.artifact.identity.key);
  encoder.string(input.artifact.identity.sourceIdentity.digest);
  encoder.string(String(input.artifact.identity.sourceIdentity.byteLength));
  encoder.string(projection.projectId);
  encoder.string(JSON.stringify(projection.revision));
  encoder.string(input.sequenceId);
  encoder.string(input.trackId);
  for (const occurrence of selectedOccurrenceIds) encoder.string(occurrence);
  return encoder.finish();
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

type TranscriptProjectCommand = Extract<
  ProjectCommandV2,
  { type: "SplitClip" | "RippleDeleteClip" }
>;
type TranscriptCommandWithoutId = TranscriptProjectCommand extends infer Command
  ? Command extends ProjectCommandV2
    ? Omit<Command, "commandId">
    : never
  : never;

interface CommandDraft {
  readonly role: string;
  readonly command: TranscriptCommandWithoutId;
  readonly rightClipRole?: string;
}

function compileCommandDrafts(
  deletions: readonly MergedDeletion[],
  sequenceId: string,
  trackId: string,
): readonly CommandDraft[] {
  const byClip = new Map<string, MergedDeletion[]>();
  for (const deletion of deletions) {
    const ranges = byClip.get(deletion.clip.id) ?? [];
    ranges.push(deletion);
    byClip.set(deletion.clip.id, ranges);
  }
  const clips = [...byClip.values()].sort(
    (left, right) =>
      right[0]!.clip.timelineStart.value - left[0]!.clip.timelineStart.value ||
      compareStrings(right[0]!.clip.id, left[0]!.clip.id),
  );
  const drafts: CommandDraft[] = [];
  let ordinal = 0;
  for (const clipRanges of clips) {
    const clip = clipRanges[0]!.clip;
    let currentSourceOut = clip.sourceOut.value;
    for (const deletion of [...clipRanges].sort((a, b) => b.sourceStart - a.sourceStart)) {
      const prefix = `${ordinal++}:${clip.id}:${deletion.sourceStart}:${deletion.sourceEnd}`;
      if (deletion.sourceStart === clip.sourceIn.value) {
        if (deletion.sourceEnd < currentSourceOut) {
          drafts.push({
            role: `${prefix}:split-end`,
            rightClipRole: `${prefix}:kept-right`,
            command: {
              type: "SplitClip",
              sequenceId,
              trackId,
              clipId: clip.id,
              splitAt: time(deletion.sourceEnd, clip.sourceIn),
              rightClipId: "",
            },
          });
        }
        drafts.push({
          role: `${prefix}:ripple`,
          command: { type: "RippleDeleteClip", sequenceId, trackId, clipId: clip.id },
        });
        currentSourceOut = deletion.sourceStart;
        continue;
      }

      const deletedClipRole = `${prefix}:deleted-fragment`;
      drafts.push({
        role: `${prefix}:split-start`,
        rightClipRole: deletedClipRole,
        command: {
          type: "SplitClip",
          sequenceId,
          trackId,
          clipId: clip.id,
          splitAt: time(deletion.sourceStart, clip.sourceIn),
          rightClipId: "",
        },
      });
      if (deletion.sourceEnd < currentSourceOut) {
        drafts.push({
          role: `${prefix}:split-end`,
          rightClipRole: `${prefix}:kept-right`,
          command: {
            type: "SplitClip",
            sequenceId,
            trackId,
            clipId: "",
            splitAt: time(deletion.sourceEnd, clip.sourceIn),
            rightClipId: "",
          },
        });
      }
      drafts.push({
        role: `${prefix}:ripple`,
        command: { type: "RippleDeleteClip", sequenceId, trackId, clipId: "" },
        rightClipRole: deletedClipRole,
      });
      currentSourceOut = deletion.sourceStart;
    }
  }
  return drafts;
}

async function materializeCommands(
  drafts: readonly CommandDraft[],
  seed: Uint8Array,
): Promise<readonly ProjectCommandV2[]> {
  const fragmentIds = new Map<string, string>();
  const fragmentId = async (role: string): Promise<string> => {
    const existing = fragmentIds.get(role);
    if (existing !== undefined) return existing;
    const id = await derivedUuid(seed, `fragment:${role}`);
    fragmentIds.set(role, id);
    return id;
  };
  const commands: ProjectCommandV2[] = [];
  for (const draft of drafts) {
    const commandId = await derivedUuid(seed, `command:${draft.role}`);
    if (draft.command.type === "SplitClip") {
      const rightClipId = await fragmentId(draft.rightClipRole!);
      const clipId =
        draft.command.clipId === ""
          ? await fragmentId(draft.role.replace(":split-end", ":deleted-fragment"))
          : draft.command.clipId;
      commands.push({ ...draft.command, commandId, clipId, rightClipId });
    } else if (draft.command.type === "RippleDeleteClip") {
      commands.push({
        ...draft.command,
        commandId,
        clipId:
          draft.command.clipId === ""
            ? await fragmentId(draft.rightClipRole!)
            : draft.command.clipId,
      });
    } else {
      throw transcriptError(
        "invalid_project",
        "Unexpected transcript command shape",
        "invalid_command_shape",
      );
    }
  }
  return commands;
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
  const commands = await materializeCommands(drafts, seed);
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
