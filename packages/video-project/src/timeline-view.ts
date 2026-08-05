import {
  VideoDomainError,
  frameRangeDuration,
  frameToPixel,
  isTrackLocked,
  isTrackMuted,
  projectProjectionSchema,
  ratesEqual,
  rescaleRationalTime,
  timelineFrameRangesIntersect,
  type MediaContentIdentityV1,
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

export interface TimelineTrackViewModel {
  readonly trackId: string;
  readonly name: string;
  readonly kind: ProjectTrack["kind"];
  readonly locked: boolean;
  readonly canMute: boolean;
  readonly muted: boolean;
  readonly range: TimelineRangeViewModel;
  readonly totalClipCount: number;
  readonly clips: readonly TimelineClipViewModel[];
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
}

interface IndexedClip extends TimelineRangeViewModel {
  readonly clip: ProjectClip;
  readonly canonicalIndex: number;
}

interface ClipIntervalNode {
  readonly clip: IndexedClip;
  readonly left: ClipIntervalNode | null;
  readonly right: ClipIntervalNode | null;
  readonly minStartFrame: number;
  readonly maxEndFrameExclusive: number;
}

interface PreparedTrack {
  readonly track: ProjectTrack;
  readonly range: TimelineRangeViewModel;
  readonly clipIndex: ClipIntervalNode | null;
  readonly totalClipCount: number;
}

interface PreparedTimeline {
  readonly sequence: VideoSequenceV2 | null;
  readonly range: TimelineRangeViewModel;
  readonly tracks: readonly PreparedTrack[];
  readonly totalClipCount: number;
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

function buildClipIntervalIndex(clips: readonly IndexedClip[]): ClipIntervalNode | null {
  if (clips.length === 0) return null;
  const sortedClips = [...clips].sort(
    (left, right) =>
      left.startFrame - right.startFrame || left.canonicalIndex - right.canonicalIndex,
  );
  const build = (start: number, end: number): ClipIntervalNode | null => {
    if (start >= end) return null;
    const middle = Math.floor((start + end) / 2);
    const clip = sortedClips[middle]!;
    const left = build(start, middle);
    const right = build(middle + 1, end);
    return {
      clip,
      left,
      right,
      minStartFrame: left?.minStartFrame ?? clip.startFrame,
      maxEndFrameExclusive: Math.max(
        clip.endFrameExclusive,
        left?.maxEndFrameExclusive ?? clip.endFrameExclusive,
        right?.maxEndFrameExclusive ?? clip.endFrameExclusive,
      ),
    };
  };
  return build(0, sortedClips.length);
}

function queryClipIntervalIndex(
  node: ClipIntervalNode | null,
  range: TimelineFrameRange,
  matches: IndexedClip[],
): void {
  if (
    node === null ||
    node.minStartFrame >= range.endExclusive ||
    node.maxEndFrameExclusive <= range.start
  ) {
    return;
  }
  queryClipIntervalIndex(node.left, range, matches);
  if (
    timelineFrameRangesIntersect(
      { start: node.clip.startFrame, endExclusive: node.clip.endFrameExclusive },
      range,
    )
  ) {
    matches.push(node.clip);
  }
  queryClipIntervalIndex(node.right, range, matches);
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
      assetsById,
      sequencesById,
    };
    preparedTimelineCache.set(projectionInput, prepared);
    return prepared;
  }

  let timelineEndFrameExclusive = 0;
  let totalClipCount = 0;
  const tracks = sequence.tracks.map((track): PreparedTrack => {
    if (track.kind === "caption") {
      return {
        track,
        range: Object.freeze({ startFrame: 0, endFrameExclusive: 0 }),
        clipIndex: null,
        totalClipCount: 0,
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
      clipIndex: buildClipIntervalIndex(indexedClips),
      totalClipCount: indexedClips.length,
    };
  });

  const prepared: PreparedTimeline = {
    sequence,
    range: Object.freeze({ startFrame: 0, endFrameExclusive: timelineEndFrameExclusive }),
    tracks,
    totalClipCount,
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
  const tracks: TimelineTrackViewModel[] = prepared.tracks.map((preparedTrack) => {
    const { track } = preparedTrack;
    if (track.kind === "caption") {
      return {
        trackId: track.id,
        name: track.name,
        kind: track.kind,
        locked: isTrackLocked(track),
        canMute: false,
        muted: isTrackMuted(track),
        range: preparedTrack.range,
        totalClipCount: 0,
        clips: Object.freeze([]),
      };
    }

    const visibleClips: IndexedClip[] = [];
    queryClipIntervalIndex(preparedTrack.clipIndex, viewport.overscanRange, visibleClips);
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
      range: preparedTrack.range,
      totalClipCount: preparedTrack.totalClipCount,
      clips,
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
  });
}
