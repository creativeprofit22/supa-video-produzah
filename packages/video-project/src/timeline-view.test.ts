import {
  VideoDomainError,
  createRationalTime,
  createTimelineViewport,
  type ProjectClip,
  type ProjectProjection,
  type ProjectTrack,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { deriveActiveTimelineRange, projectVisibleTimeline } from "./timeline-view.js";

const rate = { numerator: 10, denominator: 1 } as const;
const identity = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: 1_000,
} as const;
const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const transform = {
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1_000,
  scaleYPermille: 1_000,
  rotationMilliDegrees: 0,
  opacityPermille: 1_000,
} as const;

function clip(value: number, start: number, end: number, sourceId = id(1)): ProjectClip {
  return {
    id: id(value),
    source: { kind: "asset", assetId: sourceId },
    timelineStart: createRationalTime(start, rate),
    sourceIn: createRationalTime(0, rate),
    sourceOut: createRationalTime(end - start, rate),
    transform,
    gainMilliDecibels: 0,
  };
}

function projection(
  tracks: ProjectTrack[],
  extraSequences: ProjectProjection["state"]["sequences"] = [],
): ProjectProjection {
  return {
    projectId: id(900_001),
    name: "Projection test",
    revision: {
      number: 1,
      id: id(900_002),
      parentId: id(900_003),
      committedAt: "2026-08-03T12:00:00.000Z",
      operationId: id(900_004),
      stateHash: "ab".repeat(32),
    },
    state: {
      assets: [
        {
          id: id(1),
          displayName: "camera-a.mp4",
          locator: { absolutePath: "C:\\Media\\camera-a.mp4" },
          probe: {
            durationMicroseconds: 1_000_000_000,
            averageFrameRate: rate,
            realFrameRate: rate,
            variableFrameRate: false,
            width: 1920,
            height: 1080,
            videoCodecName: "h264",
            audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
            fileSizeBytes: identity.byteLength,
          },
          contentIdentity: identity,
        },
      ],
      sequences: [
        {
          id: id(2),
          name: "Main sequence",
          rate,
          width: 1920,
          height: 1080,
          audioSampleRate: 48_000,
          tracks,
          markers: [],
        },
        ...extraSequences,
      ],
      activeSequenceId: id(2),
    },
    canUndo: false,
    canRedo: false,
    lastCommand: null,
    sources: [],
    journalHealth: "healthy",
    snapshotRevision: 1,
    recoveryStatus: "clean",
    replayedRecordCount: 0,
  };
}

function viewportFor(value: ProjectProjection, start: number, width: number, overscan: number) {
  const range = deriveActiveTimelineRange(value);
  return createTimelineViewport({
    frameRate: rate,
    zoomScale: rate,
    scrollOrigin: createRationalTime(start, rate),
    viewportWidthPixels: width,
    overscanPixels: overscan,
    timelineRange: { start: range.startFrame, endExclusive: range.endFrameExclusive },
  });
}

describe("visible timeline projection", () => {
  it("preserves canonical multitrack identity, order, source metadata, and exact ranges", () => {
    const nestedSequence: VideoSequenceV2 = {
      id: id(3),
      name: "Nested title",
      rate,
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      tracks: [],
      markers: [],
    };
    const value = projection(
      [
        { id: id(10), name: "Video 1", kind: "video", clips: [clip(100, 5, 25)] },
        {
          id: id(11),
          name: "Audio 1",
          kind: "audio",
          clips: [
            {
              ...clip(101, 10, 40),
              source: { kind: "sequence", sequenceId: nestedSequence.id },
            },
          ],
        },
        { id: id(12), name: "Captions", kind: "caption", captions: [] },
      ],
      [nestedSequence],
    );

    expect(deriveActiveTimelineRange(value)).toEqual({ startFrame: 0, endFrameExclusive: 40 });
    const result = projectVisibleTimeline(value, viewportFor(value, 0, 40, 0));
    expect(result?.tracks.map(({ trackId, kind }) => ({ trackId, kind }))).toEqual([
      { trackId: id(10), kind: "video" },
      { trackId: id(11), kind: "audio" },
      { trackId: id(12), kind: "caption" },
    ]);
    expect(result?.tracks[0]?.clips[0]).toMatchObject({
      clipId: id(100),
      trackId: id(10),
      sourceKind: "asset",
      sourceId: id(1),
      sourceLabel: "camera-a.mp4",
      assetContentIdentity: identity,
      startFrame: 5,
      endFrameExclusive: 25,
    });
    expect(result?.tracks[1]?.clips[0]).toMatchObject({
      sourceKind: "sequence",
      sourceId: id(3),
      sourceLabel: "Nested title",
    });
    expect(result).toMatchObject({ totalClipCount: 2, materializedClipCount: 2 });
    expect(Object.isFrozen(result?.tracks[0]?.clips[0])).toBe(true);
  });

  it("uses half-open overscan boundaries and caps overscan to one viewport per side", () => {
    const value = projection([
      {
        id: id(10),
        name: "Video 1",
        kind: "video",
        clips: [
          clip(100, 0, 10),
          clip(101, 9, 11),
          clip(102, 20, 30),
          clip(103, 39, 41),
          clip(104, 40, 50),
          clip(105, 90, 100),
        ],
      },
    ]);
    const viewport = viewportFor(value, 20, 10, 10_000);
    const result = projectVisibleTimeline(value, viewport);

    expect(viewport.effectiveOverscanPixels).toBe(10);
    expect(result?.materializedRange).toEqual({ startFrame: 10, endFrameExclusive: 40 });
    expect(result?.tracks[0]?.clips.map(({ clipId }) => clipId)).toEqual([
      id(101),
      id(102),
      id(103),
    ]);
  });

  it("rejects mixed clip or viewport rates with a typed domain error", () => {
    const value = projection([
      {
        id: id(10),
        name: "Video 1",
        kind: "video",
        clips: [
          {
            ...clip(100, 0, 10),
            sourceOut: createRationalTime(10, { numerator: 25, denominator: 1 }),
          },
        ],
      },
    ]);
    expect(() => deriveActiveTimelineRange(value)).toThrowError(VideoDomainError);

    const valid = projection([
      { id: id(10), name: "Video 1", kind: "video", clips: [clip(100, 0, 100)] },
    ]);
    const range = deriveActiveTimelineRange(valid);
    const mismatchedViewport = createTimelineViewport({
      frameRate: { numerator: 25, denominator: 1 },
      zoomScale: rate,
      scrollOrigin: createRationalTime(0, { numerator: 25, denominator: 1 }),
      viewportWidthPixels: 10,
      overscanPixels: 0,
      timelineRange: { start: range.startFrame, endExclusive: range.endFrameExclusive },
    });
    expect(() => projectVisibleTimeline(valid, mismatchedViewport)).toThrowError(VideoDomainError);
  });

  it("materializes only narrow overscan intersections across 10,000 clips", () => {
    const clips = Array.from({ length: 10_000 }, (_, index) =>
      clip(100_000 + index, index * 2, index * 2 + 1),
    );
    const value = projection([
      { id: id(10), name: "Video 1", kind: "video", clips: clips.slice(0, 5_000) },
      { id: id(11), name: "Video 2", kind: "video", clips: clips.slice(5_000) },
    ]);
    const firstTrack = value.state.sequences[0]?.tracks[0];
    if (firstTrack === undefined || firstTrack.kind === "caption") {
      throw new Error("Expected a clip track");
    }
    const firstClip = firstTrack.clips[0]!;
    const firstSource = firstClip.source;
    let sourceReads = 0;
    Object.defineProperty(firstClip, "source", {
      configurable: true,
      get: () => {
        sourceReads += 1;
        return firstSource;
      },
    });

    const startViewport = viewportFor(value, 0, 10, 10);
    expect(sourceReads).toBeGreaterThan(0);
    sourceReads = 0;
    const start = projectVisibleTimeline(value, startViewport);
    const end = projectVisibleTimeline(value, viewportFor(value, 19_980, 10, 10));
    const startIds = start?.tracks.flatMap((track) => track.clips.map((item) => item.clipId));
    const endIds = end?.tracks.flatMap((track) => track.clips.map((item) => item.clipId));

    expect(start?.totalClipCount).toBe(10_000);
    expect(sourceReads).toBe(0);
    expect(startIds).toHaveLength(10);
    expect(startIds).toContain(id(100_000));
    expect(endIds).not.toContain(id(100_000));
    expect(endIds?.length).toBeLessThanOrEqual(15);
  });
});
