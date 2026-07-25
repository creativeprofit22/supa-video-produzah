// @vitest-environment jsdom

import type { MediaProbe, PreparedVideoAsset } from "@supa-video/contracts";
import { currentRevision } from "@supa-video/project";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVideoProject } from "./use-video-project";
import { prepareVideoAsset } from "./video-ipc";

vi.mock("./video-ipc", () => ({
  prepareVideoAsset: vi.fn(),
}));

const prepareVideoAssetMock = vi.mocked(prepareVideoAsset);

const sourceProbe: MediaProbe = {
  durationMicroseconds: 4_000_000,
  averageFrameRate: { numerator: 25, denominator: 1 },
  realFrameRate: { numerator: 25, denominator: 1 },
  variableFrameRate: false,
  width: 720,
  height: 576,
  videoCodecName: "h264",
  audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
  fileSizeBytes: 12_000_000,
};

const preparedAsset: PreparedVideoAsset = {
  proxyPath: "C:\\Private\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Private\\Cache\\thumbnail.jpg",
  proxyProbe: {
    ...sourceProbe,
    width: 540,
    height: 720,
    fileSizeBytes: 5_000_000,
  },
};

afterEach(cleanup);

describe("useVideoProject", () => {
  beforeEach(() => {
    prepareVideoAssetMock.mockReset();
  });

  it("creates the sequence from display-correct prepared dimensions", async () => {
    prepareVideoAssetMock.mockResolvedValueOnce(preparedAsset);
    const { result } = renderHook(() => useVideoProject());

    await act(async () => {
      await result.current.prepareImportedSource(
        "C:\\Private\\rotated-anamorphic.mp4",
        sourceProbe,
      );
    });

    const projectState = currentRevision(result.current.project).state;
    expect(projectState.sequence).toMatchObject({
      rate: sourceProbe.averageFrameRate,
      width: 540,
      height: 720,
    });
    expect(result.current.preparation).toMatchObject({ phase: "success", value: preparedAsset });
    expect(prepareVideoAssetMock).toHaveBeenCalledWith({
      projectId: result.current.project.id,
      assetId: projectState.asset?.id,
      path: "C:\\Private\\rotated-anamorphic.mp4",
      sequenceRate: sourceProbe.averageFrameRate,
    });
  });
});
