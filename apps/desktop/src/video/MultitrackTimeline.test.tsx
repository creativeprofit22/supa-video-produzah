// @vitest-environment jsdom
import type { ProjectClip, ProjectProjection } from "@supa-video/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testPrepared, testProbe, testSourceIdentity } from "../test-video-service";
import { MultitrackTimeline } from "./MultitrackTimeline";

const rate = { numerator: 10, denominator: 1 } as const;
const id = (value: number): string =>
  `30000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const time = (value: number) => ({
  value,
  rateNumerator: rate.numerator,
  rateDenominator: rate.denominator,
});
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

function largeProjection(): ProjectProjection {
  const assetId = id(1);
  const nestedSequenceId = id(3);
  const videoClips = Array.from({ length: 5_000 }, (_, index) =>
    clip(100_000 + index, index * 4, { kind: "asset", assetId }),
  );
  const audioClips = Array.from({ length: 5_000 }, (_, index) =>
    clip(200_000 + index, index * 4, { kind: "sequence", sequenceId: nestedSequenceId }),
  );
  return {
    projectId: id(900_001),
    name: "Large timeline",
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

function preparedClipIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLImageElement>("[data-clip-id] img")).map(
    (image) => image.closest<HTMLElement>("[data-clip-id]")!.dataset.clipId!,
  );
}

describe("MultitrackTimeline", () => {
  it("bounds semantic DOM and thumbnail construction to viewport overscan while scrolling", async () => {
    const projection = largeProjection();
    const convertCachePath = vi.fn((path: string) => `asset:${path}`);
    const rendered = render(
      <MultitrackTimeline
        projection={projection}
        preparedAsset={testPrepared}
        convertCachePath={convertCachePath}
      />,
    );

    const region = screen.getByRole("region", { name: "Timeline tracks; scroll horizontally" });
    expect(region.tabIndex).toBe(0);
    await waitFor(() => expect(screen.getByLabelText("36 visible clips")).toBeTruthy());

    const trackRows = screen
      .getAllByRole("listitem")
      .filter((item) => item.hasAttribute("data-track-id") && !item.hasAttribute("data-clip-id"));
    expect(trackRows.map((row) => row.dataset.trackKind)).toEqual(["video", "audio", "caption"]);
    expect(trackRows.map((row) => row.dataset.trackId)).toEqual([id(10), id(11), id(12)]);

    const initialIds = materializedClipIds(rendered.container);
    const initialPreparedIds = preparedClipIds(rendered.container);
    expect(initialIds).toHaveLength(36);
    expect(initialPreparedIds).toHaveLength(18);
    expect(convertCachePath).toHaveBeenCalledTimes(initialPreparedIds.length);
    expect(rendered.container.querySelectorAll(".multitrack-clip-fallback")).toHaveLength(18);
    expect(
      rendered.container.querySelector("[data-start-frame='0'][data-end-frame-exclusive='2']"),
    ).toBeTruthy();
    expect(screen.getByLabelText(/camera-a\.mp4, frames 0 through 2, end exclusive/)).toBeTruthy();
    expect(rendered.container.querySelector(".multitrack-panel button")).toBeNull();

    rendered.rerender(
      <MultitrackTimeline
        projection={projection}
        preparedAsset={testPrepared}
        convertCachePath={convertCachePath}
      />,
    );
    expect(convertCachePath).toHaveBeenCalledTimes(initialPreparedIds.length);

    fireEvent.scroll(region, { target: { scrollLeft: 400 } });
    await waitFor(() => expect(materializedClipIds(rendered.container)).toHaveLength(50));
    const scrolledIds = materializedClipIds(rendered.container);
    const scrolledPreparedIds = preparedClipIds(rendered.container);
    const newlyPrepared = scrolledPreparedIds.filter(
      (clipId) => !initialPreparedIds.includes(clipId),
    );

    expect(
      Array.from(rendered.container.querySelectorAll<HTMLElement>("[data-clip-id]")).every(
        (clipElement) =>
          Number(clipElement.dataset.endFrameExclusive) > 20 &&
          Number(clipElement.dataset.startFrame) < 120,
      ),
    ).toBe(true);
    expect(scrolledPreparedIds.some((clipId) => initialPreparedIds.includes(clipId))).toBe(true);
    expect(convertCachePath).toHaveBeenCalledTimes(
      initialPreparedIds.length + newlyPrepared.length,
    );
    expect(scrolledIds).not.toContain(id(100_000));
    expect(scrolledIds).not.toContain(id(200_000));
    expect(screen.getByText("Showing 50 of 10000 clips")).toBeTruthy();
  });
});
