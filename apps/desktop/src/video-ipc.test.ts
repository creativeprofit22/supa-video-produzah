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
  cancelVideoRender,
  closeVideoProject,
  createVideoProject,
  executeVideoProjectGroup,
  getVideoProjectInspector,
  listenVideoRenderEvents,
  openVideoProject,
  redoVideoProject,
  relinkVideoProjectAsset,
  startVideoRender,
  tauriVideoBackend,
  undoVideoProject,
  VideoIpcResponseError,
} from "./video-ipc";

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

  it("keeps render start, event, and cancellation strict", async () => {
    const started = { jobId: id(30), planId: renderPlan.planId, revisionId: renderPlan.revisionId };
    invokeMock.mockResolvedValueOnce(started).mockResolvedValueOnce(null);
    await expect(startVideoRender(renderPlan, false)).resolves.toEqual(started);
    await expect(cancelVideoRender(started.jobId)).resolves.toBeUndefined();
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

  it("exposes the canonical backend and no arbitrary save command", () => {
    expect(tauriVideoBackend).toMatchObject({
      createVideoProject,
      openVideoProject,
      executeVideoProjectGroup,
      undoVideoProject,
      redoVideoProject,
      closeVideoProject,
    });
    expect(tauriVideoBackend).not.toHaveProperty("saveVideoProject");
    expect(convertFileSrc("C:\\Cache\\proxy.mp4")).toBe("asset:C:\\Cache\\proxy.mp4");
  });
});
