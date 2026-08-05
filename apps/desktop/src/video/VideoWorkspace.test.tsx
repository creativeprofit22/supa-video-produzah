// @vitest-environment jsdom

import type { ProjectProjection, VideoProjectFileV1 } from "@supa-video/contracts";
import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testProbe, testSourceIdentity } from "../test-video-service";
import { VideoWorkspace } from "./VideoWorkspace";

const { captureProgramMonitorProps } = vi.hoisted(() => ({
  captureProgramMonitorProps: vi.fn(),
}));

vi.mock("./AssetPanel", () => ({ AssetPanel: () => null }));
vi.mock("./ClipTrimRanges", () => ({ ClipTrimRanges: () => null }));
vi.mock("./ExportPanel", () => ({ ExportPanel: () => null }));
vi.mock("./MultitrackTimeline", () => ({ MultitrackTimeline: () => null }));
vi.mock("./ProjectInspector", () => ({ ProjectInspector: () => null }));
vi.mock("./TrimInspector", () => ({ TrimInspector: () => null }));
vi.mock("./ProgramMonitor", () => ({
  ProgramMonitor: (props: { readonly timelineAudioMuted: boolean }) => {
    captureProgramMonitorProps(props);
    return <div data-testid="program-monitor" />;
  },
}));

const id = (suffix: number): string =>
  `76000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const timestamp = "2026-08-05T12:00:00.000Z";
const rate = { numerator: 25, denominator: 1 } as const;
const time = (value: number) => ({ value, rateNumerator: 25, rateDenominator: 1 });
const transform = {
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1_000,
  scaleYPermille: 1_000,
  rotationMilliDegrees: 0,
  opacityPermille: 1_000,
};
const assetId = id(1);
const sequenceId = id(2);
const previewClipId = id(3);

function canonicalProjection(previewOwnerMuted = true): ProjectProjection {
  return {
    projectId: id(10),
    name: "Canonical mute owner",
    revision: {
      number: 4,
      id: id(11),
      parentId: id(12),
      committedAt: timestamp,
      operationId: id(13),
      stateHash: "ab".repeat(32),
    },
    state: {
      assets: [
        {
          id: assetId,
          displayName: "camera.mp4",
          locator: { absolutePath: "C:\\Media\\camera.mp4" },
          probe: testProbe,
          contentIdentity: testSourceIdentity,
        },
      ],
      sequences: [
        {
          id: sequenceId,
          name: "Main sequence",
          rate,
          width: 720,
          height: 576,
          audioSampleRate: 48_000,
          tracks: [
            {
              id: id(20),
              name: "Other canonical track",
              kind: "video",
              muted: !previewOwnerMuted,
              clips: [
                {
                  id: id(21),
                  source: { kind: "asset", assetId },
                  timelineStart: time(0),
                  sourceIn: time(50),
                  sourceOut: time(75),
                  transform,
                  gainMilliDecibels: 0,
                },
              ],
            },
            {
              id: id(30),
              name: "Preview owner",
              kind: "video",
              muted: previewOwnerMuted,
              clips: [
                {
                  id: previewClipId,
                  source: { kind: "asset", assetId },
                  timelineStart: time(25),
                  sourceIn: time(0),
                  sourceOut: time(25),
                  transform,
                  gainMilliDecibels: 0,
                },
              ],
            },
          ],
          markers: [],
        },
      ],
      activeSequenceId: sequenceId,
    },
    canUndo: true,
    canRedo: false,
    lastCommand: null,
    sources: [],
    journalHealth: "healthy",
    snapshotRevision: 4,
    recoveryStatus: "clean",
    replayedRecordCount: 0,
  };
}

function legacyProject(): VideoProjectFileV1 {
  const revisionId = id(40);
  return {
    schemaVersion: 1,
    id: id(41),
    name: "Workspace fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    currentRevisionId: revisionId,
    revisions: [
      {
        id: revisionId,
        parentRevisionId: null,
        sequenceNumber: 0,
        committedAt: timestamp,
        commandSummary: "Created project",
        state: {
          asset: {
            id: assetId,
            displayName: "camera.mp4",
            locator: { absolutePath: "C:\\Media\\camera.mp4" },
            probe: testProbe,
            contentIdentity: testSourceIdentity,
          },
          sequence: {
            id: sequenceId,
            rate,
            width: 720,
            height: 576,
            audioSampleRate: 48_000,
            videoTracks: [
              {
                id: id(42),
                clips: [
                  {
                    id: previewClipId,
                    assetId,
                    timelineStart: time(0),
                    sourceIn: time(0),
                    sourceOut: time(25),
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  captureProgramMonitorProps.mockClear();
});

describe("VideoWorkspace", () => {
  it("derives preview mute from the canonical track that owns the active preview clip", () => {
    const controller = {
      projectPath: "C:\\Projects\\workspace.svpvideo",
      projection: canonicalProjection(),
      recovery: null,
      checkpointWarning: null,
      source: null,
      preparedAsset: null,
      preparation: { phase: "idle" },
      projectOperation: { phase: "idle" },
      render: { phase: "idle" },
      destinationPending: false,
      destinationError: null,
      trimDraft: { inFrame: 0, outFrame: 25 },
      sourceFrameCount: 25,
      trimValid: true,
      trimChanged: false,
      editOperation: { phase: "idle" },
      canUndo: true,
      canRedo: false,
      renderReady: false,
      retryPreparation: vi.fn(),
      updateTrimDraft: vi.fn(),
      applyTrim: vi.fn(),
      splitTimelineClip: vi.fn(),
      moveTimelineClip: vi.fn(),
      trimTimelineClip: vi.fn(),
      rippleDeleteTimelineClip: vi.fn(),
      setTimelineTrackLocked: vi.fn(),
      setTimelineTrackMuted: vi.fn(),
      undoEdit: vi.fn(),
      redoEdit: vi.fn(),
      convertCachePath: (path: string) => path,
      chooseSource: vi.fn(),
      regrantSourceAccess: vi.fn(),
      exportVideo: vi.fn(),
      confirmOverwrite: vi.fn(),
      cancelRender: vi.fn(),
    } as unknown as ComponentProps<typeof VideoWorkspace>["controller"];

    const workspace = (value: ComponentProps<typeof VideoWorkspace>["controller"]) => (
      <VideoWorkspace
        controller={value}
        mediaJobs={[]}
        project={legacyProject()}
        readiness={{
          phase: "loaded",
          value: {
            source: "bundled",
            toolchainId: "ffmpeg-test-v1",
            ffmpeg: { available: true, version: "8.1.2" },
            ffprobe: { available: true, version: "8.1.2" },
            ready: true,
          },
        }}
        onCheckTools={vi.fn()}
        onOpenJobCenter={vi.fn()}
        onNewProject={vi.fn()}
        onOpenProject={vi.fn()}
      />
    );
    const { rerender } = render(workspace(controller));

    expect(captureProgramMonitorProps).toHaveBeenCalled();
    expect(captureProgramMonitorProps.mock.lastCall?.[0]).toMatchObject({
      timelineAudioMuted: true,
    });

    const controllerWithMutedNonOwner = {
      ...controller,
      projection: canonicalProjection(false),
    } as ComponentProps<typeof VideoWorkspace>["controller"];
    rerender(workspace(controllerWithMutedNonOwner));
    expect(captureProgramMonitorProps.mock.lastCall?.[0]).toMatchObject({
      timelineAudioMuted: false,
    });
  });
});
