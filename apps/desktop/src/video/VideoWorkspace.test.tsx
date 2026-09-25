// @vitest-environment jsdom

import type { ProjectProjection, VideoProjectFileV1 } from "@supa-video/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler, type ComponentProps } from "react";
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
  otherTrackLocked = false,
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
              locked: otherTrackLocked,
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
              clips: [
                {
                  id: id(39),
                  source: { kind: "asset", assetId },
                  timelineStart: time(0),
                  sourceIn: time(0),
                  sourceOut: time(25),
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

type WorkspaceController = ComponentProps<typeof VideoWorkspace>["controller"];

function createController(overrides: Partial<WorkspaceController> = {}): WorkspaceController {
  return {
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
    setTimelineClipOpacity: vi.fn().mockResolvedValue(true),
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
    ...overrides,
  } as unknown as WorkspaceController;
}

function workspace(controller: WorkspaceController) {
  return (
    <CommandProvider>
      <VideoWorkspace
        controller={controller}
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
      />
    </CommandProvider>
  );
}

afterEach(() => {
  cleanup();
  captureProgramMonitorProps.mockClear();
  captureTimelineProps.mockClear();
});

describe("VideoWorkspace", () => {
  it("restores and resets only the local layout without replacing children or invoking controller actions", () => {
    const preferenceKey = "supa-video.workspace-preferences";
    const previous = localStorage.getItem(preferenceKey);
    localStorage.setItem(preferenceKey, JSON.stringify({ version: 1, split: 75 }));
    try {
      const controller = createController();
      const projectionBefore = JSON.stringify(controller.projection);
      render(workspace(controller));
      const separator = screen.getByRole("separator", {
        name: "Program and media / editing controls pane width",
      });
      const monitor = screen.getByTestId("program-monitor");
      const controls = screen.getByRole("complementary", { name: "Editing controls" });
      const actionCalls = () =>
        Object.values(controller).flatMap((action) =>
          vi.isMockFunction(action) ? [action.mock.calls.length] : [],
        );
      const callsBefore = actionCalls();
      expect(separator.getAttribute("aria-valuenow")).toBe("75");
      expect(separator.getAttribute("aria-orientation")).toBe("vertical");
      expect(
        document.getElementById(separator.getAttribute("aria-controls")!)?.contains(monitor),
      ).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));

      expect(separator.getAttribute("aria-valuenow")).toBe("68.5");
      expect(JSON.parse(localStorage.getItem(preferenceKey)!)).toEqual({
        version: 1,
        split: 68.5,
      });
      expect(screen.getByTestId("program-monitor")).toBe(monitor);
      expect(screen.getByRole("complementary", { name: "Editing controls" })).toBe(controls);
      expect(actionCalls()).toEqual(callsBefore);
      expect(JSON.stringify(controller.projection)).toBe(projectionBefore);
    } finally {
      if (previous === null) localStorage.removeItem(preferenceKey);
      else localStorage.setItem(preferenceKey, previous);
    }
  });

  it("enables direct-asset retimed preview and passes canonical timing metadata", () => {
    const projection = canonicalProjection(false, false);
    const track = projection.state.sequences[0]!.tracks[0]!;
    if (track.kind === "caption") throw new Error("Expected video track");
    track.clips[0]!.speed = { numerator: 1, denominator: 2 };
    render(workspace(createController({ projection })));
    const props = captureProgramMonitorProps.mock.lastCall?.[0];
    expect(props.unsupportedReason).toBeNull();
    expect(
      props.sourceLayers.find((layer: { clipId: string }) => layer.clipId === id(21)),
    ).toMatchObject({
      timelineDurationFrames: 50,
      speed: { numerator: 1, denominator: 2 },
      sourceRate: {
        numerator: track.clips[0]!.sourceIn.rateNumerator,
        denominator: track.clips[0]!.sourceIn.rateDenominator,
      },
      timelineStartFrame: track.clips[0]!.timelineStart.value,
      sourceInFrame: track.clips[0]!.sourceIn.value,
      sourceOutFrame: track.clips[0]!.sourceOut.value,
    });
  });
  it("passes canonical video and audio layers in track order with independent visibility and mute", () => {
    const controller = createController();
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
          clipId: id(39),
          audioOnly: true,
          canonicalTrackIndex: 2,
          timelineStartFrame: 0,
          sourceInFrame: 0,
          sourceOutFrame: 25,
          timelineDurationFrames: 25,
          hasAudio: true,
          hidden: false,
          muted: false,
          gainMilliDecibels: 0,
          fades: { inFrames: 0, outFrames: 0 },
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
          clipId: id(39),
          audioOnly: true,
          canonicalTrackIndex: 2,
          timelineStartFrame: 0,
          sourceInFrame: 0,
          sourceOutFrame: 25,
          timelineDurationFrames: 25,
          hasAudio: true,
          hidden: false,
          muted: false,
          gainMilliDecibels: 0,
          fades: { inFrames: 0, outFrames: 0 },
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
        { clipId: id(39), audioOnly: true, opacityPermille: 1000 },
        { clipId: previewClipId, opacityPermille: 425 },
        { clipId: id(36), opacityPermille: 0 },
      ],
    });
  });

  describe("playback commit isolation", () => {
    type MonitorProps = {
      readonly playhead: number;
      readonly activeCaptions: readonly { readonly captionId: string; readonly text: string }[];
      readonly onPlayheadChange: (frame: number) => void;
      readonly onPlayingChange: (playing: boolean) => void;
    };
    type TimelineProps = {
      readonly previewSourceFrame: number;
      readonly timelinePlayheadFrame: number | null;
      readonly playbackClock: {
        readonly read: () => {
          readonly playing: boolean;
          readonly timelineFrame: number | null;
          readonly previewSourceFrame: number;
        };
      };
    };
    const monitor = () => captureProgramMonitorProps.mock.lastCall?.[0] as MonitorProps;
    const timeline = () => captureTimelineProps.mock.lastCall?.[0] as TimelineProps;

    function renderProfiled() {
      const commits = { count: 0 };
      render(
        <Profiler id="workspace" onRender={() => (commits.count += 1)}>
          {workspace(createController({ projection: canonicalProjection(false, false) }))}
        </Profiler>,
      );
      // Seek (not playing) into the preview clip, then start playback.
      act(() => monitor().onPlayheadChange(26));
      act(() => monitor().onPlayingChange(true));
      return commits;
    }

    it("does not commit the workspace or timeline for playback ticks inside a clip", () => {
      const commits = renderProfiled();
      const workspaceBefore = commits.count;
      const timelineBefore = captureTimelineProps.mock.calls.length;

      for (const frame of [27, 28, 29]) act(() => monitor().onPlayheadChange(frame));

      expect(commits.count - workspaceBefore).toBe(0);
      expect(captureTimelineProps.mock.calls.length - timelineBefore).toBe(0);
      expect(timeline().previewSourceFrame).toBe(1);
      expect(timeline().timelinePlayheadFrame).toBe(26);
      expect(timeline().playbackClock.read()).toEqual({
        playing: true,
        timelineFrame: 29,
        previewSourceFrame: 4,
      });
    });

    it("commits once at a caption boundary and shows the exact caption", () => {
      const commits = renderProfiled();
      for (const frame of [27, 28, 29]) act(() => monitor().onPlayheadChange(frame));
      const workspaceBefore = commits.count;
      const timelineBefore = captureTimelineProps.mock.calls.length;
      expect(monitor().activeCaptions).toEqual([{ captionId: id(32), text: "Shown cue" }]);

      act(() => monitor().onPlayheadChange(30));

      expect(commits.count - workspaceBefore).toBe(1);
      expect(captureTimelineProps.mock.calls.length - timelineBefore).toBe(0);
      expect(monitor().playhead).toBe(30);
      expect(monitor().activeCaptions).toEqual([{ captionId: id(33), text: "Later cue" }]);
    });

    it("commits the exact live frame when playback stops", () => {
      renderProfiled();
      // 28 -> 31 crosses the cue boundary at 30, so 31 is the last structural commit.
      for (const frame of [27, 28, 31, 32]) act(() => monitor().onPlayheadChange(frame));
      expect(monitor().playhead).toBe(31);

      act(() => monitor().onPlayingChange(false));

      expect(monitor().playhead).toBe(32);
      expect(timeline().previewSourceFrame).toBe(7);
      expect(timeline().timelinePlayheadFrame).toBe(32);
      expect(timeline().playbackClock.read()).toEqual({
        playing: false,
        timelineFrame: 32,
        previewSourceFrame: 7,
      });
    });
  });

  it("keeps speed drafts out of preview, routes Apply, and discards them on revision and selection changes", () => {
    const setTimelineClipSpeed = vi.fn(async () => true);
    const controller = createController({ setTimelineClipSpeed });
    const view = render(workspace(controller));
    const layers = structuredClone(captureProgramMonitorProps.mock.lastCall?.[0]?.sourceLayers);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(setTimelineClipSpeed).not.toHaveBeenCalled();
    expect(captureProgramMonitorProps.mock.lastCall?.[0]?.sourceLayers).toEqual(layers);
    fireEvent.click(screen.getByRole("button", { name: "Apply speed" }));
    expect(setTimelineClipSpeed).toHaveBeenCalledExactlyOnceWith({
      sequenceId,
      trackId: id(20),
      clipId: id(21),
      speed: { numerator: 1, denominator: 2 },
    });
    const projection = structuredClone(controller.projection!);
    projection.revision.id = id(99);
    view.rerender(workspace(createController({ projection, setTimelineClipSpeed })));
    expect((screen.getByRole("spinbutton", { name: "Speed (%)" }) as HTMLInputElement).value).toBe(
      "100",
    );
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    const timeline = captureTimelineProps.mock.lastCall?.[0] as {
      onSelectClip: (id: string) => void;
    };
    act(() => timeline.onSelectClip(previewClipId));
    expect((screen.getByRole("spinbutton", { name: "Speed (%)" }) as HTMLInputElement).value).toBe(
      "100",
    );
  });

  it("routes selected source Apply through canonical trim without legacy drafts or implicit movement", () => {
    const controller = createController();
    const view = render(workspace(controller));
    const input = screen.getByRole("spinbutton", { name: /^Source in \(/ });
    fireEvent.change(input, { target: { value: "1" } });
    expect(controller.trimTimelineClip).not.toHaveBeenCalled();
    expect(controller.updateTrimDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Apply source range"));
    expect(controller.trimTimelineClip).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ clipId: id(21), sourceInFrame: 1, timelineStartFrame: 0 }),
    );
    const projection = structuredClone(controller.projection!);
    projection.revision.id = id(99);
    view.rerender(workspace({ ...controller, projection }));
    expect(
      (screen.getByRole("spinbutton", { name: /^Source in \(/ }) as HTMLInputElement).value,
    ).toBe("50");
  });

  it("drafts only the selected video and clears the draft when selection changes", () => {
    const controller = createController();
    render(workspace(controller));
    const slider = screen.getByRole("slider", { name: "Opacity" });

    expect((slider as HTMLInputElement).value).toBe("1000");
    fireEvent.change(slider, { target: { value: "333" } });
    expect(
      captureProgramMonitorProps.mock.lastCall?.[0]?.sourceLayers
        .filter((layer: { audioOnly?: boolean }) => !layer.audioOnly)
        .slice(0, 2),
    ).toMatchObject([
      { clipId: id(21), opacityPermille: 333 },
      { clipId: previewClipId, opacityPermille: 425 },
    ]);

    const timeline = captureTimelineProps.mock.lastCall?.[0] as {
      readonly onSelectClip: (clipId: string) => void;
    };
    act(() => timeline.onSelectClip(previewClipId));

    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).value).toBe("425");
    expect(
      captureProgramMonitorProps.mock.lastCall?.[0]?.sourceLayers
        .filter((layer: { audioOnly?: boolean }) => !layer.audioOnly)
        .slice(0, 2),
    ).toMatchObject([
      { clipId: id(21), opacityPermille: 1_000 },
      { clipId: previewClipId, opacityPermille: 425 },
    ]);
  });

  it("shows an empty inspector for an audio selection and locked guidance for a locked video", () => {
    const controller = createController();
    const { rerender } = render(workspace(controller));
    const timeline = captureTimelineProps.mock.lastCall?.[0] as {
      readonly onSelectClip: (clipId: string) => void;
    };

    act(() => timeline.onSelectClip(id(39)));
    expect(screen.queryByRole("slider", { name: "Opacity" })).toBeNull();
    expect(screen.getByText("Select a video clip to edit its appearance.")).not.toBeNull();

    rerender(
      workspace(
        createController({
          projection: canonicalProjection(true, true, undefined, true),
        }),
      ),
    );
    const updatedTimeline = captureTimelineProps.mock.lastCall?.[0] as {
      readonly onSelectClip: (clipId: string) => void;
    };
    act(() => updatedTimeline.onSelectClip(id(21)));
    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Unlock this track to change clip appearance.")).not.toBeNull();
  });

  it("disables the control while opacity saves and exposes opacity controller failures", () => {
    const savingController = createController({
      editOperation: { phase: "saving", operation: "clip-opacity" },
    });
    const { rerender } = render(workspace(savingController));

    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Saving clip appearance").textContent).toBe("Saving clip appearance");

    rerender(
      workspace(
        createController({
          editOperation: {
            phase: "error",
            operation: "clip-opacity",
            error: new Error("The revision changed."),
          },
        }),
      ),
    );
    expect(screen.getByRole("alert").textContent).toContain("The revision changed.");
    expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  it("commits the exact selected target on pointer release and rolls back after failure", async () => {
    const setTimelineClipOpacity = vi.fn().mockResolvedValue(false);
    const controller = createController({ setTimelineClipOpacity });
    render(workspace(controller));
    const slider = screen.getByRole("slider", { name: "Opacity" });

    fireEvent.change(slider, { target: { value: "610" } });
    expect(setTimelineClipOpacity).not.toHaveBeenCalled();
    expect(captureProgramMonitorProps.mock.lastCall?.[0]?.sourceLayers[0]).toMatchObject({
      clipId: id(21),
      opacityPermille: 610,
    });

    fireEvent.pointerUp(slider);
    await waitFor(() =>
      expect(setTimelineClipOpacity).toHaveBeenCalledWith({
        sequenceId,
        trackId: id(20),
        clipId: id(21),
        opacityPermille: 610,
      }),
    );
    await waitFor(() =>
      expect((screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement).value).toBe(
        "1000",
      ),
    );
    expect(captureProgramMonitorProps.mock.lastCall?.[0]?.sourceLayers[0]).toMatchObject({
      clipId: id(21),
      opacityPermille: 1_000,
    });
  });

  it("commits keyboard drafts on Enter and blur", async () => {
    const setTimelineClipOpacity = vi.fn().mockResolvedValue(true);
    render(workspace(createController({ setTimelineClipOpacity })));
    const slider = screen.getByRole("slider", { name: "Opacity" });

    fireEvent.change(slider, { target: { value: "700" } });
    fireEvent.keyDown(slider, { key: "Enter" });
    await waitFor(() => expect(setTimelineClipOpacity).toHaveBeenCalledTimes(1));

    fireEvent.change(slider, { target: { value: "800" } });
    fireEvent.blur(slider);
    await waitFor(() => expect(setTimelineClipOpacity).toHaveBeenCalledTimes(2));
    expect(setTimelineClipOpacity).toHaveBeenLastCalledWith(
      expect.objectContaining({ clipId: id(21), opacityPermille: 800 }),
    );
  });
});
