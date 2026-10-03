// @vitest-environment jsdom

import type {
  CommandGroupRequest,
  CommandResult,
  OpenedProjectV2,
  ProjectProjection,
} from "@supa-video/contracts";
import type {
  MediaJobList,
  MediaJobRecord,
  MusicBeatAnalysisV1,
  MusicBeatRuntimeStatus,
} from "@supa-video/media";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MusicBeatBackend } from "./music-beat-ipc";
import {
  createMockVideoService,
  testMediaCacheStatus,
  testMediaJob,
  testPrepared,
  testProbe,
  testSourceIdentity,
} from "./test-video-service";
import { useVideoProject } from "./use-video-project";
import { tauriVideoBackend, type VideoBackend } from "./video-ipc";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  invoke: vi.fn(async () => {
    throw new Error("unexpected Tauri invoke");
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

afterEach(cleanup);

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const rate = { numerator: 30, denominator: 1 };
const time = (value: number) => ({
  value,
  rateNumerator: rate.numerator,
  rateDenominator: rate.denominator,
});
const ids = {
  musicAsset: id(800),
  sequence: id(802),
  musicTrack: id(805),
  musicClip: id(806),
  graphicsTrack: id(807),
  graphicsClip: id(808),
  job: id(809),
};
const transform = {
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1000,
  scaleYPermille: 1000,
  rotationMilliDegrees: 0,
  opacityPermille: 1000,
};
const hold = (value: number) => [{ timeMicroseconds: 0, value }];
// 120 BPM: a music beat every 0.5 s = every 15 frames at 30 fps.
const musicBeatAnalysis: MusicBeatAnalysisV1 = {
  schemaVersion: 1,
  detector: { kind: "tempo_fallback", version: "tempo-fallback-v1", checkpointSha256: null },
  durationUs: 2_000_000,
  tempoBpm: 120,
  beatsUs: [0, 500_000, 1_000_000, 1_500_000],
  downbeatsUs: [0],
  onsetsUs: [0, 500_000, 1_000_000, 1_500_000],
};

const runtimeStatus = (runtime: MusicBeatRuntimeStatus["runtime"]): MusicBeatRuntimeStatus => ({
  runtimeFolder: runtime.state === "notConfigured" ? null : "D:\\supa-music-beats",
  runtime,
  accelerator: runtime.state === "ready" ? { kind: "cuda" } : null,
  manifestSha256: "a".repeat(64),
  beatThisVersion: "rs-1.1.0",
  checkpointSha256: "c".repeat(64),
});

function jobRecord(state: "running" | "complete"): MediaJobRecord {
  const base = {
    ...testMediaJob,
    id: ids.job,
    kind: "music_beat_detection" as const,
    assetId: ids.musicAsset,
    revisionId: null,
    attempt: 1,
    maxAttempts: 2,
    summary: "Detect music beats",
  };
  return state === "complete"
    ? {
        ...base,
        state,
        stage: "complete",
        progress: { completed: 3, total: 3, unit: "stages" },
        settledAt: testMediaJob.createdAt,
        resultAvailable: true,
      }
    : {
        ...base,
        state,
        stage: "detect",
        progress: { completed: 1, total: 3, unit: "stages" },
        startedAt: testMediaJob.createdAt,
      };
}

/** A detection interrupted by an app restart, as job recovery leaves it. */
const blockedJob: MediaJobRecord = {
  ...testMediaJob,
  id: ids.job,
  kind: "music_beat_detection",
  assetId: ids.musicAsset,
  revisionId: null,
  attempt: 1,
  maxAttempts: 2,
  summary: "Detect music beats",
  progress: { completed: 1, total: 3, unit: "stages" },
  startedAt: testMediaJob.createdAt,
  state: "blocked",
  stage: "authorization",
  error: {
    code: "source_authorization_required",
    category: "authorization_required",
    message: "Choose the source again to continue.",
    retryable: false,
    action: "reauthorize_source",
  },
};

/** A detection whose per-run runtime recheck found the models changed. */
const runtimeChangedJob: MediaJobRecord = {
  ...blockedJob,
  stage: "detect",
  error: {
    code: "music_beat_runtime_unavailable",
    category: "toolchain_unavailable",
    message: "The music beat runtime is unavailable or changed.",
    retryable: false,
    action: "verify_toolchain",
  },
};

function jobList(jobs: MediaJobRecord[]): MediaJobList {
  return {
    schemaVersion: 1,
    jobs,
    unsettledParentCount: 0,
    nextBeforeUpdatedAt: null,
    nextBeforeJobId: null,
    latestEventId: 0,
    recovery: null,
  };
}

/**
 * A job list whose first page is 100 newer unrelated jobs plus a cursor, and
 * whose second page holds `olderJobs()`.
 */
function pagedJobList(olderJobs: () => MediaJobRecord[]): VideoBackend["listMediaJobs"] {
  const cursorJob = id(1099);
  return async (request) => {
    if (request?.beforeUpdatedAt === null || request?.beforeUpdatedAt === undefined) {
      const unrelated = Array.from({ length: 100 }, (_, index) => ({
        ...testMediaJob,
        id: id(1000 + index),
        kind: "thumbnail_tile" as const,
      }));
      return {
        ...jobList(unrelated),
        nextBeforeUpdatedAt: testMediaJob.updatedAt,
        nextBeforeJobId: cursorJob,
      };
    }
    expect(request).toMatchObject({
      projectId: expect.any(String),
      beforeUpdatedAt: testMediaJob.updatedAt,
      beforeJobId: cursorJob,
    });
    return jobList(olderJobs());
  };
}

async function fixture(
  jobState: "running" | "complete" = "complete",
  recoveredJob: MediaJobRecord | null = null,
  listJobs: VideoBackend["listMediaJobs"] | null = null,
) {
  const service = createMockVideoService({ sourcePath: "C:\\Media\\music.wav" });
  const created = (await service.invoke("video_create_project")) as ProjectProjection;
  await service.invoke("video_execute_project_group", {
    request: {
      groupId: id(810),
      projectId: created.projectId,
      baseRevision: created.revision.number,
      commands: [
        {
          type: "ImportAsset",
          commandId: id(811),
          asset: {
            id: ids.musicAsset,
            displayName: "music.wav",
            locator: { absolutePath: "C:\\Media\\music.wav" },
            probe: testProbe,
            contentIdentity: testSourceIdentity,
          },
        },
        {
          type: "CreateSequence",
          commandId: id(812),
          sequence: {
            id: ids.sequence,
            name: "Main",
            rate,
            width: 320,
            height: 180,
            audioSampleRate: 48_000,
            markers: [],
            tracks: [
              {
                id: ids.musicTrack,
                name: "Music",
                kind: "audio",
                audioRole: "music",
                clips: [
                  {
                    id: ids.musicClip,
                    source: { kind: "asset", assetId: ids.musicAsset },
                    timelineStart: time(0),
                    sourceIn: time(0),
                    sourceOut: time(60),
                    transform,
                    gainMilliDecibels: 0,
                  },
                ],
              },
              {
                id: ids.graphicsTrack,
                name: "Graphics 1",
                kind: "graphics",
                graphicsClips: [
                  {
                    graphicsVersion: 1,
                    id: ids.graphicsClip,
                    timelineStart: time(0),
                    duration: time(60),
                    fontKey: "segoe-ui-bold",
                    layers: [
                      {
                        kind: "text",
                        text: "On the music beat",
                        fontSize: 48,
                        fill: "#FFFFFF",
                        x: hold(100),
                        y: hold(100),
                        scale: hold(1),
                        rotation: hold(0),
                        // 470 ms is 30 ms off the 500 ms music beat.
                        opacity: [
                          { timeMicroseconds: 0, value: 0 },
                          { timeMicroseconds: 470_000, value: 1 },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  });
  const execute = vi.fn(
    (request: CommandGroupRequest) =>
      service.invoke("video_execute_project_group", { request }) as Promise<CommandResult>,
  );
  const history =
    (command: "video_undo_project" | "video_redo_project") =>
    (projectId: string, baseRevision: number, operationId: string) =>
      service.invoke(command, { projectId, baseRevision, operationId }) as Promise<CommandResult>;
  let started = false;
  const cancelMediaJob = vi.fn<VideoBackend["cancelMediaJob"]>(async () => ({
    schemaVersion: 1,
    job: jobRecord("running"),
  }));
  const backend: VideoBackend = {
    ...tauriVideoBackend,
    getVideoToolStatus: vi.fn(async () => ({
      source: "bundled" as const,
      toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
      ffmpeg: { available: true, version: "8.1.2" },
      ffprobe: { available: true, version: "8.1.2" },
      ready: true,
    })),
    openVideoProject: vi.fn(
      async () => (await service.invoke("video_open_project")) as OpenedProjectV2,
    ),
    executeVideoProjectGroup: execute,
    undoVideoProject: vi.fn(history("video_undo_project")),
    redoVideoProject: vi.fn(history("video_redo_project")),
    probeVideoSource: vi.fn(async () => testProbe),
    prepareVideoAsset: vi.fn(async () => testPrepared),
    listMediaJobs: vi.fn<VideoBackend["listMediaJobs"]>(
      listJobs ??
        (async () =>
          jobList(started ? [jobRecord(jobState)] : recoveredJob === null ? [] : [recoveredJob])),
    ),
    getMediaJobEvents: vi.fn(async () => ({
      schemaVersion: 1 as const,
      events: [],
      latestEventId: 0,
      hasMore: false,
    })),
    getMediaCacheStatus: vi.fn(async () => testMediaCacheStatus),
    cancelMediaJob,
    listenMediaJobEvents: vi.fn(async () => () => undefined),
    listenVideoRenderEvents: vi.fn(async () => () => undefined),
    convertFileSrc: vi.fn((path: string) => `asset:${path}`),
  };
  const musicBeats = {
    getMusicBeatRuntimeStatus: vi.fn<MusicBeatBackend["getMusicBeatRuntimeStatus"]>(async () =>
      runtimeStatus({ state: "notConfigured" }),
    ),
    chooseMusicBeatRuntimeFolder: vi.fn<MusicBeatBackend["chooseMusicBeatRuntimeFolder"]>(
      async () => runtimeStatus({ state: "ready" }),
    ),
    startMusicBeatDetection: vi.fn<MusicBeatBackend["startMusicBeatDetection"]>(async () => {
      started = true;
      return { jobId: ids.job, state: "queued" };
    }),
    getMusicBeatDetectionResult: vi.fn<MusicBeatBackend["getMusicBeatDetectionResult"]>(
      async () => ({
        analysisKey: "b".repeat(64),
        detector: "tempo_fallback",
        musicBeatCount: 4,
        reused: false,
      }),
    ),
    loadMusicBeatAnalysis: vi.fn<MusicBeatBackend["loadMusicBeatAnalysis"]>(
      async () => musicBeatAnalysis,
    ),
  } satisfies MusicBeatBackend;
  const hook = renderHook(() => useVideoProject(backend, null, musicBeats));
  await act(() => hook.result.current.openProject());
  return { result: hook.result, execute, musicBeats, cancelMediaJob };
}

type Result = Awaited<ReturnType<typeof fixture>>["result"];

const opacityTimes = (projection: ProjectProjection | null) => {
  const track = projection?.state.sequences[0]?.tracks.find(
    (item) => item.id === ids.graphicsTrack,
  );
  const layer = track?.kind === "graphics" ? track.graphicsClips[0]?.layers[0] : undefined;
  return layer?.opacity.map(({ timeMicroseconds }) => timeMicroseconds);
};
const musicClipStart = (projection: ProjectProjection | null) => {
  const track = projection?.state.sequences[0]?.tracks.find((item) => item.id === ids.musicTrack);
  return track?.kind === "audio" ? track.clips[0]?.timelineStart.value : undefined;
};
const graphicsRef = {
  sequenceId: ids.sequence,
  trackId: ids.graphicsTrack,
  graphicsClipId: ids.graphicsClip,
};

async function detect(result: Result): Promise<void> {
  await act(async () => {
    await result.current.detectMusicBeats(ids.musicAsset);
  });
}

describe("useVideoProject music beat runtime", () => {
  it("loads the runtime status once on mount", async () => {
    const { result, musicBeats } = await fixture();

    await waitFor(() => {
      expect(result.current.musicBeatRuntimeStatus).toEqual(
        runtimeStatus({ state: "notConfigured" }),
      );
    });
    expect(musicBeats.getMusicBeatRuntimeStatus).toHaveBeenCalledOnce();
  });

  it("stores the status of a chosen folder and keeps it when the picker is cancelled", async () => {
    const { result, musicBeats } = await fixture();
    await waitFor(() => expect(result.current.musicBeatRuntimeStatus).not.toBeNull());

    await act(() => result.current.chooseMusicBeatRuntimeFolder());

    expect(musicBeats.chooseMusicBeatRuntimeFolder).toHaveBeenCalledOnce();
    expect(result.current.musicBeatRuntimeStatus).toEqual(runtimeStatus({ state: "ready" }));

    musicBeats.chooseMusicBeatRuntimeFolder.mockResolvedValueOnce(null);
    await act(() => result.current.chooseMusicBeatRuntimeFolder());

    expect(result.current.musicBeatRuntimeStatus).toEqual(runtimeStatus({ state: "ready" }));
  });

  it("refreshes the status and reports a failed check", async () => {
    const { result, musicBeats } = await fixture();
    await waitFor(() => expect(result.current.musicBeatRuntimeStatus).not.toBeNull());

    musicBeats.getMusicBeatRuntimeStatus.mockRejectedValueOnce(new Error("ipc down"));
    await act(() => result.current.refreshMusicBeatRuntimeStatus());
    expect(result.current.musicBeatRuntimeError).toMatch(/could not be checked/);

    musicBeats.getMusicBeatRuntimeStatus.mockResolvedValueOnce(
      runtimeStatus({ state: "unavailable", problem: { reason: "modelMismatch" } }),
    );
    await act(() => result.current.refreshMusicBeatRuntimeStatus());
    expect(result.current.musicBeatRuntimeError).toBeNull();
    expect(result.current.musicBeatRuntimeStatus?.runtime).toEqual({
      state: "unavailable",
      problem: { reason: "modelMismatch" },
    });
  });

  it("refreshes the status after a detection starts", async () => {
    const { result, musicBeats } = await fixture();
    await waitFor(() => expect(result.current.musicBeatRuntimeStatus).not.toBeNull());
    musicBeats.getMusicBeatRuntimeStatus.mockReset();
    musicBeats.getMusicBeatRuntimeStatus
      .mockResolvedValueOnce(runtimeStatus({ state: "ready" }))
      .mockResolvedValueOnce(
        runtimeStatus({ state: "unavailable", problem: { reason: "modelMismatch" } }),
      );
    await act(() => result.current.refreshMusicBeatRuntimeStatus());
    expect(result.current.musicBeatRuntimeStatus).toEqual(runtimeStatus({ state: "ready" }));
    expect(result.current.musicBeatRuntimeStatus?.accelerator).toEqual({ kind: "cuda" });

    await detect(result);

    expect(musicBeats.getMusicBeatRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(result.current.musicBeatRuntimeStatus).toEqual(
      runtimeStatus({ state: "unavailable", problem: { reason: "modelMismatch" } }),
    );
  });

  it("refreshes the status when a polled detection finds the runtime changed", async () => {
    let started = false;
    const { result, musicBeats } = await fixture("complete", null, async () =>
      jobList(started ? [runtimeChangedJob] : []),
    );
    await waitFor(() => expect(result.current.musicBeatRuntimeStatus).not.toBeNull());
    musicBeats.startMusicBeatDetection.mockImplementationOnce(async () => {
      started = true;
      return { jobId: ids.job, state: "queued" };
    });
    musicBeats.getMusicBeatRuntimeStatus
      .mockResolvedValueOnce(runtimeStatus({ state: "ready" }))
      .mockResolvedValueOnce(
        runtimeStatus({ state: "unavailable", problem: { reason: "modelMismatch" } }),
      );

    await detect(result);

    // Mount, detection start, then the blocked run.
    expect(musicBeats.getMusicBeatRuntimeStatus).toHaveBeenCalledTimes(3);
    expect(result.current.musicBeatDetection.get(ids.musicAsset)).toEqual({
      phase: "failed",
      message: "The music beat runtime is unavailable or changed.",
    });
    expect(result.current.musicBeatRuntimeStatus?.runtime).toEqual({
      state: "unavailable",
      problem: { reason: "modelMismatch" },
    });
  });

  it("keeps the status when a detection is blocked for another reason", async () => {
    let started = false;
    const { result, musicBeats } = await fixture("complete", null, async () =>
      jobList(started ? [blockedJob] : []),
    );
    await waitFor(() => expect(result.current.musicBeatRuntimeStatus).not.toBeNull());
    musicBeats.startMusicBeatDetection.mockImplementationOnce(async () => {
      started = true;
      return { jobId: ids.job, state: "queued" };
    });

    await detect(result);

    // Mount and detection start only.
    expect(musicBeats.getMusicBeatRuntimeStatus).toHaveBeenCalledTimes(2);
  });
});

describe("useVideoProject music beats", () => {
  it("detects music beats on a music asset and exposes them as timeline targets", async () => {
    const { result, musicBeats } = await fixture();

    await detect(result);

    expect(musicBeats.startMusicBeatDetection).toHaveBeenCalledWith({
      projectId: result.current.projection?.projectId,
      assetId: ids.musicAsset,
      sourcePath: "C:\\Media\\music.wav",
    });
    expect(result.current.musicBeatDetection.get(ids.musicAsset)).toEqual({
      phase: "ready",
      detector: "tempo_fallback",
    });
    expect(result.current.musicBeatTargets.map(({ frame }) => frame)).toEqual([0, 15, 30, 45]);
  });

  it("cancels a running music beat detection through its media job", async () => {
    const { result, cancelMediaJob } = await fixture("running");

    act(() => {
      void result.current.detectMusicBeats(ids.musicAsset);
    });
    await waitFor(() => {
      expect(result.current.musicBeatDetection.get(ids.musicAsset)).toEqual({
        phase: "running",
        jobId: ids.job,
      });
    });
    await act(() => result.current.cancelMusicBeatDetection(ids.musicAsset));

    expect(cancelMediaJob).toHaveBeenCalledWith({ jobId: ids.job });
  });

  it("reports a detection blocked by a restart and detects again from it", async () => {
    const { result, musicBeats } = await fixture("complete", blockedJob);

    await waitFor(() => {
      expect(result.current.musicBeatDetection.get(ids.musicAsset)).toEqual({
        phase: "failed",
        message: "Choose the source again to continue.",
      });
    });

    await detect(result);

    expect(musicBeats.startMusicBeatDetection).toHaveBeenCalledOnce();
    expect(result.current.musicBeatDetection.get(ids.musicAsset)).toEqual({
      phase: "ready",
      detector: "tempo_fallback",
    });
  });

  it("reloads a completed analysis from an older job page when the project opens", async () => {
    const { result, musicBeats } = await fixture(
      "complete",
      null,
      pagedJobList(() => [jobRecord("complete")]),
    );

    await waitFor(() => {
      expect(result.current.musicBeatAnalyses.get(ids.musicAsset)).toEqual(musicBeatAnalysis);
    });
    expect(musicBeats.getMusicBeatDetectionResult).toHaveBeenCalledWith(ids.job);
    expect(musicBeats.startMusicBeatDetection).not.toHaveBeenCalled();
  });

  it("finishes polling a detection whose job is on an older page", async () => {
    let started = false;
    const { result, musicBeats } = await fixture(
      "complete",
      null,
      pagedJobList(() => (started ? [jobRecord("complete")] : [])),
    );
    musicBeats.startMusicBeatDetection.mockImplementationOnce(async () => {
      started = true;
      return { jobId: ids.job, state: "queued" };
    });

    await detect(result);

    expect(result.current.musicBeatDetection.get(ids.musicAsset)).toEqual({
      phase: "ready",
      detector: "tempo_fallback",
    });
  });

  it("snaps graphics keyframes to music beats as one undoable edit", async () => {
    const { result, execute } = await fixture();
    await detect(result);
    expect(opacityTimes(result.current.projection)).toEqual([0, 470_000]);

    let outcome: { readonly ok: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.snapGraphicsClipToMusicBeats(graphicsRef);
    });

    expect(outcome).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].commands.map(({ type }) => type)).toEqual([
      "SetGraphicsClipLayers",
    ]);
    expect(opacityTimes(result.current.projection)).toEqual([0, 500_000]);

    await act(() => result.current.undoEdit());

    expect(opacityTimes(result.current.projection)).toEqual([0, 470_000]);
  });

  it("refuses to snap graphics before music beats are detected", async () => {
    const { result, execute } = await fixture();

    let outcome: { readonly ok: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.snapGraphicsClipToMusicBeats(graphicsRef);
    });

    expect(outcome).toMatchObject({ ok: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("commits a move onto a music beat as one MoveClip that undo restores", async () => {
    const { result, execute } = await fixture();
    await detect(result);
    const target = result.current.musicBeatTargets.find(({ frame }) => frame === 15);
    expect(target).toBeDefined();

    await act(async () => {
      await result.current.moveTimelineClip({
        clipId: ids.musicClip,
        timelineStartFrame: target?.frame ?? -1,
      });
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].commands.map(({ type }) => type)).toEqual(["MoveClip"]);
    expect(musicClipStart(result.current.projection)).toBe(15);
    // The moved music clip's music beats move with it.
    expect(result.current.musicBeatTargets.map(({ frame }) => frame)).toEqual([15, 30, 45, 60]);

    await act(() => result.current.undoEdit());

    expect(musicClipStart(result.current.projection)).toBe(0);
    expect(result.current.musicBeatTargets.map(({ frame }) => frame)).toEqual([0, 15, 30, 45]);
  });
});
