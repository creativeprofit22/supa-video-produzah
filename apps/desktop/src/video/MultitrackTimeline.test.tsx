// @vitest-environment jsdom
import type { ProjectClip, ProjectProjection } from "@supa-video/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render as testingLibraryRender,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandProvider } from "../commands/CommandProvider";
import { testPrepared, testProbe, testSourceIdentity } from "../test-video-service";
import { MultitrackTimeline } from "./MultitrackTimeline";
import { createPlaybackClock } from "./playback-clock";

function render(ui: ReactElement): RenderResult {
  const result = testingLibraryRender(<CommandProvider>{ui}</CommandProvider>);
  const rerender = (nextUi: ReactNode) =>
    result.rerender(<CommandProvider>{nextUi}</CommandProvider>);
  return { ...result, rerender };
}

const rate = { numerator: 10, denominator: 1 } as const;
const sourceRate = { numerator: 20, denominator: 1 } as const;
const id = (value: number): string =>
  `30000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const timeAtRate = (value: number, frameRate: typeof rate | typeof sourceRate) => ({
  value,
  rateNumerator: frameRate.numerator,
  rateDenominator: frameRate.denominator,
});
const time = (value: number) => timeAtRate(value, rate);
const sourceTime = (value: number) => timeAtRate(value, sourceRate);
const transform = {
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1_000,
  scaleYPermille: 1_000,
  rotationMilliDegrees: 0,
  opacityPermille: 1_000,
};

function clip(value: number, start: number, source: ProjectClip["source"]): ProjectClip {
  return {
    id: id(value),
    source,
    timelineStart: time(start),
    sourceIn: time(0),
    sourceOut: time(2),
    transform,
    gainMilliDecibels: 0,
  };
}

function projectionFixture({
  name,
  videoClipCount,
  audioClipCount,
}: {
  name: string;
  videoClipCount: number;
  audioClipCount: number;
}): ProjectProjection {
  const assetId = id(1);
  const nestedSequenceId = id(3);
  const videoClips = Array.from({ length: videoClipCount }, (_, index) =>
    clip(100_000 + index, index * 4, { kind: "asset", assetId }),
  );
  const audioClips = Array.from({ length: audioClipCount }, (_, index) =>
    clip(200_000 + index, index * 4, { kind: "sequence", sequenceId: nestedSequenceId }),
  );
  return {
    projectId: id(900_001),
    name,
    revision: {
      number: 7,
      id: id(900_002),
      parentId: id(900_003),
      committedAt: "2026-08-03T12:00:00.000Z",
      operationId: id(900_004),
      stateHash: "ab".repeat(32),
    },
    state: {
      assets: [
        {
          id: assetId,
          displayName: "camera-a.mp4",
          locator: { absolutePath: "C:\\Media\\camera-a.mp4" },
          probe: { ...testProbe, averageFrameRate: rate, realFrameRate: rate },
          contentIdentity: testSourceIdentity,
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
          tracks: [
            { id: id(10), name: "Camera", kind: "video", clips: videoClips },
            { id: id(11), name: "Nested audio", kind: "audio", clips: audioClips },
            { id: id(12), name: "Captions", kind: "caption", captions: [] },
          ],
          markers: [],
        },
        {
          id: nestedSequenceId,
          name: "Nested interview",
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
    snapshotRevision: 7,
    recoveryStatus: "clean",
    replayedRecordCount: 0,
  };
}

function largeProjection(): ProjectProjection {
  return projectionFixture({
    name: "Large timeline",
    videoClipCount: 5_000,
    audioClipCount: 5_000,
  });
}

function interactionProjection(): ProjectProjection {
  return projectionFixture({ name: "Interaction timeline", videoClipCount: 1, audioClipCount: 0 });
}

class ImmediateResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
      this,
    );
  }
  unobserve() {}
  disconnect() {}
}

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return this.classList.contains("multitrack-scroll-region") ? 320 : 0;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalClientWidth === undefined)
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  else Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
});

function materializedClipIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-clip-id]")).map(
    (element) => element.dataset.clipId!,
  );
}

function timelineProps(overrides: Partial<ComponentProps<typeof MultitrackTimeline>> = {}) {
  return {
    projection: interactionProjection(),
    preparedAsset: testPrepared,
    convertCachePath: (path: string) => `asset:${path}`,
    selectedClipId: null,
    previewSourceFrame: 1,
    timelinePlayheadFrame: 1,
    editPending: false,
    editError: null,
    onSelectClip: vi.fn(),
    onSetTrackLocked: vi.fn(),
    onSetTrackMuted: vi.fn(),
    onSetTrackHidden: vi.fn(),
    onSplitClip: vi.fn(),
    onRippleDeleteClip: vi.fn(),
    onMoveClip: vi.fn(),
    onTrimClip: vi.fn(),
    ...overrides,
  } satisfies ComponentProps<typeof MultitrackTimeline>;
}

describe("MultitrackTimeline", () => {
  it("falls back to window resize events when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    const rendered = render(<MultitrackTimeline {...timelineProps()} />);
    const resizeListener = addEventListener.mock.calls.find(([type]) => type === "resize")?.[1];

    expect(resizeListener).toBeTypeOf("function");
    rendered.unmount();
    expect(removeEventListener).toHaveBeenCalledWith("resize", resizeListener);
    addEventListener.mockRestore();
    removeEventListener.mockRestore();
  });

  it("bounds semantic DOM and thumbnail construction to viewport overscan while scrolling", async () => {
    const projection = largeProjection();
    const convertCachePath = vi.fn((path: string) => `asset:${path}`);
    const rendered = render(
      <MultitrackTimeline {...timelineProps({ projection, convertCachePath })} />,
    );

    const region = screen.getByRole("region", { name: "Timeline tracks; scroll horizontally" });
    expect(region.tabIndex).toBe(0);
    await waitFor(() => expect(materializedClipIds(rendered.container).length).toBeGreaterThan(0));

    const trackRows = screen
      .getAllByRole("listitem")
      .filter((item) => item.hasAttribute("data-track-id") && !item.hasAttribute("data-clip-id"));
    expect(trackRows.map((row) => row.dataset.trackKind)).toEqual(["video", "audio", "caption"]);
    expect(trackRows.map((row) => row.dataset.trackId)).toEqual([id(10), id(11), id(12)]);

    const initialIds = materializedClipIds(rendered.container);
    expect(initialIds.length).toBeLessThan(1_000);
    expect(convertCachePath).toHaveBeenCalledTimes(1);
    expect(
      rendered.container.querySelector("[data-start-frame='0'][data-end-frame-exclusive='2']"),
    ).toBeTruthy();
    expect(screen.getByLabelText(/camera-a\.mp4, frames 0 through 2, end exclusive/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Split at playhead" })).toBeTruthy();

    rendered.rerender(<MultitrackTimeline {...timelineProps({ projection, convertCachePath })} />);
    expect(convertCachePath).toHaveBeenCalledTimes(1);

    fireEvent.scroll(region, { target: { scrollLeft: 400 } });
    await waitFor(() => expect(materializedClipIds(rendered.container)).not.toEqual(initialIds));
    const scrolledIds = materializedClipIds(rendered.container);
    expect(
      Array.from(rendered.container.querySelectorAll<HTMLElement>("[data-clip-id]")).every(
        (clipElement) =>
          Number(clipElement.dataset.endFrameExclusive) > 600 &&
          Number(clipElement.dataset.startFrame) < 2200,
      ),
    ).toBe(true);
    expect(convertCachePath).toHaveBeenCalledTimes(1);
    expect(scrolledIds).not.toContain(id(100_000));
    expect(scrolledIds).not.toContain(id(200_000));
    expect(screen.getByLabelText(`${scrolledIds.length} visible clips`)).toBeTruthy();
  }, 30_000);

  it("keeps pointer and keyboard selection controlled and enables split only inside the clip", () => {
    const onSelectClip = vi.fn();
    const onSplitClip = vi.fn();
    const firstId = id(100_000);
    const props = timelineProps({
      projection: projectionFixture({
        name: "Two-clip interaction timeline",
        videoClipCount: 2,
        audioClipCount: 0,
      }),
      onSelectClip,
      onSplitClip,
    });
    const rendered = render(<MultitrackTimeline {...props} />);
    const firstClip = screen.getByRole("button", { name: /camera-a\.mp4, frames 0 through 2/ });
    const split = screen.getByRole("button", { name: "Split at playhead" });

    expect((split as HTMLButtonElement).disabled).toBe(true);
    fireEvent.pointerDown(firstClip, { button: 0, pointerId: 1 });
    fireEvent.click(firstClip);
    expect(onSelectClip).toHaveBeenCalledWith(firstId);
    expect(firstClip.getAttribute("aria-pressed")).toBe("false");

    rendered.rerender(<MultitrackTimeline {...props} selectedClipId={firstId} />);
    fireEvent.keyDown(firstClip, { key: "Enter", code: "Enter" });
    fireEvent.click(firstClip, { detail: 0 });
    expect(onSelectClip).toHaveBeenLastCalledWith(firstId);
    expect(firstClip.getAttribute("aria-pressed")).toBe("true");
    expect((split as HTMLButtonElement).disabled).toBe(false);
    const unselectedClip = screen.getByRole("button", { name: /frames 4 through 6/ });
    expect(unselectedClip.getAttribute("aria-pressed")).toBe("false");
    expect(fireEvent.keyDown(unselectedClip, { code: "KeyS" })).toBe(true);
    expect(onSplitClip).not.toHaveBeenCalled();
    fireEvent.keyDown(firstClip, { code: "KeyS" });
    expect(onSplitClip).toHaveBeenCalledOnce();
    expect(onSplitClip).toHaveBeenCalledWith(firstId, 1);

    const onSelectMediaClip = vi.fn();
    rendered.rerender(
      <MultitrackTimeline
        {...props}
        selectedClipId={null}
        selectedClipIds={[firstId, id(100_001)]}
        onSelectMediaClip={onSelectMediaClip}
      />,
    );
    expect(firstClip.getAttribute("aria-pressed")).toBe("true");
    expect((split as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Trim start of/ })).toBeNull();
    fireEvent.click(firstClip, { ctrlKey: true });
    expect(onSelectMediaClip).toHaveBeenLastCalledWith(firstId, "toggle");
    fireEvent.click(firstClip, { metaKey: true });
    expect(onSelectMediaClip).toHaveBeenLastCalledWith(firstId, "toggle");
    fireEvent.click(firstClip, { shiftKey: true });
    expect(onSelectMediaClip).toHaveBeenLastCalledWith(firstId, "range");
    const selectButton = screen.getAllByRole("button", { name: "Select camera-a.mp4" })[0]!;
    expect(selectButton.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(selectButton, { detail: 0 });
    expect(onSelectMediaClip).toHaveBeenLastCalledWith(firstId, "toggle");
    rendered.rerender(<MultitrackTimeline {...props} selectedClipId={firstId} />);

    rendered.rerender(
      <MultitrackTimeline {...props} selectedClipId={firstId} previewSourceFrame={2} />,
    );
    expect((split as HTMLButtonElement).disabled).toBe(true);
  });

  it("splits at the live playback frame while its playhead props stay frozen", () => {
    const onSplitClip = vi.fn();
    const firstId = id(100_000);
    const playbackClock = createPlaybackClock({
      playing: false,
      timelineFrame: 2,
      previewSourceFrame: 2,
    });
    render(
      <MultitrackTimeline
        {...timelineProps({
          projection: projectionFixture({
            name: "Live split timeline",
            videoClipCount: 2,
            audioClipCount: 0,
          }),
          selectedClipId: firstId,
          previewSourceFrame: 2,
          timelinePlayheadFrame: 2,
          playbackClock,
          onSplitClip,
        })}
      />,
    );
    const split = screen.getByRole("button", { name: "Split at playhead" }) as HTMLButtonElement;
    expect(split.disabled).toBe(true);

    act(() => playbackClock.publish({ playing: true, timelineFrame: 1, previewSourceFrame: 1 }));
    expect(split.disabled).toBe(false);
    fireEvent.click(split);
    expect(onSplitClip).toHaveBeenCalledExactlyOnceWith(firstId, 1);

    act(() => playbackClock.publish({ timelineFrame: 0, previewSourceFrame: 0 }));
    expect(split.disabled).toBe(true);
  });

  it("ripple deletes only an eligible selected clip by button or Shift+Delete", () => {
    const firstId = id(100_000);
    const onRippleDeleteClip = vi.fn();
    const props = timelineProps({ onRippleDeleteClip });
    const rendered = render(<MultitrackTimeline {...props} />);
    const firstClip = screen.getByRole("button", { name: /camera-a\.mp4, frames 0 through 2/ });
    const rippleDelete = screen.getByRole("button", { name: "Ripple delete clip" });

    expect((rippleDelete as HTMLButtonElement).disabled).toBe(true);
    expect(rippleDelete.getAttribute("aria-keyshortcuts")).toBeNull();
    expect(fireEvent.keyDown(firstClip, { key: "Delete", code: "Delete" })).toBe(true);
    expect(onRippleDeleteClip).not.toHaveBeenCalled();

    rendered.rerender(<MultitrackTimeline {...props} selectedClipId={firstId} />);
    expect((rippleDelete as HTMLButtonElement).disabled).toBe(false);
    expect(rippleDelete.getAttribute("aria-keyshortcuts")).toBe("Shift+Delete");
    fireEvent.click(rippleDelete);
    expect(onRippleDeleteClip).toHaveBeenCalledOnce();
    expect(onRippleDeleteClip).toHaveBeenLastCalledWith(firstId);

    expect(fireEvent.keyDown(rippleDelete, { key: "Delete", code: "Delete", shiftKey: true })).toBe(
      true,
    );
    expect(onRippleDeleteClip).toHaveBeenCalledTimes(1);

    expect(fireEvent.keyDown(firstClip, { key: "Delete", code: "Delete" })).toBe(true);
    expect(onRippleDeleteClip).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(firstClip, { key: "Delete", code: "Delete", shiftKey: true })).toBe(
      false,
    );
    expect(onRippleDeleteClip).toHaveBeenCalledTimes(2);
    expect(onRippleDeleteClip).toHaveBeenLastCalledWith(firstId);

    rendered.rerender(
      <MultitrackTimeline {...props} selectedClipId={firstId} editPending={true} />,
    );
    expect((rippleDelete as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(firstClip, { key: "Delete", code: "Delete", shiftKey: true });
    expect(onRippleDeleteClip).toHaveBeenCalledTimes(2);
  });

  it("exposes stable Eye toggles only for visual tracks without changing lock or selection semantics", () => {
    const hiddenProjection = projectionFixture({
      name: "Visibility interaction timeline",
      videoClipCount: 1,
      audioClipCount: 1,
    });
    const [videoTrack, audioTrack, captionTrack] = hiddenProjection.state.sequences[0]!.tracks;
    if (videoTrack?.kind !== "video") throw new Error("Expected a video track");
    if (audioTrack?.kind !== "audio") throw new Error("Expected an audio track");
    if (captionTrack?.kind !== "caption") throw new Error("Expected a caption track");
    videoTrack.locked = true;
    videoTrack.hidden = true;
    captionTrack.hidden = false;
    captionTrack.captions.push({
      id: id(300_000),
      start: time(0),
      end: time(2),
      text: "Opening caption",
    });
    const selectedClipId = id(100_000);
    const onSelectClip = vi.fn();
    const onSetTrackHidden = vi.fn();
    const props = timelineProps({
      projection: hiddenProjection,
      selectedClipId,
      onSelectClip,
      onSetTrackHidden,
    });
    const rendered = render(<MultitrackTimeline {...props} />);

    const videoVisibility = screen.getByRole("button", { name: "Camera video output" });
    const captionVisibility = screen.getByRole("button", { name: "Captions caption output" });
    const selectedClip = screen.getByRole("button", {
      name: /camera-a\.mp4, frames 0 through 2.*locked track/,
    });

    expect(screen.queryByRole("button", { name: "Nested audio audio output" })).toBeNull();
    expect(videoVisibility.className).toContain("multitrack-visibility-toggle");
    expect(videoVisibility.querySelector(".lucide-eye-off")).toBeTruthy();
    expect(videoVisibility.getAttribute("aria-pressed")).toBe("false");
    expect(videoVisibility.getAttribute("title")).toBe("Show track output");
    expect(videoVisibility.textContent).toContain("Show");
    expect((videoVisibility as HTMLButtonElement).disabled).toBe(false);
    expect(captionVisibility.querySelector(".lucide-eye")).toBeTruthy();
    expect(captionVisibility.getAttribute("aria-pressed")).toBe("true");
    expect(captionVisibility.getAttribute("title")).toBe("Hide track output");
    expect(captionVisibility.textContent).toContain("Hide");
    expect(
      screen.getByRole("group", { name: "Camera track controls" }).parentElement?.textContent,
    ).toContain("1 clips · Locked · Audible · Hidden");
    expect(
      screen.getByRole("group", { name: "Captions track controls" }).parentElement?.textContent,
    ).toContain("1 cue · Non-editable · Shown");
    const videoLabel = screen.getByRole("group", { name: "Camera track controls" }).parentElement!;
    const videoRow = screen.getByRole("listitem", {
      name: /Camera, video track.*locked.*audible.*hidden/,
    });
    const captionRow = screen.getByRole("listitem", {
      name: /Captions, caption track.*non-editable.*shown/,
    });
    const captionCue = screen.getByText("Opening caption").closest("li");
    expect(captionCue?.getAttribute("data-caption-id")).toBe(id(300_000));
    expect(captionCue?.querySelector("button")).toBeNull();
    const selectedClipContainer = selectedClip.parentElement!;
    expect(videoLabel.className).toContain("is-hidden");
    expect(videoLabel.getAttribute("data-track-hidden")).toBe("true");
    expect(videoRow.className).toContain("is-hidden");
    expect(videoRow.className).toContain("is-locked");
    expect(videoRow.getAttribute("data-track-hidden")).toBe("true");
    expect(captionRow.className).not.toContain("is-hidden");
    expect(captionRow.getAttribute("data-track-hidden")).toBe("false");
    expect(selectedClipContainer.className).toContain("is-hidden");
    expect(selectedClipContainer.className).toContain("is-locked");
    expect(selectedClipContainer.className).toContain("is-selected");
    expect(selectedClipContainer.getAttribute("data-track-hidden")).toBe("true");
    expect(selectedClip.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(videoVisibility);
    fireEvent.click(captionVisibility);

    expect(onSetTrackHidden).toHaveBeenNthCalledWith(1, id(10), false);
    expect(onSetTrackHidden).toHaveBeenNthCalledWith(2, id(12), true);
    expect(selectedClip.getAttribute("aria-pressed")).toBe("true");
    expect(onSelectClip).not.toHaveBeenCalled();

    const shownProjection = projectionFixture({
      name: "Visibility interaction timeline",
      videoClipCount: 1,
      audioClipCount: 1,
    });
    const shownVideoTrack = shownProjection.state.sequences[0]!.tracks[0]!;
    const hiddenCaptionTrack = shownProjection.state.sequences[0]!.tracks[2]!;
    if (shownVideoTrack.kind !== "video") throw new Error("Expected a video track");
    if (hiddenCaptionTrack.kind !== "caption") throw new Error("Expected a caption track");
    shownVideoTrack.locked = true;
    shownVideoTrack.hidden = false;
    hiddenCaptionTrack.hidden = true;
    rendered.rerender(<MultitrackTimeline {...props} projection={shownProjection} />);

    expect(screen.getByRole("button", { name: "Camera video output" })).toBe(videoVisibility);
    expect(videoVisibility.querySelector(".lucide-eye")).toBeTruthy();
    expect(videoVisibility.getAttribute("aria-pressed")).toBe("true");
    expect(videoVisibility.getAttribute("title")).toBe("Hide track output");
    expect(videoVisibility.textContent).toContain("Hide");
    expect(videoLabel.className).not.toContain("is-hidden");
    expect(videoLabel.getAttribute("data-track-hidden")).toBe("false");
    expect(videoRow.className).not.toContain("is-hidden");
    expect(videoRow.className).toContain("is-locked");
    expect(videoRow.getAttribute("data-track-hidden")).toBe("false");
    expect(selectedClipContainer.className).not.toContain("is-hidden");
    expect(selectedClipContainer.className).toContain("is-locked");
    expect(selectedClipContainer.className).toContain("is-selected");
    expect(selectedClipContainer.getAttribute("data-track-hidden")).toBe("false");
    expect(screen.getByRole("button", { name: "Captions caption output" })).toBe(captionVisibility);
    expect(captionVisibility.querySelector(".lucide-eye-off")).toBeTruthy();
    expect(captionVisibility.getAttribute("aria-pressed")).toBe("false");
    expect(captionVisibility.getAttribute("title")).toBe("Show track output");
    expect(captionVisibility.textContent).toContain("Show");
  });

  it("keeps hidden unlocked visual clips selectable and trimmable", () => {
    const projection = projectionFixture({
      name: "Hidden editable timeline",
      videoClipCount: 1,
      audioClipCount: 1,
    });
    const videoTrack = projection.state.sequences[0]!.tracks[0]!;
    if (videoTrack.kind !== "video") throw new Error("Expected a video track");
    videoTrack.hidden = true;
    videoTrack.locked = false;
    const selectedClipId = id(100_000);
    const onSelectClip = vi.fn();

    render(<MultitrackTimeline {...timelineProps({ projection, selectedClipId, onSelectClip })} />);

    const selectedClip = screen.getByRole("button", {
      name: /camera-a\.mp4, frames 0 through 2.*end exclusive$/,
    });
    const selectedClipContainer = selectedClip.parentElement!;
    expect(selectedClipContainer.className).toContain("is-hidden");
    expect(selectedClipContainer.className).toContain("is-selected");
    expect(selectedClipContainer.className).not.toContain("is-locked");
    expect(screen.getByRole("button", { name: "Trim start of camera-a.mp4" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("button", { name: "Trim end of camera-a.mp4" })).toHaveProperty(
      "disabled",
      false,
    );

    fireEvent.click(selectedClip);
    expect(onSelectClip).toHaveBeenCalledOnce();
    expect(onSelectClip).toHaveBeenCalledWith(selectedClipId);
  });

  it("disables visibility toggles only while a timeline edit is pending", () => {
    const onSetTrackHidden = vi.fn();
    const props = timelineProps({
      editError: new Error("Previous edit failed"),
      onSetTrackHidden,
    });
    const rendered = render(<MultitrackTimeline {...props} />);
    const visibilityToggles = screen.getAllByRole("button", {
      name: /(?:video|caption) output$/,
    });

    expect(visibilityToggles).toHaveLength(2);
    expect(visibilityToggles.every((toggle) => !(toggle as HTMLButtonElement).disabled)).toBe(true);

    rendered.rerender(<MultitrackTimeline {...props} editPending />);
    expect(visibilityToggles.every((toggle) => (toggle as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(visibilityToggles[0]!);
    expect(onSetTrackHidden).not.toHaveBeenCalled();

    rendered.rerender(<MultitrackTimeline {...props} editPending={false} />);
    expect(visibilityToggles.every((toggle) => !(toggle as HTMLButtonElement).disabled)).toBe(true);
  });

  it("exposes mute toggles only for AV tracks without changing clip selection", () => {
    const projection = projectionFixture({
      name: "Mute interaction timeline",
      videoClipCount: 1,
      audioClipCount: 1,
    });
    const videoTrack = projection.state.sequences[0]!.tracks[0]!;
    if (videoTrack.kind !== "video") throw new Error("Expected a video track");
    videoTrack.locked = true;
    videoTrack.muted = true;
    const selectedClipId = id(100_000);
    const onSelectClip = vi.fn();
    const onSetTrackMuted = vi.fn();

    const rendered = render(
      <MultitrackTimeline
        {...timelineProps({ projection, selectedClipId, onSelectClip, onSetTrackMuted })}
      />,
    );

    const videoMute = screen.getByRole("button", { name: "Camera track unmute" });
    const audioMute = screen.getByRole("button", { name: "Nested audio track mute" });
    const selectedClip = screen.getByRole("button", {
      name: /camera-a\.mp4, frames 0 through 2.*locked track/,
    });

    expect(videoMute.getAttribute("aria-pressed")).toBe("true");
    expect(videoMute.textContent).toContain("Unmute");
    expect((videoMute as HTMLButtonElement).disabled).toBe(false);
    expect(audioMute.getAttribute("aria-pressed")).toBe("false");
    expect(audioMute.textContent).toContain("Mute");
    expect(screen.queryByRole("button", { name: /Captions track (?:unmute|mute)/ })).toBeNull();
    expect(
      screen.getByRole("listitem", { name: /Camera, video track.*locked, muted/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("listitem", { name: /Nested audio, audio track.*editable, audible/ }),
    ).toBeTruthy();
    expect(
      rendered.container
        .querySelector(`[data-track-id='${id(10)}']`)
        ?.getAttribute("data-track-muted"),
    ).toBe("true");
    expect(
      rendered.container
        .querySelector(`[data-track-id='${id(11)}']`)
        ?.getAttribute("data-track-muted"),
    ).toBe("false");
    expect(
      rendered.container
        .querySelector(`[data-track-id='${id(12)}']`)
        ?.hasAttribute("data-track-muted"),
    ).toBe(false);

    fireEvent.click(videoMute);
    fireEvent.click(audioMute);

    expect(onSetTrackMuted).toHaveBeenNthCalledWith(1, id(10), false);
    expect(onSetTrackMuted).toHaveBeenNthCalledWith(2, id(11), true);
    expect(selectedClip.getAttribute("aria-pressed")).toBe("true");
    expect(onSelectClip).not.toHaveBeenCalled();
  });

  it("disables mute toggles only while a timeline edit is pending", () => {
    const props = timelineProps({ editError: new Error("Previous edit failed") });
    const rendered = render(<MultitrackTimeline {...props} />);
    const muteToggles = screen.getAllByRole("button", { name: /track mute$/ });

    expect(muteToggles).toHaveLength(2);
    expect(muteToggles.every((toggle) => !(toggle as HTMLButtonElement).disabled)).toBe(true);

    rendered.rerender(<MultitrackTimeline {...props} editPending={true} />);
    expect(muteToggles.every((toggle) => (toggle as HTMLButtonElement).disabled)).toBe(true);

    rendered.rerender(<MultitrackTimeline {...props} editPending={false} />);
    expect(muteToggles.every((toggle) => !(toggle as HTMLButtonElement).disabled)).toBe(true);
  });

  it("toggles semantic lock state while selection and other tracks stay interactive", () => {
    const projection = projectionFixture({
      name: "Lock interaction timeline",
      videoClipCount: 1,
      audioClipCount: 1,
    });
    const lockedTrack = projection.state.sequences[0]!.tracks[0]!;
    lockedTrack.locked = true;
    const lockedClipId = id(100_000);
    const unaffectedClipId = id(200_000);
    const onSelectClip = vi.fn();
    const onSetTrackLocked = vi.fn();
    const onSplitClip = vi.fn();
    const onRippleDeleteClip = vi.fn();
    const onMoveClip = vi.fn();
    const onTrimClip = vi.fn();
    const props = timelineProps({
      projection,
      selectedClipId: lockedClipId,
      onSelectClip,
      onSetTrackLocked,
      onSplitClip,
      onRippleDeleteClip,
      onMoveClip,
      onTrimClip,
    });
    const rendered = render(<MultitrackTimeline {...props} />);

    const lockToggle = screen.getByRole("button", { name: "Camera track lock" });
    expect(lockToggle.getAttribute("aria-pressed")).toBe("true");
    expect(lockToggle.textContent).toContain("Unlock");
    expect(screen.getByRole("listitem", { name: /Camera, video track.*locked/ })).toBeTruthy();
    fireEvent.click(lockToggle);
    expect(onSetTrackLocked).toHaveBeenCalledWith(id(10), false);

    const lockedClip = screen.getByRole("button", {
      name: /camera-a\.mp4, frames 0 through 2.*locked track/,
    });
    fireEvent.click(lockedClip);
    expect(onSelectClip).toHaveBeenCalledWith(lockedClipId);
    expect(lockedClip.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Split at playhead" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Ripple delete clip" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(lockedClip, { code: "KeyS" });
    fireEvent.keyDown(lockedClip, { code: "Delete", shiftKey: true });
    fireEvent.keyDown(lockedClip, { code: "ArrowLeft", altKey: true });
    fireEvent.keyDown(lockedClip, { code: "ArrowRight", altKey: true });
    fireEvent.pointerDown(lockedClip, { button: 0, pointerId: 31, clientX: 8 });
    fireEvent.pointerMove(lockedClip, { pointerId: 31, clientX: 24 });
    fireEvent.pointerUp(lockedClip, { pointerId: 31, clientX: 24 });
    expect(onSplitClip).not.toHaveBeenCalled();
    expect(onRippleDeleteClip).not.toHaveBeenCalled();
    expect(onMoveClip).not.toHaveBeenCalled();
    const trimStart = screen.getByRole("button", { name: "Trim start of camera-a.mp4" });
    expect((trimStart as HTMLButtonElement).disabled).toBe(true);
    fireEvent.pointerDown(trimStart, { button: 0, pointerId: 32, clientX: 8 });
    fireEvent.pointerMove(trimStart, { pointerId: 32, clientX: 16 });
    fireEvent.pointerUp(trimStart, { pointerId: 32, clientX: 16 });
    expect(onTrimClip).not.toHaveBeenCalled();

    rendered.rerender(<MultitrackTimeline {...props} selectedClipId={unaffectedClipId} />);
    const unaffectedClip = screen.getByRole("button", {
      name: /Nested interview, frames 0 through 2/,
    });
    fireEvent.pointerDown(unaffectedClip, { button: 0, pointerId: 33, clientX: 8 });
    fireEvent.pointerMove(unaffectedClip, { pointerId: 33, clientX: 28 });
    fireEvent.pointerUp(unaffectedClip, { pointerId: 33, clientX: 28 });
    expect(onMoveClip).toHaveBeenCalledWith(unaffectedClipId, 50);
    expect(
      screen.getByRole("button", { name: "Nested audio track lock" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("moves the selected clip by exact frames through scoped keyboard commands", () => {
    const projection = interactionProjection();
    const track = projection.state.sequences[0]!.tracks[0]!;
    if (track.kind === "caption") throw new Error("Expected a video track");
    track.clips[0]!.timelineStart = timeAtRate(5, rate);
    const clipId = id(100_000);
    const onMoveClip = vi.fn();
    render(
      <MultitrackTimeline
        {...timelineProps({
          projection,
          selectedClipId: clipId,
          timelinePlayheadFrame: 6,
          onMoveClip,
        })}
      />,
    );
    const selectedClip = screen.getByRole("button", {
      name: /camera-a\.mp4, frames 5 through 7/,
    });

    expect(selectedClip.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowLeft Alt+ArrowRight");
    expect(fireEvent.keyDown(selectedClip, { code: "ArrowRight", altKey: true })).toBe(false);
    expect(onMoveClip).toHaveBeenLastCalledWith(clipId, 6);
    expect(fireEvent.keyDown(selectedClip, { code: "ArrowLeft", altKey: true })).toBe(false);
    expect(onMoveClip).toHaveBeenLastCalledWith(clipId, 4);
    expect(fireEvent.keyDown(selectedClip, { code: "ArrowRight" })).toBe(true);
    expect(
      fireEvent.keyDown(selectedClip, { code: "ArrowRight", altKey: true, repeat: true }),
    ).toBe(true);
    expect(onMoveClip).toHaveBeenCalledTimes(2);
  });

  it("previews moves ephemerally, commits once on release, and cancels without committing", () => {
    const firstId = id(100_000);
    const onMoveClip = vi.fn();
    const props = timelineProps({ selectedClipId: firstId, onMoveClip });
    const rendered = render(<MultitrackTimeline {...props} />);
    const body = screen.getByRole("button", { name: /camera-a\.mp4, frames 0 through 2/ });
    const element = rendered.container.querySelector<HTMLElement>(`[data-clip-id='${firstId}']`)!;

    fireEvent.pointerDown(body, { button: 0, pointerId: 7, clientX: 10 });
    fireEvent.pointerMove(body, { pointerId: 7, clientX: 30 });
    expect(element.dataset.startFrame).toBe("50");
    expect(onMoveClip).not.toHaveBeenCalled();
    fireEvent.pointerUp(body, { pointerId: 7, clientX: 30 });
    expect(onMoveClip).toHaveBeenCalledOnce();
    expect(onMoveClip).toHaveBeenCalledWith(firstId, 50);
    expect(element.dataset.startFrame).toBe("0");

    fireEvent.pointerDown(body, { button: 0, pointerId: 8, clientX: 10 });
    fireEvent.pointerMove(body, { pointerId: 8, clientX: 50 });
    expect(element.dataset.startFrame).toBe("100");
    fireEvent.pointerCancel(body, { pointerId: 8 });
    expect(onMoveClip).toHaveBeenCalledOnce();
    expect(element.dataset.startFrame).toBe("0");
    expect(materializedClipIds(rendered.container).length).toBeLessThan(1_000);
  });

  it("snaps a mixed-rate trailing edge and emits a sequence-frame move start", () => {
    const projection = projectionFixture({
      name: "Clip edge snap timeline",
      videoClipCount: 2,
      audioClipCount: 0,
    });
    const firstId = id(100_000);
    const videoTrack = projection.state.sequences[0]!.tracks[0]!;
    if (videoTrack.kind === "caption") throw new Error("Expected a video track");
    videoTrack.clips[0]!.sourceIn = sourceTime(10);
    videoTrack.clips[0]!.sourceOut = sourceTime(14);
    videoTrack.clips[1]!.timelineStart = time(40);
    const onMoveClip = vi.fn();
    const rendered = render(
      <MultitrackTimeline
        {...timelineProps({
          projection,
          selectedClipId: firstId,
          timelinePlayheadFrame: null,
          onMoveClip,
        })}
      />,
    );
    const body = screen.getByRole("button", { name: /camera-a\.mp4, frames 0 through 2/ });
    const element = rendered.container.querySelector<HTMLElement>(`[data-clip-id='${firstId}']`)!;

    fireEvent.pointerDown(body, { button: 0, pointerId: 41, clientX: 10 });
    fireEvent.pointerMove(body, { pointerId: 41, clientX: 24 });

    expect(element.dataset.startFrame).toBe("38");
    expect(element.dataset.endFrameExclusive).toBe("40");
    expect(onMoveClip).not.toHaveBeenCalled();
    const guides = rendered.container.querySelectorAll<HTMLElement>(".multitrack-snap-guide");
    expect(guides).toHaveLength(1);
    expect(guides[0]!.dataset.snapFrame).toBe("40");
    expect(guides[0]!.dataset.snapTargetKind).toBe("clip-start");
    expect(guides[0]!.dataset.movingEdge).toBe("end");

    fireEvent.pointerUp(body, { pointerId: 41, clientX: 24 });

    expect(onMoveClip).toHaveBeenCalledOnce();
    expect(onMoveClip).toHaveBeenCalledWith(firstId, 38);
    expect(element.dataset.startFrame).toBe("0");
    expect(rendered.container.querySelector(".multitrack-snap-guide")).toBeNull();
  });

  it("disables frame-delta trim handles for mixed-rate clips", () => {
    const projection = interactionProjection();
    const firstId = id(100_000);
    const videoTrack = projection.state.sequences[0]!.tracks[0]!;
    if (videoTrack.kind === "caption") throw new Error("Expected a video track");
    videoTrack.clips[0]!.sourceIn = sourceTime(0);
    videoTrack.clips[0]!.sourceOut = sourceTime(4);
    const onTrimClip = vi.fn();

    render(
      <MultitrackTimeline
        {...timelineProps({ projection, selectedClipId: firstId, onTrimClip })}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Trim start of camera-a.mp4" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Trim end of camera-a.mp4" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(onTrimClip).not.toHaveBeenCalled();
  });

  it("previews a playhead snap ephemerally and clears its guide on cancel", () => {
    const firstId = id(100_000);
    const onMoveClip = vi.fn();
    const rendered = render(
      <MultitrackTimeline
        {...timelineProps({ selectedClipId: firstId, timelinePlayheadFrame: 1, onMoveClip })}
      />,
    );
    const body = screen.getByRole("button", { name: /camera-a\.mp4, frames 0 through 2/ });
    const element = rendered.container.querySelector<HTMLElement>(`[data-clip-id='${firstId}']`)!;

    fireEvent.pointerDown(body, { button: 0, pointerId: 42, clientX: 10 });
    fireEvent.pointerMove(body, { pointerId: 42, clientX: 14 });

    expect(element.dataset.startFrame).toBe("1");
    expect(element.dataset.endFrameExclusive).toBe("3");
    const guide = rendered.container.querySelector<HTMLElement>(".multitrack-snap-guide");
    expect(guide?.dataset.snapFrame).toBe("1");
    expect(guide?.dataset.snapTargetKind).toBe("playhead");
    expect(guide?.dataset.movingEdge).toBe("start");
    expect(onMoveClip).not.toHaveBeenCalled();

    fireEvent.pointerMove(body, { pointerId: 42, clientX: 50 });

    expect(element.dataset.startFrame).toBe("100");
    expect(rendered.container.querySelector(".multitrack-snap-guide")).toBeNull();
    expect(onMoveClip).not.toHaveBeenCalled();

    fireEvent.pointerCancel(body, { pointerId: 42 });

    expect(onMoveClip).not.toHaveBeenCalled();
    expect(element.dataset.startFrame).toBe("0");
    expect(rendered.container.querySelector(".multitrack-snap-guide")).toBeNull();
  });

  it("clamps a move before frame zero and commits the clamped start", () => {
    const projection = interactionProjection();
    const firstId = id(100_000);
    const firstTrack = projection.state.sequences[0]!.tracks[0]!;
    if (firstTrack.kind === "caption") throw new Error("Expected a video track");
    firstTrack.clips[0]!.timelineStart = time(4);
    const onMoveClip = vi.fn();
    const rendered = render(
      <MultitrackTimeline
        {...timelineProps({
          projection,
          selectedClipId: firstId,
          timelinePlayheadFrame: null,
          onMoveClip,
        })}
      />,
    );
    const body = screen.getByRole("button", { name: /camera-a\.mp4, frames 4 through 6/ });
    const element = rendered.container.querySelector<HTMLElement>(`[data-clip-id='${firstId}']`)!;

    fireEvent.pointerDown(body, { button: 0, pointerId: 11, clientX: 20 });
    fireEvent.pointerMove(body, { pointerId: 11, clientX: -20 });
    expect(element.dataset.startFrame).toBe("0");
    expect(element.dataset.endFrameExclusive).toBe("2");
    fireEvent.pointerUp(body, { pointerId: 11, clientX: -20 });

    expect(onMoveClip).toHaveBeenCalledOnce();
    expect(onMoveClip).toHaveBeenCalledWith(firstId, 0);
  });

  it("rejects an inexact retimed drag visibly and commits one exact source-range edit", () => {
    const firstId = id(100_000);
    const onTrimClip = vi.fn();
    const props = timelineProps({ selectedClipId: firstId, onTrimClip });
    const track = props.projection.state.sequences[0]!.tracks[0]!;
    if (track.kind === "caption") throw new Error("Expected video track");
    track.clips[0]!.speed = { numerator: 3, denominator: 2 };
    track.clips[0]!.sourceOut.value = 30;
    render(<MultitrackTimeline {...props} />);
    const right = screen.getByRole("button", { name: "Trim end of camera-a.mp4" });
    // The viewport uses 4 pixels per second: at 10 fps, one frame is 0.4 pixels.
    fireEvent.pointerDown(right, { button: 0, pointerId: 70, clientX: 8 });
    fireEvent.pointerMove(right, { pointerId: 70, clientX: 8.4 });
    fireEvent.pointerUp(right, { pointerId: 70, clientX: 8.4 });
    expect(onTrimClip).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("inexact frame boundary");
    fireEvent.pointerDown(right, { button: 0, pointerId: 71, clientX: 8 });
    fireEvent.pointerMove(right, { pointerId: 71, clientX: 8.8 });
    fireEvent.pointerUp(right, { pointerId: 71, clientX: 8.8 });
    expect(onTrimClip).toHaveBeenCalledOnce();
    expect(onTrimClip).toHaveBeenCalledWith(firstId, 0, 33, 0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("previews both trim handles and emits one canonical trim on release", () => {
    const firstId = id(100_000);
    const onTrimClip = vi.fn();
    const rendered = render(
      <MultitrackTimeline {...timelineProps({ selectedClipId: firstId, onTrimClip })} />,
    );
    const element = rendered.container.querySelector<HTMLElement>(`[data-clip-id='${firstId}']`)!;
    const right = screen.getByRole("button", { name: "Trim end of camera-a.mp4" });

    fireEvent.pointerDown(right, { button: 0, pointerId: 9, clientX: 8 });
    fireEvent.pointerMove(right, { pointerId: 9, clientX: 16 });
    expect(element.dataset.endFrameExclusive).toBe("22");
    expect(onTrimClip).not.toHaveBeenCalled();
    fireEvent.pointerUp(right, { pointerId: 9, clientX: 16 });
    expect(onTrimClip).toHaveBeenCalledOnce();
    expect(onTrimClip).toHaveBeenCalledWith(firstId, 0, 22, 0);

    const left = screen.getByRole("button", { name: "Trim start of camera-a.mp4" });
    fireEvent.pointerDown(left, { button: 0, pointerId: 10, clientX: 0 });
    fireEvent.pointerMove(left, { pointerId: 10, clientX: 4 });
    expect(element.dataset.startFrame).toBe("1");
    fireEvent.pointerCancel(left, { pointerId: 10 });
    expect(onTrimClip).toHaveBeenCalledOnce();
    expect(element.dataset.startFrame).toBe("0");
  });

  it("clamps an inward trim to the one-frame minimum before committing", () => {
    const firstId = id(100_000);
    const onTrimClip = vi.fn();
    const rendered = render(
      <MultitrackTimeline {...timelineProps({ selectedClipId: firstId, onTrimClip })} />,
    );
    const element = rendered.container.querySelector<HTMLElement>(`[data-clip-id='${firstId}']`)!;
    const right = screen.getByRole("button", { name: "Trim end of camera-a.mp4" });

    fireEvent.pointerDown(right, { button: 0, pointerId: 12, clientX: 20 });
    fireEvent.pointerMove(right, { pointerId: 12, clientX: -20 });
    expect(element.dataset.startFrame).toBe("0");
    expect(element.dataset.endFrameExclusive).toBe("1");
    fireEvent.pointerUp(right, { pointerId: 12, clientX: -20 });

    expect(onTrimClip).toHaveBeenCalledOnce();
    expect(onTrimClip).toHaveBeenCalledWith(firstId, 0, 1, 0);
  });
});
