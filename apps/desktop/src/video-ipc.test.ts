import type {
  CommandGroupRequest,
  CommandResult,
  ProjectProjection,
  RenderPlanV1,
} from "@supa-video/contracts";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelMediaJob,
  cancelVideoRender,
  clearLegacyMediaCache,
  closeVideoProject,
  createVideoProject,
  executeVideoProjectGroup,
  getMediaCacheStatus,
  getMediaJobEvents,
  getVideoProjectInspector,
  listenMediaJobEvents,
  listenVideoRenderEvents,
  listMediaJobs,
  openVideoProject,
  redoVideoProject,
  relinkVideoProjectAsset,
  retryMediaJob,
  startVideoRender,
  tauriVideoBackend,
  undoVideoProject,
  VideoIpcResponseError,
} from "./video-ipc";
import { testMediaCacheStatus, testMediaJob } from "./test-video-service";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const hash = "a".repeat(64);
const projection: ProjectProjection = {
  projectId: id(1),
  name: "IPC V2",
  revision: {
    number: 0,
    id: id(2),
    parentId: null,
    committedAt: "2026-07-26T12:00:00Z",
    operationId: id(3),
    stateHash: hash,
  },
  state: { assets: [], sequences: [], activeSequenceId: null },
  canUndo: false,
  canRedo: false,
  lastCommand: null,
  sources: [],
  journalHealth: "healthy",
  snapshotRevision: 0,
  recoveryStatus: "clean",
  replayedRecordCount: 0,
};
const request: CommandGroupRequest = {
  groupId: id(4),
  projectId: id(1),
  baseRevision: 0,
  commands: [{ type: "RemoveMarker", commandId: id(5), sequenceId: id(6), markerId: id(7) }],
};
const legacyImportRequest: CommandGroupRequest = {
  groupId: id(40),
  projectId: id(1),
  baseRevision: 0,
  commands: [
    {
      type: "ImportAsset",
      commandId: id(41),
      asset: {
        id: id(42),
        displayName: "legacy.mp4",
        locator: { absolutePath: "C:\\Media\\legacy.mp4" },
        probe: {
          durationMicroseconds: 1_000_000,
          averageFrameRate: { numerator: 30, denominator: 1 },
          realFrameRate: { numerator: 30, denominator: 1 },
          variableFrameRate: false,
          width: 640,
          height: 360,
          videoCodecName: "h264",
          audio: null,
          fileSizeBytes: 1_000,
        },
      },
    },
  ],
};
const nextProjection: ProjectProjection = {
  ...projection,
  revision: {
    ...projection.revision,
    number: 1,
    id: id(8),
    parentId: projection.revision.id,
    operationId: request.groupId,
  },
};
const commandResult: CommandResult = {
  projectId: id(1),
  operationId: id(4),
  groupId: id(4),
  priorRevision: projection.revision,
  newRevision: nextProjection.revision,
  stateHash: hash,
  projection: nextProjection,
  affectedRanges: [],
  cacheInvalidations: [],
  events: [],
};
const renderPlan: RenderPlanV1 = {
  schemaVersion: 1,
  planId: id(20),
  revisionId: id(8),
  executable: "ffmpeg",
  inputPath: "C:\\Media\\clip.mp4",
  outputPath: "C:\\Exports\\clip.mp4",
  expected: {
    durationFrames: 30,
    rate: { numerator: 30, denominator: 1 },
    width: 320,
    height: 180,
    audio: false,
  },
  argv: ["-i", "C:\\Media\\clip.mp4", "C:\\Exports\\clip.mp4"],
};

describe("strict V2 video IPC adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it("creates and opens strict projections", async () => {
    const opened = {
      projection,
      recovery: {
        status: "clean",
        recoveredRevision: 0,
        replayedRecordCount: 0,
        discardedTailBytes: 0,
        message: "Clean journal",
        legacyHistoryReset: false,
      },
    } as const;
    invokeMock.mockResolvedValueOnce(projection).mockResolvedValueOnce(opened);
    await expect(createVideoProject("C:\\Projects\\test.svpvideo", "IPC V2")).resolves.toEqual(
      projection,
    );
    expect(invokeMock).toHaveBeenNthCalledWith(1, "video_create_project", {
      path: "C:\\Projects\\test.svpvideo",
      name: "IPC V2",
    });
    await expect(openVideoProject()).resolves.toEqual(opened);
  });

  it("validates execute, undo, redo, inspector, and close identities", async () => {
    invokeMock
      .mockResolvedValueOnce(commandResult)
      .mockResolvedValueOnce(commandResult)
      .mockResolvedValueOnce(commandResult)
      .mockResolvedValueOnce({
        projectId: id(1),
        revision: projection.revision,
        lastCommand: null,
        snapshotRevision: 0,
        journalHealth: "healthy",
        replayedRecordCount: 0,
        recoveryStatus: "clean",
      })
      .mockResolvedValueOnce(null);
    await expect(executeVideoProjectGroup(request)).resolves.toEqual(commandResult);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "video_execute_project_group", { request });
    await undoVideoProject(id(1), 0, id(9));
    await redoVideoProject(id(1), 1, id(10));
    expect(invokeMock).toHaveBeenNthCalledWith(2, "video_undo_project", {
      projectId: id(1),
      baseRevision: 0,
      operationId: id(9),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "video_redo_project", {
      projectId: id(1),
      baseRevision: 1,
      operationId: id(10),
    });
    await getVideoProjectInspector(id(1));
    invokeMock.mockResolvedValueOnce(null);
    await expect(relinkVideoProjectAsset(id(1), id(11))).resolves.toBeNull();
    await expect(closeVideoProject(id(1))).resolves.toBeUndefined();
  });

  it("rejects a live import without content identity before IPC", async () => {
    await expect(executeVideoProjectGroup(legacyImportRequest)).rejects.toThrow(
      "Live asset imports require a content identity",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects malformed native authority data without exposing it", async () => {
    invokeMock.mockResolvedValueOnce({ ...projection, journalPath: "C:\\private\\journal.ndjson" });
    const error = await createVideoProject("C:\\Projects\\test.svpvideo", "IPC V2").catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(VideoIpcResponseError);
    expect(String(error)).not.toContain("private");
  });

  it("normalizes canonical project errors", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "project_in_use",
      message: "Project is already open",
      details: { operation: "project_service" },
    });
    await expect(openVideoProject()).rejects.toMatchObject({ code: "project_in_use" });
  });

  it("keeps render start and events strict", async () => {
    const started = { jobId: id(30), planId: renderPlan.planId, revisionId: renderPlan.revisionId };
    invokeMock.mockResolvedValueOnce(started);
    await expect(startVideoRender(renderPlan, false)).resolves.toEqual(started);
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);
    const handler = vi.fn();
    const dispose = await listenVideoRenderEvents(handler);
    listenMock.mock.calls[0]![1]({
      event: "video:render-event",
      id: 1,
      payload: { type: "started", ...started },
    });
    expect(handler).toHaveBeenCalledWith({ type: "started", ...started });
    dispose();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("preserves render cancellation compatibility for unknown, wrong-owner, terminal, and active jobs", async () => {
    const unknownJobError = {
      code: "invalid_render_plan",
      message: "The render plan is invalid",
      details: { operation: "validate_render_plan", category: "unknown_job" },
    };
    invokeMock
      .mockRejectedValueOnce(unknownJobError)
      .mockRejectedValueOnce(unknownJobError)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(cancelVideoRender("unknown-job")).rejects.toMatchObject({
      code: "invalid_render_plan",
      details: { category: "unknown_job" },
    });
    await expect(cancelVideoRender("wrong-owner-job")).rejects.toMatchObject({
      code: "invalid_render_plan",
      details: { category: "unknown_job" },
    });
    await expect(cancelVideoRender("terminal-job")).resolves.toBeUndefined();
    await expect(cancelVideoRender("active-job")).resolves.toBeUndefined();

    expect(invokeMock.mock.calls).toEqual([
      ["video_cancel_render", { jobId: "unknown-job" }],
      ["video_cancel_render", { jobId: "wrong-owner-job" }],
      ["video_cancel_render", { jobId: "terminal-job" }],
      ["video_cancel_render", { jobId: "active-job" }],
    ]);
  });
  it("validates media job requests and responses under the native request argument", async () => {
    const event = {
      schemaVersion: 1,
      eventId: 1,
      jobId: testMediaJob.id,
      eventType: "created",
      state: testMediaJob.state,
      stage: testMediaJob.stage,
      progress: testMediaJob.progress,
      message: null,
      category: null,
      createdAt: testMediaJob.createdAt,
    } as const;
    invokeMock
      .mockResolvedValueOnce({
        schemaVersion: 1,
        jobs: [testMediaJob],
        unsettledParentCount: 1,
        nextBeforeUpdatedAt: null,
        nextBeforeJobId: null,
        latestEventId: 1,
        recovery: null,
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        events: [event],
        latestEventId: 1,
        hasMore: false,
      })
      .mockResolvedValueOnce({ schemaVersion: 1, job: testMediaJob })
      .mockResolvedValueOnce({ schemaVersion: 1, job: testMediaJob });

    await expect(listMediaJobs()).resolves.toMatchObject({
      jobs: [testMediaJob],
      unsettledParentCount: 1,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "video_list_media_jobs", {
      request: {
        limit: 100,
        includeSettled: true,
        projectId: null,
        beforeUpdatedAt: null,
        beforeJobId: null,
      },
    });
    await expect(getMediaJobEvents()).resolves.toMatchObject({ events: [event] });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "video_get_media_job_events", {
      request: { jobId: null, afterEventId: 0, limit: 500 },
    });
    await cancelMediaJob({ jobId: testMediaJob.id });
    await retryMediaJob({ jobId: testMediaJob.id });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "video_cancel_media_job", {
      request: { jobId: testMediaJob.id },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "video_retry_media_job", {
      request: { jobId: testMediaJob.id },
    });
  });

  it("keeps cache status, legacy clearing, and media job events strict", async () => {
    const clearedStatus = {
      ...testMediaCacheStatus,
      legacyBytes: 0,
      legacyEntryCount: 0,
      legacyUnsafeEntryCount: 0,
      legacyClearAvailable: false,
    };
    invokeMock.mockResolvedValueOnce(testMediaCacheStatus).mockResolvedValueOnce({
      schemaVersion: 1,
      clearedBytes: testMediaCacheStatus.legacyBytes,
      clearedEntryCount: 1,
      skippedUnsafeEntryCount: 0,
      status: clearedStatus,
    });
    await expect(getMediaCacheStatus()).resolves.toEqual(testMediaCacheStatus);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "video_get_media_cache_status", undefined);
    await expect(clearLegacyMediaCache({ confirmed: true })).resolves.toMatchObject({
      status: clearedStatus,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "video_clear_legacy_media_cache", {
      request: { confirmed: true },
    });

    const unlisten = vi.fn();
    const handler = vi.fn();
    const onError = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);
    const dispose = await listenMediaJobEvents(handler, onError);
    const listener = listenMock.mock.calls[0]![1];
    listener({
      event: "video:media-job-event",
      id: 1,
      payload: {
        schemaVersion: 1,
        eventId: 2,
        jobId: testMediaJob.id,
        eventType: "progress",
        state: "running",
        stage: "proxy",
        progress: { completed: 1, total: 2, unit: "stages" },
        message: null,
        category: null,
        createdAt: testMediaJob.createdAt,
      },
    });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventId: 2 }));
    listener({
      event: "video:media-job-event",
      id: 2,
      payload: { eventId: 3, privatePayload: "C:\\private\\source.mp4" },
    });
    expect(onError).toHaveBeenCalledWith(expect.any(VideoIpcResponseError));
    expect(String(onError.mock.calls[0]![0])).not.toContain("private");
    dispose();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("rejects an unsafe unsettled-parent count from native authority", async () => {
    invokeMock.mockResolvedValueOnce({
      schemaVersion: 1,
      jobs: [],
      unsettledParentCount: Number.MAX_SAFE_INTEGER + 1,
      nextBeforeUpdatedAt: null,
      nextBeforeJobId: null,
      latestEventId: 0,
      recovery: null,
    });

    const error = await listMediaJobs().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(VideoIpcResponseError);
  });

  it("rejects malformed media authority responses without exposing native fields", async () => {
    invokeMock.mockResolvedValueOnce({
      schemaVersion: 1,
      jobs: [{ ...testMediaJob, privatePayload: { sourcePath: "C:\\private\\clip.mp4" } }],
      unsettledParentCount: 1,
      nextBeforeUpdatedAt: null,
      nextBeforeJobId: null,
      latestEventId: 1,
      recovery: null,
    });
    const error = await listMediaJobs().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(VideoIpcResponseError);
    expect(String(error)).not.toContain("private");
  });

  it("exposes the canonical backend and no arbitrary save command", () => {
    expect(tauriVideoBackend).toMatchObject({
      createVideoProject,
      openVideoProject,
      executeVideoProjectGroup,
      undoVideoProject,
      redoVideoProject,
      closeVideoProject,
      listMediaJobs,
      getMediaJobEvents,
      cancelMediaJob,
      retryMediaJob,
      getMediaCacheStatus,
      clearLegacyMediaCache,
      listenMediaJobEvents,
    });
    expect(tauriVideoBackend).not.toHaveProperty("saveVideoProject");
    expect(convertFileSrc("C:\\Cache\\proxy.mp4")).toBe("asset:C:\\Cache\\proxy.mp4");
  });
});
