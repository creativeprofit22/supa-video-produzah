// @vitest-environment jsdom

import {
  createRationalTime,
  VideoDomainError,
  type MediaProbe,
  type OpenedVideoProject,
  type PreparedVideoAsset,
  type VideoProjectFileV1,
} from "@supa-video/contracts";
import { createProject, currentRevision, executeCommand } from "@supa-video/project";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVideoProject } from "./use-video-project";
import type { VideoBackend, VideoRenderNotification } from "./video-ipc";

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
  proxyPath: "C:\\Neutral\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Neutral\\Cache\\thumbnail.jpg",
  proxyProbe: {
    ...sourceProbe,
    width: 540,
    height: 720,
    fileSizeBytes: 5_000_000,
  },
};

const projectPath = "C:\\Neutral\\Projects\\fixture.svpvideo";
const sourcePath = "C:\\Neutral\\Media\\clip.mp4";
const exportPath = "C:\\Neutral\\Exports\\clip-export.mp4";
const renderJobId = "20000000-0000-4000-8000-000000000001";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buildClipProject(name = "Fixture"): Readonly<VideoProjectFileV1> {
  const timestamp = "2026-07-25T12:00:00.000Z";
  const project = createProject({
    projectId: "10000000-0000-4000-8000-000000000001",
    initialRevisionId: "10000000-0000-4000-8000-000000000002",
    name,
    createdAt: timestamp,
  });
  const withAsset = executeCommand(project, {
    type: "ImportAsset",
    commandId: "10000000-0000-4000-8000-000000000003",
    baseRevisionId: project.currentRevisionId,
    issuedAt: "2026-07-25T12:00:01.000Z",
    asset: {
      id: "10000000-0000-4000-8000-000000000004",
      displayName: "clip.mp4",
      locator: { absolutePath: sourcePath },
      probe: sourceProbe,
    },
  });
  const withSequence = executeCommand(withAsset, {
    type: "CreateSequence",
    commandId: "10000000-0000-4000-8000-000000000005",
    baseRevisionId: withAsset.currentRevisionId,
    issuedAt: "2026-07-25T12:00:02.000Z",
    sequence: {
      id: "10000000-0000-4000-8000-000000000006",
      rate: sourceProbe.averageFrameRate,
      width: preparedAsset.proxyProbe.width,
      height: preparedAsset.proxyProbe.height,
      audioSampleRate: 48_000,
      videoTracks: [
        {
          id: "10000000-0000-4000-8000-000000000007",
          clips: [],
        },
      ],
    },
  });
  return executeCommand(withSequence, {
    type: "InsertClip",
    commandId: "10000000-0000-4000-8000-000000000008",
    baseRevisionId: withSequence.currentRevisionId,
    issuedAt: "2026-07-25T12:00:03.000Z",
    sequenceId: "10000000-0000-4000-8000-000000000006",
    trackId: "10000000-0000-4000-8000-000000000007",
    clip: {
      id: "10000000-0000-4000-8000-000000000009",
      assetId: "10000000-0000-4000-8000-000000000004",
      timelineStart: createRationalTime(0, sourceProbe.averageFrameRate),
      sourceIn: createRationalTime(0, sourceProbe.averageFrameRate),
      sourceOut: createRationalTime(100, sourceProbe.averageFrameRate),
    },
  });
}

function openedProject(
  document: Readonly<VideoProjectFileV1>,
  status: "resolved" | "missing" | "relink_required" = "resolved",
  path = projectPath,
): OpenedVideoProject {
  const asset = currentRevision(document).state.asset;
  if (asset === null) {
    return { path, document, sources: [] };
  }
  return {
    path,
    document,
    sources: [
      {
        assetId: asset.id,
        status,
        resolvedPath: status === "resolved" ? sourcePath : null,
      },
    ],
  } as OpenedVideoProject;
}

function makeBackend(): VideoBackend {
  return {
    getVideoToolStatus: vi.fn(async () => ({
      ffmpeg: { available: true, version: "ffmpeg version 7.1" },
      ffprobe: { available: true, version: "ffprobe version 7.1" },
      ready: true,
    })),
    pickNewVideoProjectPath: vi.fn(async () => projectPath),
    openVideoProject: vi.fn(async () => null),
    saveVideoProject: vi.fn(async () => undefined),
    pickVideoSource: vi.fn(async () => sourcePath),
    probeVideoSource: vi.fn(async () => sourceProbe),
    prepareVideoAsset: vi.fn(async () => preparedAsset),
    pickVideoExportPath: vi.fn(async () => exportPath),
    startVideoRender: vi.fn(async (plan) => ({
      jobId: renderJobId,
      planId: plan.planId,
      revisionId: plan.revisionId,
    })),
    cancelVideoRender: vi.fn(async () => undefined),
    listenVideoRenderEvents: vi.fn(async () => vi.fn()),
    convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  };
}

async function createActiveProject(
  result: ReturnType<typeof renderHook<ReturnType<typeof useVideoProject>, unknown>>["result"],
): Promise<void> {
  await act(async () => {
    await result.current.newProject();
  });
}

async function createPreparedProject(
  result: ReturnType<typeof renderHook<ReturnType<typeof useVideoProject>, unknown>>["result"],
): Promise<void> {
  await createActiveProject(result);
  await act(async () => {
    await result.current.prepareImportedSource(sourcePath, sourceProbe);
  });
}

afterEach(cleanup);

describe("useVideoProject persistence controller", () => {
  let backend: VideoBackend;

  beforeEach(() => {
    backend = makeBackend();
  });

  it("starts without an unsaved project and treats new-project cancellation as a no-op", async () => {
    vi.mocked(backend.pickNewVideoProjectPath).mockResolvedValueOnce(null);
    const { result } = renderHook(() => useVideoProject(backend));

    await act(async () => {
      await result.current.newProject();
    });

    expect(result.current.project).toBeNull();
    expect(result.current.projectPath).toBeNull();
    expect(result.current.projectOperation).toEqual({ phase: "idle" });
    expect(backend.saveVideoProject).not.toHaveBeenCalled();
  });

  it("saves a new empty project before making it active", async () => {
    const save = deferred<void>();
    vi.mocked(backend.saveVideoProject).mockReturnValueOnce(save.promise);
    const { result } = renderHook(() => useVideoProject(backend));
    let completion!: Promise<void>;

    act(() => {
      completion = result.current.newProject();
    });
    await act(async () => Promise.resolve());
    expect(result.current.project).toBeNull();
    expect(result.current.projectOperation).toMatchObject({ phase: "pending", operation: "new" });
    expect(backend.saveVideoProject).toHaveBeenCalledWith(projectPath, expect.any(Object));

    save.resolve();
    await act(async () => completion);
    expect(result.current.projectPath).toBe(projectPath);
    expect(result.current.project?.revisions).toHaveLength(1);
  });

  it("preserves no active project when the initial save fails", async () => {
    vi.mocked(backend.saveVideoProject).mockRejectedValueOnce(new Error("disk unavailable"));
    const { result } = renderHook(() => useVideoProject(backend));

    await act(async () => {
      await result.current.newProject();
    });

    expect(result.current.project).toBeNull();
    expect(result.current.projectPath).toBeNull();
    expect(result.current.projectOperation).toMatchObject({ phase: "error", operation: "new" });
  });

  it("runs picker, probe, preparation, and final save in order before import activation", async () => {
    const calls: string[] = [];
    const { result } = renderHook(() => useVideoProject(backend));
    await createActiveProject(result);
    vi.mocked(backend.pickVideoSource).mockImplementationOnce(async () => {
      calls.push("pick");
      return sourcePath;
    });
    vi.mocked(backend.probeVideoSource).mockImplementationOnce(async () => {
      calls.push("probe");
      return sourceProbe;
    });
    vi.mocked(backend.prepareVideoAsset).mockImplementationOnce(async () => {
      calls.push("prepare");
      return preparedAsset;
    });
    vi.mocked(backend.saveVideoProject).mockImplementationOnce(async () => {
      calls.push("save");
    });

    await act(async () => {
      await result.current.chooseSource();
    });

    expect(calls).toEqual(["pick", "probe", "prepare", "save"]);
    expect(
      result.current.project && currentRevision(result.current.project).state.sequence,
    ).toMatchObject({
      width: 540,
      height: 720,
    });
    expect(result.current.source).toMatchObject({ status: "resolved", resolvedPath: sourcePath });
    expect(result.current.preparation).toMatchObject({ phase: "success", value: preparedAsset });
  });

  it.each(["resolved", "missing", "relink_required"] as const)(
    "opens a %s source state and only prepares resolved media",
    async (status) => {
      const document = buildClipProject();
      vi.mocked(backend.openVideoProject).mockResolvedValueOnce(openedProject(document, status));
      const { result } = renderHook(() => useVideoProject(backend));

      await act(async () => {
        await result.current.openProject();
      });

      expect(result.current.projectPath).toBe(projectPath);
      expect(result.current.project?.currentRevisionId).toBe(document.currentRevisionId);
      expect(result.current.source?.status).toBe(status);
      expect(result.current.history?.cursor).toBe(document.revisions.length - 1);
      if (status === "resolved") {
        expect(backend.prepareVideoAsset).toHaveBeenCalledTimes(1);
        expect(result.current.preparation.phase).toBe("success");
      } else {
        expect(backend.prepareVideoAsset).not.toHaveBeenCalled();
        expect(result.current.sourcePath).toBeNull();
      }
    },
  );

  it("preserves the exact active history when open data or import saving fails", async () => {
    const { result } = renderHook(() => useVideoProject(backend));
    await createActiveProject(result);
    const originalHistory = result.current.history;
    const originalRevisionId = result.current.project?.currentRevisionId;

    vi.mocked(backend.openVideoProject).mockResolvedValueOnce({
      ...openedProject(buildClipProject()),
      sources: [{ assetId: "not-a-uuid", status: "missing", resolvedPath: null }],
    } as unknown as OpenedVideoProject);
    await act(async () => {
      await result.current.openProject();
    });
    expect(result.current.history).toBe(originalHistory);
    expect(result.current.project?.currentRevisionId).toBe(originalRevisionId);

    vi.mocked(backend.saveVideoProject).mockRejectedValueOnce(new Error("save failed"));
    await act(async () => {
      await result.current.prepareImportedSource(sourcePath, sourceProbe);
    });
    expect(result.current.history).toBe(originalHistory);
    expect(result.current.project?.currentRevisionId).toBe(originalRevisionId);
    expect(result.current.preparedAsset).toBeNull();
  });

  it("rejects stale open and preparation completions after a newer project switch", async () => {
    const oldOpen = deferred<OpenedVideoProject | null>();
    const oldPreparation = deferred<PreparedVideoAsset>();
    const oldDocument = buildClipProject("Old");
    const newDocument = buildClipProject("New");
    vi.mocked(backend.openVideoProject)
      .mockReturnValueOnce(oldOpen.promise)
      .mockResolvedValueOnce(
        openedProject(newDocument, "missing", "C:\\Neutral\\Projects\\new.svpvideo"),
      );
    vi.mocked(backend.prepareVideoAsset).mockReturnValueOnce(oldPreparation.promise);
    const { result } = renderHook(() => useVideoProject(backend));
    let oldCompletion!: Promise<void>;

    act(() => {
      oldCompletion = result.current.openProject();
    });
    await act(async () => Promise.resolve());
    await act(async () => {
      await result.current.openProject();
    });
    oldOpen.resolve(openedProject(oldDocument));
    await act(async () => oldCompletion);
    expect(result.current.project?.name).toBe("New");
    expect(result.current.source?.status).toBe("missing");

    vi.mocked(backend.openVideoProject)
      .mockResolvedValueOnce(openedProject(oldDocument))
      .mockResolvedValueOnce(
        openedProject(newDocument, "missing", "C:\\Neutral\\Projects\\newer.svpvideo"),
      );
    let preparationCompletion!: Promise<void>;
    act(() => {
      preparationCompletion = result.current.openProject();
    });
    await act(async () => Promise.resolve());
    await act(async () => {
      await result.current.openProject();
    });
    oldPreparation.resolve(preparedAsset);
    await act(async () => preparationCompletion);
    expect(result.current.project?.name).toBe("New");
    expect(result.current.preparedAsset).toBeNull();
  });

  it("reconstructs history at the opened current revision", async () => {
    const fullDocument = buildClipProject();
    const earlierDocument = {
      ...fullDocument,
      currentRevisionId: fullDocument.revisions[2]!.id,
    };
    vi.mocked(backend.openVideoProject).mockResolvedValueOnce(openedProject(earlierDocument));
    const { result } = renderHook(() => useVideoProject(backend));

    await act(async () => {
      await result.current.openProject();
    });

    expect(result.current.history?.cursor).toBe(2);
    expect(result.current.history?.document.revisions).toHaveLength(4);
  });

  it("keeps trim drafts ephemeral and commits exactly one saved TrimClip revision", async () => {
    const { result } = renderHook(() => useVideoProject(backend));
    await createPreparedProject(result);
    const committedRevision = result.current.project?.currentRevisionId;
    const revisionCount = result.current.project?.revisions.length;
    vi.mocked(backend.saveVideoProject).mockClear();

    act(() => {
      result.current.updateTrimDraft({ inFrame: 10, outFrame: 90 });
    });
    expect(result.current.project?.currentRevisionId).toBe(committedRevision);
    expect(result.current.trimChanged).toBe(true);

    await act(async () => {
      await result.current.applyTrim();
    });
    expect(backend.saveVideoProject).toHaveBeenCalledTimes(1);
    expect(result.current.project?.revisions).toHaveLength((revisionCount ?? 0) + 1);
    expect(result.current.committedTrim).toEqual({ inFrame: 10, outFrame: 90 });
    expect(result.current.trimChanged).toBe(false);
  });

  it("blocks invalid and unchanged trims and preserves canonical state on save failure", async () => {
    const { result } = renderHook(() => useVideoProject(backend));
    await createPreparedProject(result);
    const committedRevision = result.current.project?.currentRevisionId;
    vi.mocked(backend.saveVideoProject).mockClear();

    act(() => result.current.updateTrimDraft({ inFrame: 100, outFrame: 100 }));
    expect(result.current.trimValid).toBe(false);
    await act(async () => result.current.applyTrim());
    expect(backend.saveVideoProject).not.toHaveBeenCalled();

    act(() => result.current.updateTrimDraft({ inFrame: 10, outFrame: 90 }));
    vi.mocked(backend.saveVideoProject).mockRejectedValueOnce(new Error("save failed"));
    await act(async () => result.current.applyTrim());
    expect(result.current.project?.currentRevisionId).toBe(committedRevision);
    expect(result.current.trimDraft).toEqual({ inFrame: 10, outFrame: 90 });
    expect(result.current.editOperation).toMatchObject({ phase: "error", operation: "trim" });
  });

  it("persists bounded undo and redo and truncates redo after a new trim", async () => {
    const { result } = renderHook(() => useVideoProject(backend));
    await createPreparedProject(result);
    act(() => result.current.updateTrimDraft({ inFrame: 10, outFrame: 90 }));
    await act(async () => result.current.applyTrim());
    expect(result.current.canUndo).toBe(true);

    await act(async () => result.current.undoEdit());
    expect(result.current.committedTrim).toEqual({ inFrame: 0, outFrame: 100 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    await act(async () => result.current.redoEdit());
    expect(result.current.committedTrim).toEqual({ inFrame: 10, outFrame: 90 });
    await act(async () => result.current.undoEdit());
    act(() => result.current.updateTrimDraft({ inFrame: 20, outFrame: 80 }));
    await act(async () => result.current.applyTrim());
    expect(result.current.committedTrim).toEqual({ inFrame: 20, outFrame: 80 });
    expect(result.current.canRedo).toBe(false);
    expect(backend.saveVideoProject).toHaveBeenCalledTimes(7);
  });
});

describe("useVideoProject render regression", () => {
  let backend: VideoBackend;
  let renderEventHandler: ((event: VideoRenderNotification) => void) | undefined;
  let unlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    backend = makeBackend();
    renderEventHandler = undefined;
    unlisten = vi.fn();
    vi.mocked(backend.listenVideoRenderEvents).mockImplementation(async (handler) => {
      renderEventHandler = handler;
      return unlisten as () => void;
    });
  });

  it("subscribes before start and accepts only monotonic matching progress", async () => {
    const calls: string[] = [];
    vi.mocked(backend.listenVideoRenderEvents).mockImplementation(async (handler) => {
      calls.push("listen");
      renderEventHandler = handler;
      return unlisten as () => void;
    });
    vi.mocked(backend.startVideoRender).mockImplementation(async (plan) => {
      calls.push("start");
      return { jobId: renderJobId, planId: plan.planId, revisionId: plan.revisionId };
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await createPreparedProject(result);

    await act(async () => {
      await result.current.exportVideo();
    });
    const running = result.current.render;
    if (running.phase !== "running" || renderEventHandler === undefined) {
      throw new Error("Expected a running render");
    }
    expect(calls).toEqual(["listen", "start"]);

    act(() => {
      renderEventHandler?.({
        type: "progress",
        ...running,
        completedMicroseconds: 3_000_000,
        durationMicroseconds: 4_000_000,
      });
      renderEventHandler?.({
        type: "progress",
        ...running,
        completedMicroseconds: 2_000_000,
        durationMicroseconds: 4_000_000,
      });
      renderEventHandler?.({
        type: "progress",
        ...running,
        jobId: "20000000-0000-4000-8000-000000000099",
        completedMicroseconds: 4_000_000,
        durationMicroseconds: 4_000_000,
      });
    });
    expect(result.current.render).toMatchObject({ phase: "running", progress: 75 });
  });

  it("settles cancellation, completion, failure, and preview-warning terminal events", async () => {
    const { result } = renderHook(() => useVideoProject(backend));
    await createPreparedProject(result);
    await act(async () => {
      await result.current.exportVideo();
    });
    let running = result.current.render;
    if (running.phase !== "running" || renderEventHandler === undefined) {
      throw new Error("Expected a running render");
    }
    const cancelledIdentity = {
      jobId: running.jobId,
      planId: running.planId,
      revisionId: running.revisionId,
    };
    await act(async () => {
      await result.current.cancelRender();
    });
    expect(backend.cancelVideoRender).toHaveBeenCalledWith(renderJobId);
    act(() => {
      renderEventHandler?.({ type: "cancelled", ...cancelledIdentity });
    });
    expect(result.current.render.phase).toBe("cancelled");

    for (const terminal of ["completed", "failed", "warning"] as const) {
      unlisten = vi.fn();
      vi.mocked(backend.listenVideoRenderEvents).mockImplementationOnce(async (handler) => {
        renderEventHandler = handler;
        return unlisten as () => void;
      });
      await act(async () => {
        await result.current.exportVideo();
      });
      running = result.current.render;
      if (running.phase !== "running" || renderEventHandler === undefined) {
        throw new Error("Expected another running render");
      }
      const terminalIdentity = {
        jobId: running.jobId,
        planId: running.planId,
        revisionId: running.revisionId,
      };
      act(() => {
        if (terminal === "completed") {
          renderEventHandler?.({
            type: "completed",
            ...terminalIdentity,
            output: {
              outputPath: exportPath,
              previewPath: "C:\\Neutral\\Cache\\render-preview.mp4",
              probe: sourceProbe,
            },
          });
        } else {
          renderEventHandler?.({
            type: "failed",
            ...terminalIdentity,
            error:
              terminal === "warning"
                ? new VideoDomainError("project_io", "Preview unavailable", { outputExists: true })
                : new VideoDomainError("process_failed", "Render failed"),
          });
        }
      });
      expect(result.current.render.phase).toBe(
        terminal === "warning" ? "completed_with_warning" : terminal,
      );
    }
  });

  it("reuses one immutable plan for asynchronous and synchronous collision retries", async () => {
    const { result } = renderHook(() => useVideoProject(backend));
    await createPreparedProject(result);
    await act(async () => {
      await result.current.exportVideo();
    });
    const running = result.current.render;
    const firstPlan = vi.mocked(backend.startVideoRender).mock.calls[0]?.[0];
    if (
      running.phase !== "running" ||
      renderEventHandler === undefined ||
      firstPlan === undefined
    ) {
      throw new Error("Expected a running render and captured plan");
    }
    act(() => {
      renderEventHandler?.({
        type: "failed",
        jobId: running.jobId,
        planId: running.planId,
        revisionId: running.revisionId,
        error: new VideoDomainError("output_exists", "Destination exists"),
      });
    });
    await act(async () => {
      await result.current.confirmOverwrite();
    });
    expect(backend.startVideoRender).toHaveBeenNthCalledWith(2, firstPlan, true);
    const overwriteRunning = result.current.render;
    if (overwriteRunning.phase !== "running" || renderEventHandler === undefined) {
      throw new Error("Expected the overwrite render to run");
    }
    act(() => {
      renderEventHandler?.({
        type: "completed",
        jobId: overwriteRunning.jobId,
        planId: overwriteRunning.planId,
        revisionId: overwriteRunning.revisionId,
        output: {
          outputPath: exportPath,
          previewPath: "C:\\Neutral\\Cache\\render-preview.mp4",
          probe: sourceProbe,
        },
      });
    });

    vi.mocked(backend.startVideoRender)
      .mockRejectedValueOnce(new VideoDomainError("output_exists", "Destination exists"))
      .mockImplementationOnce(async (plan) => ({
        jobId: renderJobId,
        planId: plan.planId,
        revisionId: plan.revisionId,
      }));
    await act(async () => {
      await result.current.exportVideo();
    });
    const synchronousPlan = vi.mocked(backend.startVideoRender).mock.calls[2]?.[0];
    expect(result.current.render).toMatchObject({ phase: "failed", canOverwrite: true });
    await act(async () => {
      await result.current.confirmOverwrite();
    });
    expect(backend.startVideoRender).toHaveBeenNthCalledWith(4, synchronousPlan, true);
  });

  it("cancels and disposes an active render on project switch and unmount", async () => {
    const { result, unmount } = renderHook(() => useVideoProject(backend));
    await createPreparedProject(result);
    await act(async () => {
      await result.current.exportVideo();
    });
    vi.mocked(backend.openVideoProject).mockResolvedValueOnce(
      openedProject(
        buildClipProject("Switched"),
        "missing",
        "C:\\Neutral\\Projects\\switched.svpvideo",
      ),
    );
    await act(async () => {
      await result.current.openProject();
    });
    expect(backend.cancelVideoRender).toHaveBeenCalledWith(renderJobId);
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(result.current.render.phase).toBe("idle");

    await act(async () => {
      await result.current.openProject();
    });
    unmount();
  });
});
