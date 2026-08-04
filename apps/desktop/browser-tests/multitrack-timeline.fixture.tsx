import type { ProjectClip, ProjectProjection } from "@supa-video/contracts";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import "../src/App.css";
import { MultitrackTimeline } from "../src/video/MultitrackTimeline";
import { testProbe, testSourceIdentity } from "../src/test-video-service";

const rate = { numerator: 10, denominator: 1 } as const;
const id = (value: number): string =>
  `40000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const time = (value: number) => ({ value, rateNumerator: 10, rateDenominator: 1 });
const transform = {
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1_000,
  scaleYPermille: 1_000,
  rotationMilliDegrees: 0,
  opacityPermille: 1_000,
};
const clip = (
  value: number,
  start: number,
  duration: number,
  source: ProjectClip["source"],
): ProjectClip => ({
  id: id(value),
  source,
  timelineStart: time(start),
  sourceIn: time(0),
  sourceOut: time(duration),
  transform,
  gainMilliDecibels: 0,
});
const assetId = id(1);
const nestedSequenceId = id(3);

const initialProjection: ProjectProjection = {
  projectId: id(900_001),
  name: "Timeline visual fixture",
  revision: {
    number: 4,
    id: id(900_002),
    parentId: id(900_003),
    committedAt: "2026-08-03T12:00:00.000Z",
    operationId: id(900_004),
    stateHash: "cd".repeat(32),
  },
  state: {
    assets: [
      {
        id: assetId,
        displayName: "Interview A — wide camera.mp4",
        locator: { absolutePath: "C:\\Media\\interview-a.mp4" },
        probe: { ...testProbe, averageFrameRate: rate, realFrameRate: rate },
        contentIdentity: testSourceIdentity,
      },
    ],
    sequences: [
      {
        id: id(2),
        name: "Documentary assembly",
        rate,
        width: 1920,
        height: 1080,
        audioSampleRate: 48_000,
        tracks: [
          {
            id: id(10),
            name: "Primary camera",
            kind: "video",
            clips: [
              clip(100, 0, 28, { kind: "asset", assetId }),
              clip(101, 34, 42, { kind: "asset", assetId }),
              clip(102, 92, 66, { kind: "asset", assetId }),
            ],
          },
          {
            id: id(11),
            name: "Interview dialogue",
            kind: "audio",
            clips: [
              clip(200, 0, 62, { kind: "sequence", sequenceId: nestedSequenceId }),
              clip(201, 68, 90, { kind: "sequence", sequenceId: nestedSequenceId }),
            ],
          },
          { id: id(12), name: "English captions", kind: "caption", captions: [] },
        ],
        markers: [],
      },
      {
        id: nestedSequenceId,
        name: "Interview dialogue nest",
        rate,
        width: 1920,
        height: 1080,
        audioSampleRate: 48_000,
        tracks: [],
        markers: [],
      },
    ],
    activeSequenceId: id(2),
  },
  canUndo: false,
  canRedo: false,
  lastCommand: null,
  sources: [],
  journalHealth: "healthy",
  snapshotRevision: 4,
  recoveryStatus: "clean",
  replayedRecordCount: 0,
};

function ControlledTimelineFixture() {
  const [currentProjection, setCurrentProjection] = useState(initialProjection);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  const updateClip = (clipId: string, update: (clip: ProjectClip) => ProjectClip) => {
    setCurrentProjection((current) => ({
      ...current,
      state: {
        ...current.state,
        sequences: current.state.sequences.map((sequence) => ({
          ...sequence,
          tracks: sequence.tracks.map((track) =>
            track.kind === "caption"
              ? track
              : {
                  ...track,
                  clips: track.clips.map((candidate) =>
                    candidate.id === clipId ? update(candidate) : candidate,
                  ),
                },
          ),
        })),
      },
    }));
  };

  const splitClip = (clipId: string, sourceFrame: number) => {
    const rightClipId = id(300);
    setCurrentProjection((current) => ({
      ...current,
      state: {
        ...current.state,
        sequences: current.state.sequences.map((sequence) => ({
          ...sequence,
          tracks: sequence.tracks.map((track) =>
            track.kind === "caption"
              ? track
              : {
                  ...track,
                  clips: track.clips.flatMap((candidate) => {
                    if (candidate.id !== clipId) return [candidate];
                    const offset = sourceFrame - candidate.sourceIn.value;
                    return [
                      { ...candidate, sourceOut: time(sourceFrame) },
                      {
                        ...candidate,
                        id: rightClipId,
                        timelineStart: time(candidate.timelineStart.value + offset),
                        sourceIn: time(sourceFrame),
                      },
                    ];
                  }),
                },
          ),
        })),
      },
    }));
    setSelectedClipId(rightClipId);
  };

  const rippleDeleteClip = (clipId: string) => {
    const nextSelectedClipId = currentProjection.state.sequences
      .flatMap((sequence) => sequence.tracks)
      .flatMap((track) => (track.kind === "caption" ? [] : track.clips))
      .find((candidate) => candidate.id !== clipId)?.id;
    setCurrentProjection((current) => ({
      ...current,
      state: {
        ...current.state,
        sequences: current.state.sequences.map((sequence) => ({
          ...sequence,
          tracks: sequence.tracks.map((track) => {
            if (track.kind === "caption") return track;
            const deleted = track.clips.find((candidate) => candidate.id === clipId);
            if (deleted === undefined) return track;
            const duration = deleted.sourceOut.value - deleted.sourceIn.value;
            const deletedEnd = deleted.timelineStart.value + duration;
            return {
              ...track,
              clips: track.clips
                .filter((candidate) => candidate.id !== clipId)
                .map((candidate) =>
                  candidate.timelineStart.value >= deletedEnd
                    ? {
                        ...candidate,
                        timelineStart: time(candidate.timelineStart.value - duration),
                      }
                    : candidate,
                ),
            };
          }),
        })),
      },
    }));
    setSelectedClipId(nextSelectedClipId ?? null);
  };

  return (
    <main
      className="video-workspace shared-rail timeline-browser-fixture"
      style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
    >
      <MultitrackTimeline
        projection={currentProjection}
        preparedAsset={null}
        convertCachePath={(path) => path}
        selectedClipId={selectedClipId}
        playheadFrame={10}
        editPending={false}
        editError={null}
        onSelectClip={setSelectedClipId}
        onSplitClip={splitClip}
        onRippleDeleteClip={rippleDeleteClip}
        onMoveClip={(clipId, timelineStartFrame) =>
          updateClip(clipId, (candidate) => ({
            ...candidate,
            timelineStart: time(timelineStartFrame),
          }))
        }
        onTrimClip={(clipId, sourceInFrame, sourceOutFrame, timelineStartFrame) =>
          updateClip(clipId, (candidate) => ({
            ...candidate,
            timelineStart: time(timelineStartFrame),
            sourceIn: time(sourceInFrame),
            sourceOut: time(sourceOutFrame),
          }))
        }
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ControlledTimelineFixture />
  </React.StrictMode>,
);
