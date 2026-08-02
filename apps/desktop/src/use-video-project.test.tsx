// @vitest-environment jsdom

import type { CommandGroupRequest, CommandResult, ProjectProjection } from "@supa-video/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useVideoProject } from "./use-video-project";
import type { VideoBackend, VideoRenderNotification } from "./video-ipc";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const timestamp = "2026-07-26T12:00:00.000Z";
const hash = "a".repeat(64);
const probe = {
  durationMicroseconds: 2_000_000,
  averageFrameRate: { numerator: 30, denominator: 1 },
  realFrameRate: { numerator: 30, denominator: 1 },
  variableFrameRate: false,
  width: 320,
  height: 180,
  videoCodecName: "h264",
  audio: null,
  fileSizeBytes: 1000,
} as const;
const sourceIdentity = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: probe.fileSizeBytes,
} as const;
const profileIdentity = {
  schemaVersion: 1,
  profileId: "preview-v1",
  profileDigest: "34".repeat(32),
} as const;
const identityBase = {
  schemaVersion: 1,
  sourceIdentity,
  toolchainId: "ffmpeg-test-v1",
  profileIdentity,
  recipeDigest: "56".repeat(32),
} as const;
const prepared = {
  sourceFingerprint: {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: "78".repeat(32),
    byteLength: probe.fileSizeBytes,
    modifiedUnixSeconds: 1_720_000_000,
    modifiedNanoseconds: 42,
  },
  sourceIdentity,
  sourceProbe: probe,
  sequenceRate: probe.averageFrameRate,
  profileIdentity,
  proxyIdentity: { ...identityBase, artifactKind: "proxy", key: "9a".repeat(32) },
  proxyPath: "C:\\Cache\\proxy.mp4",
  proxyProbe: probe,
  thumbnailIdentity: {
    ...identityBase,
    artifactKind: "thumbnail_tile",
    key: "bc".repeat(32),
  },
  thumbnailPath: "C:\\Cache\\thumb.jpg",
} as const;

function emptyProjection(revision = 0): ProjectProjection {
  return {
    projectId: id(1),
    name: "Canonical project",
    revision: {
      number: revision,
      id: id(100 + revision),
      parentId: revision === 0 ? null : id(99 + revision),
      committedAt: timestamp,
      operationId: id(200 + revision),
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
}

function clipProjection(revision = 1, sourceIn = 0, sourceOut = 60): ProjectProjection {
  return {
    ...emptyProjection(revision),
    canUndo: true,
    state: {
      assets: [
        {
          id: id(2),
          displayName: "clip.mp4",
          locator: { absolutePath: "C:\\Media\\clip.mp4" },
          probe,
          contentIdentity: sourceIdentity,
        },
      ],
      sequences: [
        {
          id: id(3),
          name: "Sequence 1",
          rate: probe.averageFrameRate,
          width: 320,
          height: 180,
          audioSampleRate: 48_000,
          markers: [],
          tracks: [
            {
              id: id(4),
              name: "Video 1",
              kind: "video",
              clips: [
                {
                  id: id(5),
                  source: { kind: "asset", assetId: id(2) },
                  timelineStart: { value: 0, rateNumerator: 30, rateDenominator: 1 },
                  sourceIn: { value: sourceIn, rateNumerator: 30, rateDenominator: 1 },
                  sourceOut: { value: sourceOut, rateNumerator: 30, rateDenominator: 1 },
                  transform: {
                    positionXPermille: 0,
                    positionYPermille: 0,
                    scaleXPermille: 1000,
                    scaleYPermille: 1000,
                    rotationMilliDegrees: 0,
                    opacityPermille: 1000,
                  },
                  gainMilliDecibels: 0,
                },
              ],
            },
          ],
        },
      ],
      activeSequenceId: id(3),
    },
    sources: [{ assetId: id(2), status: "resolved", resolvedPath: "C:\\Media\\clip.mp4" }],
  };
}

function commandResult(
  prior: ProjectProjection,
  next: ProjectProjection,
  operationId: string,
  groupId = operationId,
): CommandResult {
  return {
    projectId: next.projectId,
    operationId,
    groupId,
    priorRevision: prior.revision,
    newRevision: next.revision,
    stateHash: next.revision.stateHash,
    projection: next,
    affectedRanges: [],
    cacheInvalidations: [],
    events: [],
  };
}

function withCheckpointWarning(
  result: CommandResult,
  source: "event" | "projection",
): CommandResult {
  return {
    ...result,
    projection:
      source === "projection"
        ? { ...result.projection, journalHealth: "snapshot_pending" }
        : result.projection,
    events:
      source === "event"
        ? [{ type: "snapshot_warning", message: "Periodic snapshot checkpoint failed" }]
        : [],
  };
}

function createBackend(overrides: Partial<VideoBackend> = {}): VideoBackend {
  return {
    getVideoToolStatus: vi.fn(async () => ({
      source: "bundled" as const,
      toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
      ffmpeg: { available: true, version: "8.1.2" },
      ffprobe: { available: true, version: "8.1.2" },
      ready: true,
    })),
    pickNewVideoProjectPath: vi.fn(async () => "C:\\Projects\\canonical.svpvideo"),
    createVideoProject: vi.fn(async () => emptyProjection()),
    openVideoProject: vi.fn(async () => null),
    executeVideoProjectGroup: vi.fn(async () => {
      throw new Error("unexpected execute");
    }),
    undoVideoProject: vi.fn(async () => {
      throw new Error("unexpected undo");
    }),
    redoVideoProject: vi.fn(async () => {
      throw new Error("unexpected redo");
    }),
    getVideoProjectInspector: vi.fn(async () => {
      throw new Error("unexpected inspector");
    }),
    closeVideoProject: vi.fn(async () => undefined),
    relinkVideoProjectAsset: vi.fn(async () => null),
    pickVideoSource: vi.fn(async () => null),
    probeVideoSource: vi.fn(async () => probe),
    prepareVideoAsset: vi.fn(async () => prepared),
    pickVideoExportPath: vi.fn(async () => null),
    startVideoRender: vi.fn(async () => ({ jobId: id(90), planId: id(91), revisionId: id(92) })),
    cancelVideoRender: vi.fn(async () => undefined),
    listenVideoRenderEvents: vi.fn(async () => () => undefined),
    listMediaJobs: vi.fn(async () => ({
      schemaVersion: 1 as const,
      jobs: [],
      unsettledParentCount: 0,
      nextBeforeUpdatedAt: null,
      nextBeforeJobId: null,
      latestEventId: 0,
      recovery: null,
    })),
    getMediaJobEvents: vi.fn(async () => ({
      schemaVersion: 1 as const,
      events: [],
      latestEventId: 0,
      hasMore: false,
    })),
    cancelMediaJob: vi.fn(async () => {
      throw new Error("unexpected media job cancellation");
    }),
    retryMediaJob: vi.fn(async () => {
      throw new Error("unexpected media job retry");
    }),
    getMediaCacheStatus: vi.fn(async () => ({
      schemaVersion: 1 as const,
      budgetBytes: 1_000_000,
      managedBytes: 0,
      leasedBytes: 0,
      reclaimableBytes: 0,
      artifactCount: 0,
      leasedArtifactCount: 0,
      pressure: "normal" as const,
      legacyBytes: 0,
      legacyEntryCount: 0,
      legacyUnsafeEntryCount: 0,
      legacyClearAvailable: false,
      recoveryWarning: null,
      refreshedAt: timestamp,
    })),
    clearLegacyMediaCache: vi.fn(async () => {
      throw new Error("unexpected legacy cache clear");
    }),
    listenMediaJobEvents: vi.fn(async () => () => undefined),
    convertFileSrc: vi.fn((path: string) => `asset:${path}`),
    ...overrides,
  };
}

describe("canonical project controller", () => {
  it("creates through Rust and never saves arbitrary project JSON", async () => {
    const backend = createBackend();
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.newProject());
    expect(backend.createVideoProject).toHaveBeenCalledWith(
      "C:\\Projects\\canonical.svpvideo",
      "canonical",
    );
    expect(result.current.projection?.revision.number).toBe(0);
  });

  it("consumes snapshot warning events from grouped import command results", async () => {
    const empty = emptyProjection();
    const imported = clipProjection(1);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      const commandResultValue = withCheckpointWarning(
        commandResult(empty, imported, request.groupId),
        "event",
      );
      const importedAsset = request.commands.find((command) => command.type === "ImportAsset");
      const createdSequence = request.commands.find((command) => command.type === "CreateSequence");
      const insertedClip = request.commands.find((command) => command.type === "InsertClip");
      if (
        importedAsset?.type === "ImportAsset" &&
        createdSequence?.type === "CreateSequence" &&
        insertedClip?.type === "InsertClip"
      ) {
        commandResultValue.projection.state.assets = [importedAsset.asset];
        const sequence = structuredClone(createdSequence.sequence);
        const track = sequence.tracks.find((item) => item.id === insertedClip.trackId);
        if (track !== undefined && track.kind !== "caption") track.clips.push(insertedClip.clip);
        commandResultValue.projection.state.sequences = [sequence];
        commandResultValue.projection.state.activeSequenceId = sequence.id;
        commandResultValue.projection.sources = [
          {
            assetId: importedAsset.asset.id,
            status: "resolved",
            resolvedPath: importedAsset.asset.locator.absolutePath ?? "C:\\Media\\clip.mp4",
          },
        ];
      }
      return commandResultValue;
    });
    const backend = createBackend({
      createVideoProject: vi.fn(async () => empty),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.newProject());
    await act(() => result.current.prepareImportedSource("C:\\Media\\clip.mp4"));
    const request = execute.mock.calls[0]![0];
    expect(request.commands.map((command) => command.type)).toEqual([
      "ImportAsset",
      "CreateSequence",
      "InsertClip",
    ]);
    expect(request).not.toHaveProperty("committedAt");
    expect(result.current.projection?.revision.number).toBe(1);
    expect(result.current.preparedAsset).toEqual(prepared);
    expect(result.current.checkpointWarning).toEqual({
      type: "snapshot_pending",
      revision: 1,
    });
  });

  it("derives first-import timing from the canonical prepared source", async () => {
    const empty = emptyProjection();
    const preliminaryProbe = {
      ...probe,
      averageFrameRate: { numerator: 24, denominator: 1 },
      realFrameRate: { numerator: 24, denominator: 1 },
    } as const;
    const canonicalRate = { numerator: 60, denominator: 1 } as const;
    const canonicalProbe = {
      ...probe,
      durationMicroseconds: 2_500_000,
      averageFrameRate: canonicalRate,
      realFrameRate: canonicalRate,
    } as const;
    const canonicalPrepared = {
      ...prepared,
      sourceProbe: canonicalProbe,
      sequenceRate: canonicalRate,
      proxyProbe: {
        ...prepared.proxyProbe,
        durationMicroseconds: canonicalProbe.durationMicroseconds,
        averageFrameRate: canonicalRate,
        realFrameRate: canonicalRate,
      },
    } as const;
    const prepareRequests: Parameters<VideoBackend["prepareVideoAsset"]>[0][] = [];
    const prepareVideoAsset = vi.fn(
      async (request: Parameters<VideoBackend["prepareVideoAsset"]>[0]) => {
        prepareRequests.push(request);
        return canonicalPrepared;
      },
    );
    const probeVideoSource = vi.fn(async () => preliminaryProbe);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      const importedAsset = request.commands.find((command) => command.type === "ImportAsset");
      const createdSequence = request.commands.find((command) => command.type === "CreateSequence");
      const insertedClip = request.commands.find((command) => command.type === "InsertClip");
      if (
        importedAsset?.type !== "ImportAsset" ||
        createdSequence?.type !== "CreateSequence" ||
        insertedClip?.type !== "InsertClip"
      )
        throw new Error("Expected a grouped first import");
      const imported = clipProjection(1);
      imported.state.assets = [importedAsset.asset];
      const sequence = structuredClone(createdSequence.sequence);
      const track = sequence.tracks.find((item) => item.id === insertedClip.trackId);
      if (track === undefined || track.kind === "caption")
        throw new Error("Expected the imported media track");
      track.clips.push(insertedClip.clip);
      imported.state.sequences = [sequence];
      imported.state.activeSequenceId = sequence.id;
      imported.sources = [
        {
          assetId: importedAsset.asset.id,
          status: "resolved",
          resolvedPath: importedAsset.asset.locator.absolutePath ?? "C:\\Media\\clip.mp4",
        },
      ];
      return commandResult(empty, imported, request.groupId);
    });
    const backend = createBackend({
      createVideoProject: vi.fn(async () => empty),
      pickVideoSource: vi.fn(async () => "C:\\Media\\clip.mp4"),
      probeVideoSource,
      prepareVideoAsset,
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.newProject());

    await act(() => result.current.chooseSource());

    expect(probeVideoSource).not.toHaveBeenCalled();
    const prepareRequest = prepareRequests[0]!;
    expect(prepareRequest).toEqual(
      expect.objectContaining({ projectId: empty.projectId, path: "C:\\Media\\clip.mp4" }),
    );
    expect(prepareRequest).not.toHaveProperty("sequenceRate");
    const request = execute.mock.calls[0]![0];
    const importedAsset = request.commands.find((command) => command.type === "ImportAsset");
    const createdSequence = request.commands.find((command) => command.type === "CreateSequence");
    const insertedClip = request.commands.find((command) => command.type === "InsertClip");
    expect(importedAsset?.type === "ImportAsset" ? importedAsset.asset.probe : null).toEqual(
      canonicalProbe,
    );
    expect(
      createdSequence?.type === "CreateSequence" ? createdSequence.sequence.rate : null,
    ).toEqual(canonicalRate);
    expect(insertedClip?.type === "InsertClip" ? insertedClip.clip.timelineStart : null).toEqual({
      value: 0,
      rateNumerator: 60,
      rateDenominator: 1,
    });
    expect(insertedClip?.type === "InsertClip" ? insertedClip.clip.sourceIn : null).toEqual({
      value: 0,
      rateNumerator: 60,
      rateDenominator: 1,
    });
    expect(insertedClip?.type === "InsertClip" ? insertedClip.clip.sourceOut : null).toEqual({
      value: 150,
      rateNumerator: 60,
      rateDenominator: 1,
    });
    expect(result.current.projection?.state.assets[0]?.probe).toEqual(canonicalProbe);
    expect(result.current.projection?.state.sequences[0]?.rate).toEqual(canonicalRate);
  });

  it("sets and clears checkpoint warnings across trim, undo, and redo results", async () => {
    const opened = clipProjection(1);
    const trimmed = clipProjection(2, 10, 50);
    const undone = { ...clipProjection(3), canRedo: true };
    const redone = clipProjection(4, 10, 50);
    const execute = vi.fn(async (request: CommandGroupRequest) =>
      withCheckpointWarning(commandResult(opened, trimmed, request.groupId), "projection"),
    );
    const undo = vi.fn(async (_projectId: string, _base: number, operationId: string) =>
      commandResult(trimmed, undone, operationId),
    );
    const redo = vi.fn(async (_projectId: string, _base: number, operationId: string) =>
      withCheckpointWarning(commandResult(undone, redone, operationId), "event"),
    );
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
      undoVideoProject: undo,
      redoVideoProject: redo,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    act(() => result.current.updateTrimDraft({ inFrame: 10, outFrame: 50 }));
    await act(() => result.current.applyTrim());
    expect(result.current.checkpointWarning).toEqual({
      type: "snapshot_pending",
      revision: 2,
    });
    await act(() => result.current.undoEdit());
    expect(result.current.checkpointWarning).toBeNull();
    await act(() => result.current.redoEdit());
    expect(result.current.checkpointWarning).toEqual({
      type: "snapshot_pending",
      revision: 4,
    });
  });

  it("uses the active video clip asset and normalizes the legacy audio-rate view", async () => {
    const base = clipProjection(1);
    const actualAsset = base.state.assets[0]!;
    const sequence = base.state.sequences[0]!;
    const videoTrack = sequence.tracks[0]!;
    if (videoTrack.kind !== "video") throw new Error("Expected video track fixture");
    const decoyAsset = {
      ...actualAsset,
      id: id(6),
      displayName: "audio.mp4",
      locator: { absolutePath: "C:\\Media\\audio.mp4" },
    };
    const opened = {
      ...base,
      state: {
        ...base.state,
        assets: [decoyAsset, actualAsset],
        sequences: [
          {
            ...sequence,
            audioSampleRate: 44_100,
            tracks: [
              {
                id: id(7),
                name: "Audio 1",
                kind: "audio" as const,
                clips: [
                  {
                    ...videoTrack.clips[0]!,
                    id: id(8),
                    source: { kind: "asset" as const, assetId: decoyAsset.id },
                  },
                ],
              },
              videoTrack,
            ],
          },
        ],
      },
      sources: [
        {
          assetId: decoyAsset.id,
          status: "resolved" as const,
          resolvedPath: "C:\\Media\\audio.mp4",
        },
        {
          assetId: actualAsset.id,
          status: "resolved" as const,
          resolvedPath: "C:\\Media\\clip.mp4",
        },
      ],
    } satisfies ProjectProjection;
    const prepareVideoAsset = vi.fn(async () => prepared);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      prepareVideoAsset,
    });
    const { result } = renderHook(() => useVideoProject(backend));

    await act(() => result.current.openProject());

    expect(prepareVideoAsset).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: actualAsset.id, path: "C:\\Media\\clip.mp4" }),
    );
    expect(result.current.project?.revisions[0]?.state.asset?.id).toBe(actualAsset.id);
    expect(result.current.project?.revisions[0]?.state.sequence?.audioSampleRate).toBe(48_000);
    expect(result.current.project?.revisions[0]?.state.sequence?.videoTracks[0].clips[0]?.id).toBe(
      videoTrack.clips[0]!.id,
    );
  });

  it("regenerates prepared media when undo invalidates the asset source", async () => {
    const opened = clipProjection(1);
    const undone = clipProjection(2);
    undone.sources = [
      { assetId: id(2), status: "resolved", resolvedPath: "C:\\Media\\replacement.mp4" },
    ];
    undone.state.assets[0]!.locator = { absolutePath: "C:\\Media\\replacement.mp4" };
    const refreshed = {
      ...prepared,
      proxyPath: "C:\\Cache\\replacement-proxy.mp4",
      thumbnailPath: "C:\\Cache\\replacement-thumb.jpg",
    };
    const prepareVideoAsset = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(refreshed);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      prepareVideoAsset,
      undoVideoProject: vi.fn(async (_projectId, _baseRevision, operationId) => {
        const invalidated = commandResult(opened, undone, operationId);
        invalidated.cacheInvalidations = ["asset_source"];
        return invalidated;
      }),
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.undoEdit());

    expect(prepareVideoAsset).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "C:\\Media\\replacement.mp4" }),
    );
    expect(result.current.preparedAsset).toEqual(refreshed);
  });

  it("preserves the missing projection when relink selection is cancelled", async () => {
    const opened = clipProjection(1);
    opened.sources = [{ assetId: id(2), status: "missing", resolvedPath: null }];
    const openVideoProject = vi.fn(async () => ({
      projection: opened,
      recovery: {
        status: "clean" as const,
        recoveredRevision: 1,
        replayedRecordCount: 0,
        discardedTailBytes: 0,
        message: "Clean",
        legacyHistoryReset: false,
      },
    }));
    const relinkVideoProjectAsset = vi.fn(async () => null);
    const prepareVideoAsset = vi.fn(async () => prepared);
    const backend = createBackend({
      openVideoProject,
      relinkVideoProjectAsset,
      prepareVideoAsset,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.regrantSourceAccess());

    expect(relinkVideoProjectAsset).toHaveBeenCalledWith(opened.projectId, id(2));
    expect(openVideoProject).toHaveBeenCalledOnce();
    expect(prepareVideoAsset).not.toHaveBeenCalled();
    expect(result.current.projection).toEqual(opened);
    expect(result.current.source?.status).toBe("missing");
    expect(result.current.projectOperation).toEqual({ phase: "idle" });
  });
  it("stays running through a durable retry and accepts the sole completion terminal", async () => {
    const opened = clipProjection(1);
    const outputPath = "C:\\Exports\\clip.mp4";
    const unlisten = vi.fn();
    let renderHandler: ((event: VideoRenderNotification) => void) | null = null;
    const emitRenderEvent = (event: VideoRenderNotification) => {
      if (renderHandler === null) throw new Error("Render listener was not registered");
      renderHandler(event);
    };
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      pickVideoExportPath: vi.fn(async () => outputPath),
      listenVideoRenderEvents: vi.fn(async (handler) => {
        renderHandler = handler;
        return unlisten;
      }),
      startVideoRender: vi.fn(async (plan) => ({
        jobId: id(90),
        planId: plan.planId,
        revisionId: plan.revisionId,
      })),
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    await act(() => result.current.exportVideo());

    expect(result.current.render.phase).toBe("running");
    if (result.current.render.phase !== "running") throw new Error("Render did not start");
    const identity = {
      jobId: result.current.render.jobId,
      planId: result.current.render.planId,
      revisionId: result.current.render.revisionId,
    };
    const observedPhases = [result.current.render.phase];

    act(() =>
      emitRenderEvent({
        type: "progress",
        ...identity,
        completedMicroseconds: 250_000,
        durationMicroseconds: 2_000_000,
      }),
    );
    observedPhases.push(result.current.render.phase);
    expect(result.current.render).toMatchObject({ phase: "running", progress: 12 });
    expect(unlisten).not.toHaveBeenCalled();

    act(() =>
      emitRenderEvent({
        type: "completed",
        ...identity,
        output: {
          outputPath,
          previewPath: "C:\\Cache\\clip-preview.mp4",
          probe,
        },
      }),
    );
    observedPhases.push(result.current.render.phase);

    expect(observedPhases).toEqual(["running", "running", "completed"]);
    expect(observedPhases).not.toContain("failed");
    expect(result.current.render).toMatchObject({ phase: "completed", jobId: identity.jobId });
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("ignores a stale import result after a project switch", async () => {
    let resolveExecute!: (value: CommandResult) => void;
    const pending = new Promise<CommandResult>((resolve) => {
      resolveExecute = resolve;
    });
    const first = emptyProjection();
    const second = { ...emptyProjection(), projectId: id(9), name: "Second" };
    const backend = createBackend({
      createVideoProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      executeVideoProjectGroup: vi.fn(() => pending),
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.newProject());
    let importPromise!: Promise<void>;
    act(() => {
      importPromise = result.current.prepareImportedSource("C:\\Media\\clip.mp4");
    });
    await waitFor(() => expect(backend.executeVideoProjectGroup).toHaveBeenCalled());
    await act(() => result.current.newProject());
    resolveExecute(commandResult(first, clipProjection(1), id(70)));
    await act(() => importPromise);
    expect(result.current.projection?.projectId).toBe(second.projectId);
  });
});
