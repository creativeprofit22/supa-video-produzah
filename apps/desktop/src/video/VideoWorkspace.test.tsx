// @vitest-environment jsdom

import type { ProjectProjection, VideoProjectFileV1 } from "@supa-video/contracts";
import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandProvider } from "../commands/CommandProvider";
import { testProbe, testSourceIdentity } from "../test-video-service";
import { VideoWorkspace } from "./VideoWorkspace";

const { captureProgramMonitorProps, captureTimelineProps } = vi.hoisted(() => ({
  captureProgramMonitorProps: vi.fn(),
  captureTimelineProps: vi.fn(),
}));

vi.mock("./AssetPanel", () => ({ AssetPanel: () => null }));
vi.mock("./ClipTrimRanges", () => ({ ClipTrimRanges: () => null }));
vi.mock("./ExportPanel", () => ({ ExportPanel: () => null }));
vi.mock("./MultitrackTimeline", () => ({
  MultitrackTimeline: (props: {
    readonly onSetTrackHidden: (trackId: string, hidden: boolean) => void;
  }) => {
    captureTimelineProps(props);
    return null;
  },
}));
vi.mock("./ProjectInspector", () => ({ ProjectInspector: () => null }));
vi.mock("./TrimInspector", () => ({ TrimInspector: () => null }));
vi.mock("./ProgramMonitor", () => ({
  ProgramMonitor: (props: {
    readonly timelineAudioMuted: boolean;
    readonly timelineVideoHidden: boolean;
    readonly sourceLayers: readonly {
      readonly clipId: string;
      readonly canonicalTrackIndex: number;
      readonly opacityPermille: number;
      readonly hidden: boolean;
      readonly muted: boolean;
    }[];
    readonly activeCaptions: readonly { readonly captionId: string; readonly text: string }[];
  }) => {
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

function canonicalProjection(
  previewOwnerMuted = true,
  previewOwnerHidden = true,
  opacityPermille = { other: 1_000, preview: 425, following: 0 },
): ProjectProjection {
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
              hidden: !previewOwnerHidden,
              clips: [
                {
                  id: id(21),
                  source: { kind: "asset", assetId },
                  timelineStart: time(0),
                  sourceIn: time(50),
                  sourceOut: time(75),
                  transform: { ...transform, opacityPermille: opacityPermille.other },
                  gainMilliDecibels: 0,
                },
              ],
            },
            {
              id: id(37),
              name: "Interleaved captions",
              kind: "caption",
              captions: [],
            },
            {
              id: id(38),
              name: "Interleaved audio",
              kind: "audio",
              clips: [],
            },
            {
              id: id(30),
              name: "Preview owner",
              kind: "video",
              muted: previewOwnerMuted,
              hidden: previewOwnerHidden,
              clips: [
                {
                  id: previewClipId,
                  source: { kind: "asset", assetId },
                  timelineStart: time(25),
                  sourceIn: time(0),
                  sourceOut: time(25),
                  transform: { ...transform, opacityPermille: opacityPermille.preview },
                  gainMilliDecibels: 0,
                },
                {
                  id: id(36),
                  source: { kind: "asset", assetId },
                  timelineStart: time(50),
                  sourceIn: time(25),
                  sourceOut: time(50),
                  transform: { ...transform, opacityPermille: opacityPermille.following },
                  gainMilliDecibels: 0,
                },
              ],
            },
            {
              id: id(31),
              name: "Shown captions",
              kind: "caption",
              captions: [
                { id: id(32), start: time(20), end: time(30), text: "Shown cue" },
                { id: id(33), start: time(30), end: time(40), text: "Later cue" },
              ],
            },
            {
              id: id(34),
              name: "Hidden captions",
              kind: "caption",
              hidden: true,
              captions: [{ id: id(35), start: time(20), end: time(30), text: "Hidden cue" }],
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
  captureTimelineProps.mockClear();
});

describe("VideoWorkspace", () => {
  it("passes every canonical video layer in stacking order with independent visibility and mute", () => {
    const controller = {
      projectPath: "C:\\Projects\\workspace.svpvideo",
      projection: canonicalProjection(),
      recovery: null,
      checkpointWarning: null,
      source: null,
      preparedAsset: { proxyPath: "/cache/shared-proxy.mp4" },
      preparedAssetsById: { [assetId]: { proxyPath: "/cache/shared-proxy.mp4" } },
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
      setTimelineTrackHidden: vi.fn(),
      undoEdit: vi.fn(),
      redoEdit: vi.fn(),
      convertCachePath: (path: string) => path,
      chooseSource: vi.fn(),
      regrantSourceAccess: vi.fn(),
      exportVideo: vi.fn(),
      confirmOverwrite: vi.fn(),
      cancelRender: vi.fn(),
    } as unknown as ComponentProps<typeof VideoWorkspace>["controller"];

    const workspace = (
      value: ComponentProps<typeof VideoWorkspace>["controller"],
      selectedClipOpacityDraft: ComponentProps<
        typeof VideoWorkspace
      >["selectedClipOpacityDraft"] = null,
    ) => (
      <CommandProvider>
        <VideoWorkspace
          controller={value}
          mediaJobs={[]}
          selectedClipOpacityDraft={selectedClipOpacityDraft}
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
        />
      </CommandProvider>
    );
    const { rerender } = render(workspace(controller));

    expect(captureProgramMonitorProps).toHaveBeenCalled();
    expect(captureProgramMonitorProps.mock.lastCall?.[0]).toMatchObject({
      sourceLayers: [
        {
          clipId: id(21),
          canonicalTrackIndex: 0,
          timelineStartFrame: 0,
          opacityPermille: 1_000,
          hidden: false,
          muted: false,
        },
        {
          clipId: previewClipId,
          canonicalTrackIndex: 3,
          timelineStartFrame: 25,
          opacityPermille: 425,
          hidden: true,
          muted: true,
        },
        {
          clipId: id(36),
          canonicalTrackIndex: 3,
          timelineStartFrame: 50,
          opacityPermille: 0,
          hidden: true,
          muted: true,
        },
      ],
      activeCaptions: [],
    });
    rerender(workspace(controller, { clipId: previewClipId, opacityPermille: 875 }));
    expect(captureProgramMonitorProps.mock.lastCall?.[0]).toMatchObject({
      sourceLayers: [
        { clipId: id(21), opacityPermille: 1_000 },
        { clipId: previewClipId, opacityPermille: 425 },
        { clipId: id(36), opacityPermille: 0 },
      ],
    });

    rerender(workspace(controller, { clipId: id(21), opacityPermille: 333 }));
    expect(captureProgramMonitorProps.mock.lastCall?.[0]).toMatchObject({
      sourceLayers: [
        { clipId: id(21), opacityPermille: 333 },
        { clipId: previewClipId, opacityPermille: 425 },
        { clipId: id(36), opacityPermille: 0 },
      ],
    });

    const timelineProps = captureTimelineProps.mock.lastCall?.[0] as
      { readonly onSetTrackHidden: (trackId: string, hidden: boolean) => void } | undefined;
    timelineProps?.onSetTrackHidden(id(30), false);
    expect(controller.setTimelineTrackHidden).toHaveBeenCalledWith({
      trackId: id(30),
      hidden: false,
    });

    const controllerWithMutedAndHiddenNonOwner = {
      ...controller,
      projection: canonicalProjection(false, false),
    } as ComponentProps<typeof VideoWorkspace>["controller"];
    rerender(workspace(controllerWithMutedAndHiddenNonOwner));
    expect(captureProgramMonitorProps.mock.lastCall?.[0]).toMatchObject({
      sourceLayers: [
        {
          canonicalTrackIndex: 0,
          opacityPermille: 1_000,
          hidden: true,
          muted: true,
        },
        {
          clipId: previewClipId,
          canonicalTrackIndex: 3,
          opacityPermille: 425,
          hidden: false,
          muted: false,
        },
        {
          clipId: id(36),
          canonicalTrackIndex: 3,
          opacityPermille: 0,
          hidden: false,
          muted: false,
        },
      ],
      activeCaptions: [{ captionId: id(32), text: "Shown cue" }],
    });

    const reconciledController = {
      ...controllerWithMutedAndHiddenNonOwner,
      projection: canonicalProjection(false, false, {
        other: 600,
        preview: 425,
        following: 0,
      }),
    } as ComponentProps<typeof VideoWorkspace>["controller"];
    rerender(workspace(reconciledController));
    expect(captureProgramMonitorProps.mock.lastCall?.[0]).toMatchObject({
      sourceLayers: [
        { clipId: id(21), opacityPermille: 600 },
        { clipId: previewClipId, opacityPermille: 425 },
        { clipId: id(36), opacityPermille: 0 },
      ],
    });
  });
});
