import {
  VideoDomainError,
  canToggleTrackVisibility,
  frameRangeDuration,
  frameToPixel,
  isTrackHidden,
  isTrackLocked,
  isTrackMuted,
  projectProjectionSchema,
  ratesEqual,
  rescaleRationalTime,
  timelineFrameRangesIntersect,
  type MediaContentIdentityV1,
  type ProjectCaption,
  type ProjectClip,
  type ProjectProjection,
  type ProjectTrack,
  type RationalRate,
  type RationalTime,
  type TimelineFrameRange,
  type TimelineViewport,
  type VideoSequenceV2,
} from "@supa-video/contracts";

import { deepFreeze } from "./freeze.js";

export interface TimelineRangeViewModel {
  readonly startFrame: number;
  readonly endFrameExclusive: number;
}

export interface TimelineClipViewModel extends TimelineRangeViewModel {
  readonly clipId: string;
  readonly trackId: string;
  readonly trackKind: "video" | "audio";
  readonly sourceKind: "asset" | "sequence";
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly assetContentIdentity?: MediaContentIdentityV1;
}

export interface TimelineCaptionViewModel extends TimelineRangeViewModel {
  readonly captionId: string;
  readonly trackId: string;
  readonly text: string;
}

export interface TimelineTrackViewModel {
  readonly trackId: string;
  readonly name: string;
  readonly kind: ProjectTrack["kind"];
  readonly locked: boolean;
  readonly canMute: boolean;
  readonly muted: boolean;
  readonly canToggleVisibility: boolean;
  readonly hidden: boolean;
  readonly range: TimelineRangeViewModel;
  readonly totalClipCount: number;
  readonly totalCaptionCount: number;
  readonly clips: readonly TimelineClipViewModel[];
  readonly captions: readonly TimelineCaptionViewModel[];
}

export interface TimelineSequenceViewModel {
  readonly sequenceId: string;
  readonly name: string;
  readonly rate: RationalRate;
  readonly range: TimelineRangeViewModel;
  readonly materializedRange: TimelineRangeViewModel;
  readonly tracks: readonly TimelineTrackViewModel[];
  readonly totalClipCount: number;
  readonly materializedClipCount: number;
  readonly totalCaptionCount: number;
  readonly materializedCaptionCount: number;
}

interface IndexedClip extends TimelineRangeViewModel {
  readonly clip: ProjectClip;
  readonly canonicalIndex: number;
}

interface IndexedCaption extends TimelineRangeViewModel {
  readonly caption: ProjectCaption;
  readonly canonicalIndex: number;
}

interface IntervalNode<T extends TimelineRangeViewModel & { readonly canonicalIndex: number }> {
  readonly item: T;
  readonly left: IntervalNode<T> | null;
  readonly right: IntervalNode<T> | null;
  readonly minStartFrame: number;
  readonly maxEndFrameExclusive: number;
}

interface PreparedTrack {
  readonly track: ProjectTrack;
  readonly range: TimelineRangeViewModel;
  readonly clipIndex: IntervalNode<IndexedClip> | null;
  readonly captionIndex: IntervalNode<IndexedCaption> | null;
  readonly totalClipCount: number;
  readonly totalCaptionCount: number;
}

interface PreparedTimeline {
  readonly sequence: VideoSequenceV2 | null;
  readonly range: TimelineRangeViewModel;
  readonly tracks: readonly PreparedTrack[];
  readonly totalClipCount: number;
  readonly totalCaptionCount: number;
  readonly assetsById: ReadonlyMap<string, ProjectProjection["state"]["assets"][number]>;
  readonly sequencesById: ReadonlyMap<string, VideoSequenceV2>;
}

const preparedTimelineCache = new WeakMap<ProjectProjection, PreparedTimeline>();

function timeUsesRate(time: RationalTime, rate: RationalRate): boolean {
  return ratesEqual({ numerator: time.rateNumerator, denominator: time.rateDenominator }, rate);
}

function clipRange(clip: ProjectClip, sequenceRate: RationalRate): TimelineRangeViewModel {
  if (!timeUsesRate(clip.timelineStart, sequenceRate)) {
    throw new VideoDomainError(
      "mixed_rate",
      "Timeline clip start must use the active sequence rate",
      { clipId: clip.id },
    );
  }

  const sourceDuration = frameRangeDuration({ in: clip.sourceIn, out: clip.sourceOut });
  const durationFrames = rescaleRationalTime(sourceDuration, sequenceRate, "exact").value;
  const endFrameExclusive = clip.timelineStart.value + durationFrames;
  if (durationFrames <= 0 || !Number.isSafeInteger(endFrameExclusive)) {
    throw new VideoDomainError("invalid_range", "Timeline clip range must be nonempty and safe", {
      clipId: clip.id,
      startFrame: clip.timelineStart.value,
      endFrameExclusive,
    });
  }

  return {
    startFrame: clip.timelineStart.value,
    endFrameExclusive,
  };
}

function captionRange(caption: ProjectCaption, sequenceRate: RationalRate): TimelineRangeViewModel {
  const startFrame = rescaleRationalTime(caption.start, sequenceRate, "floor").value;
  const endFrameExclusive = rescaleRationalTime(caption.end, sequenceRate, "ceil").value;
  if (endFrameExclusive <= startFrame) {
    throw new VideoDomainError("invalid_range", "Timeline caption range must be nonempty", {
      captionId: caption.id,
      startFrame,
      endFrameExclusive,
    });
  }
  return { startFrame, endFrameExclusive };
}

function activeSequence(projection: ProjectProjection): VideoSequenceV2 | null {
  if (projection.state.activeSequenceId === null) return null;
  const sequence = projection.state.sequences.find(
    (candidate) => candidate.id === projection.state.activeSequenceId,
  );
  if (sequence === undefined) {
    throw new VideoDomainError("invalid_project", "Active timeline sequence does not resolve", {
      activeSequenceId: projection.state.activeSequenceId,
    });
  }
  return sequence;
}

function buildIntervalIndex<T extends TimelineRangeViewModel & { readonly canonicalIndex: number }>(
  items: readonly T[],
): IntervalNode<T> | null {
  if (items.length === 0) return null;
  const sortedItems = [...items].sort(
    (left, right) =>
      left.startFrame - right.startFrame || left.canonicalIndex - right.canonicalIndex,
  );
  const build = (start: number, end: number): IntervalNode<T> | null => {
    if (start >= end) return null;
    const middle = Math.floor((start + end) / 2);
    const item = sortedItems[middle]!;
    const left = build(start, middle);
    const right = build(middle + 1, end);
    return {
      item,
      left,
      right,
      minStartFrame: left?.minStartFrame ?? item.startFrame,
      maxEndFrameExclusive: Math.max(
        item.endFrameExclusive,
        left?.maxEndFrameExclusive ?? item.endFrameExclusive,
        right?.maxEndFrameExclusive ?? item.endFrameExclusive,
      ),
    };
  };
  return build(0, sortedItems.length);
}

function queryIntervalIndex<T extends TimelineRangeViewModel & { readonly canonicalIndex: number }>(
  node: IntervalNode<T> | null,
  range: TimelineFrameRange,
  matches: T[],
): void {
  if (
    node === null ||
    node.minStartFrame >= range.endExclusive ||
    node.maxEndFrameExclusive <= range.start
  ) {
    return;
  }
  queryIntervalIndex(node.left, range, matches);
  if (
    timelineFrameRangesIntersect(
      { start: node.item.startFrame, endExclusive: node.item.endFrameExclusive },
      range,
    )
  ) {
    matches.push(node.item);
  }
  queryIntervalIndex(node.right, range, matches);
}

function prepareTimeline(projectionInput: ProjectProjection): PreparedTimeline {
  const cached = preparedTimelineCache.get(projectionInput);
  if (cached !== undefined) return cached;

  const projection = projectProjectionSchema.parse(projectionInput);
  const sequence = activeSequence(projection);
  const assetsById = new Map(projection.state.assets.map((asset) => [asset.id, asset]));
  const sequencesById = new Map(
    projection.state.sequences.map((candidate) => [candidate.id, candidate]),
  );
  if (sequence === null) {
    const prepared: PreparedTimeline = {
      sequence,
      range: Object.freeze({ startFrame: 0, endFrameExclusive: 0 }),
      tracks: Object.freeze([]),
      totalClipCount: 0,
      totalCaptionCount: 0,
      assetsById,
      sequencesById,
    };
    preparedTimelineCache.set(projectionInput, prepared);
    return prepared;
  }

  let timelineEndFrameExclusive = 0;
  let totalClipCount = 0;
  let totalCaptionCount = 0;
  const tracks = sequence.tracks.map((track): PreparedTrack => {
    if (track.kind === "caption") {
      const indexedCaptions = track.captions.map((caption, canonicalIndex): IndexedCaption => ({
        caption,
        canonicalIndex,
        ...captionRange(caption, sequence.rate),
      }));
      const trackEndFrameExclusive = indexedCaptions.reduce(
        (maximum, caption) => Math.max(maximum, caption.endFrameExclusive),
        0,
      );
      timelineEndFrameExclusive = Math.max(timelineEndFrameExclusive, trackEndFrameExclusive);
      totalCaptionCount += indexedCaptions.length;
      return {
        track,
        range: Object.freeze({ startFrame: 0, endFrameExclusive: trackEndFrameExclusive }),
        clipIndex: null,
        captionIndex: buildIntervalIndex(indexedCaptions),
        totalClipCount: 0,
        totalCaptionCount: indexedCaptions.length,
      };
    }
    const indexedClips = track.clips.map((clip, canonicalIndex): IndexedClip => ({
      clip,
      canonicalIndex,
      ...clipRange(clip, sequence.rate),
    }));
    const trackEndFrameExclusive = indexedClips.reduce(
      (maximum, clip) => Math.max(maximum, clip.endFrameExclusive),
      0,
    );
    timelineEndFrameExclusive = Math.max(timelineEndFrameExclusive, trackEndFrameExclusive);
    totalClipCount += indexedClips.length;
    return {
      track,
      range: Object.freeze({ startFrame: 0, endFrameExclusive: trackEndFrameExclusive }),
      clipIndex: buildIntervalIndex(indexedClips),
      captionIndex: null,
      totalClipCount: indexedClips.length,
      totalCaptionCount: 0,
    };
  });

  const prepared: PreparedTimeline = {
    sequence,
    range: Object.freeze({ startFrame: 0, endFrameExclusive: timelineEndFrameExclusive }),
    tracks,
    totalClipCount,
    totalCaptionCount,
    assetsById,
    sequencesById,
  };
  preparedTimelineCache.set(projectionInput, prepared);
  return prepared;
}

function toRangeViewModel(range: TimelineFrameRange): TimelineRangeViewModel {
  return Object.freeze({ startFrame: range.start, endFrameExclusive: range.endExclusive });
}

function rangesEqual(left: TimelineRangeViewModel, right: TimelineFrameRange): boolean {
  return left.startFrame === right.start && left.endFrameExclusive === right.endExclusive;
}

function sourceView(
  clip: ProjectClip,
  prepared: PreparedTimeline,
): Pick<TimelineClipViewModel, "sourceKind" | "sourceId" | "sourceLabel" | "assetContentIdentity"> {
  if (clip.source.kind === "asset") {
    const assetId = clip.source.assetId;
    const asset = prepared.assetsById.get(assetId);
    if (asset === undefined) {
      throw new VideoDomainError("invalid_project", "Timeline clip asset does not resolve", {
        clipId: clip.id,
        assetId,
      });
    }
    return {
      sourceKind: "asset",
      sourceId: asset.id,
      sourceLabel: asset.displayName,
      ...(asset.contentIdentity === undefined
        ? {}
        : { assetContentIdentity: asset.contentIdentity }),
    };
  }

  const sequenceId = clip.source.sequenceId;
  const sequence = prepared.sequencesById.get(sequenceId);
  if (sequence === undefined) {
    throw new VideoDomainError("invalid_project", "Nested timeline sequence does not resolve", {
      clipId: clip.id,
      sequenceId,
    });
  }
  return {
    sourceKind: "sequence",
    sourceId: sequence.id,
    sourceLabel: sequence.name,
  };
}

export function deriveActiveTimelineRange(
  projectionInput: ProjectProjection,
): Readonly<TimelineRangeViewModel> {
  return prepareTimeline(projectionInput).range;
}

export function projectVisibleTimeline(
  projectionInput: ProjectProjection,
  viewport: TimelineViewport,
): Readonly<TimelineSequenceViewModel> | null {
  const prepared = prepareTimeline(projectionInput);
  const { sequence, range } = prepared;
  if (sequence === null) return null;

  if (!ratesEqual(viewport.frameRate, sequence.rate)) {
    throw new VideoDomainError(
      "mixed_rate",
      "Timeline viewport must use the active sequence rate",
      {
        sequenceId: sequence.id,
      },
    );
  }
  if (!rangesEqual(range, viewport.timelineRange)) {
    throw new VideoDomainError(
      "invalid_range",
      "Timeline viewport range must match the active sequence range",
      { sequenceId: sequence.id },
    );
  }
  // Authenticate the transient viewport through the contracts package before reading its ranges.
  frameToPixel(range.startFrame, viewport);

  let materializedClipCount = 0;
  let materializedCaptionCount = 0;
  const tracks: TimelineTrackViewModel[] = prepared.tracks.map((preparedTrack) => {
    const { track } = preparedTrack;
    if (track.kind === "caption") {
      const visibleCaptions: IndexedCaption[] = [];
      queryIntervalIndex(preparedTrack.captionIndex, viewport.overscanRange, visibleCaptions);
      visibleCaptions.sort((left, right) => left.canonicalIndex - right.canonicalIndex);
      const captions = visibleCaptions.map(
        ({ caption, startFrame, endFrameExclusive }): TimelineCaptionViewModel => ({
          captionId: caption.id,
          trackId: track.id,
          text: caption.text,
          startFrame,
          endFrameExclusive,
        }),
      );
      materializedCaptionCount += captions.length;
      return {
        trackId: track.id,
        name: track.name,
        kind: track.kind,
        locked: isTrackLocked(track),
        canMute: false,
        muted: isTrackMuted(track),
        canToggleVisibility: canToggleTrackVisibility(track),
        hidden: isTrackHidden(track),
        range: preparedTrack.range,
        totalClipCount: 0,
        totalCaptionCount: preparedTrack.totalCaptionCount,
        clips: Object.freeze([]),
        captions,
      };
    }

    const visibleClips: IndexedClip[] = [];
    queryIntervalIndex(preparedTrack.clipIndex, viewport.overscanRange, visibleClips);
    visibleClips.sort((left, right) => left.canonicalIndex - right.canonicalIndex);
    const clips = visibleClips.map(({ clip, startFrame, endFrameExclusive }) => ({
      clipId: clip.id,
      trackId: track.id,
      trackKind: track.kind,
      startFrame,
      endFrameExclusive,
      ...sourceView(clip, prepared),
    }));
    materializedClipCount += clips.length;
    return {
      trackId: track.id,
      name: track.name,
      kind: track.kind,
      locked: isTrackLocked(track),
      canMute: true,
      muted: isTrackMuted(track),
      canToggleVisibility: canToggleTrackVisibility(track),
      hidden: isTrackHidden(track),
      range: preparedTrack.range,
      totalClipCount: preparedTrack.totalClipCount,
      totalCaptionCount: 0,
      clips,
      captions: Object.freeze([]),
    };
  });

  return deepFreeze({
    sequenceId: sequence.id,
    name: sequence.name,
    rate: sequence.rate,
    range,
    materializedRange: toRangeViewModel(viewport.overscanRange),
    tracks,
    totalClipCount: prepared.totalClipCount,
    materializedClipCount,
    totalCaptionCount: prepared.totalCaptionCount,
    materializedCaptionCount,
  });
}
