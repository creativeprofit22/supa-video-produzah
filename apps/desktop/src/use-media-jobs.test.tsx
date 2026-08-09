// @vitest-environment jsdom

import type {
  MediaCacheStatus,
  MediaJobEvent,
  MediaJobList,
  MediaJobRecord,
} from "@supa-video/media";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { testMediaCacheStatus, testMediaJob } from "./test-video-service";
import { useMediaJobs } from "./use-media-jobs";
import { tauriVideoBackend, type VideoBackend } from "./video-ipc";

const timestamp = "2026-07-26T12:00:01.000Z";

function pagedJob(id: string): MediaJobRecord {
  return { ...testMediaJob, id, updatedAt: timestamp };
}

function event(eventId: number, state: MediaJobEvent["state"] = "running"): MediaJobEvent {
  return {
    schemaVersion: 1,
    eventId,
    jobId: testMediaJob.id,
    eventType: state === "running" ? "progress" : "state_changed",
    state,
    stage: state,
    progress: { completed: eventId, total: 10, unit: "items" },
    message: null,
    category: null,
    createdAt: timestamp,
  };
}

function mediaBackend(overrides: Partial<VideoBackend> = {}): VideoBackend {
  return {
    ...tauriVideoBackend,
    listMediaJobs: vi.fn<VideoBackend["listMediaJobs"]>(async () => ({
      schemaVersion: 1,
      jobs: [testMediaJob],
      unsettledParentCount: 1,
      nextBeforeUpdatedAt: null,
      nextBeforeJobId: null,
      latestEventId: 1,
      recovery: null,
    })),
    getMediaJobEvents: vi.fn<VideoBackend["getMediaJobEvents"]>(async () => ({
      schemaVersion: 1,
      events: [],
      latestEventId: 1,
      hasMore: false,
    })),
    cancelMediaJob: vi.fn<VideoBackend["cancelMediaJob"]>(async () => ({
      schemaVersion: 1,
      job: testMediaJob,
    })),
    retryMediaJob: vi.fn<VideoBackend["retryMediaJob"]>(async () => ({
      schemaVersion: 1,
      job: testMediaJob,
    })),
    reauthorizeMediaJobOutput: vi.fn<VideoBackend["reauthorizeMediaJobOutput"]>(async () => ({
      schemaVersion: 1,
      job: testMediaJob,
    })),
    getMediaCacheStatus: vi.fn(async () => testMediaCacheStatus),
    clearLegacyMediaCache: vi.fn<VideoBackend["clearLegacyMediaCache"]>(async () => ({
      schemaVersion: 1,
      clearedBytes: testMediaCacheStatus.legacyBytes,
      clearedEntryCount: testMediaCacheStatus.legacyEntryCount,
      skippedUnsafeEntryCount: testMediaCacheStatus.legacyUnsafeEntryCount,
      status: {
        ...testMediaCacheStatus,
        legacyBytes: 0,
        legacyEntryCount: 0,
        legacyUnsafeEntryCount: 0,
        legacyClearAvailable: false,
      },
    })),
    loadManagedTranscriptArtifact: vi.fn(async () => {
      throw new Error("unexpected managed transcript load");
    }),
    listenMediaJobEvents: vi.fn(async () => () => undefined),
    ...overrides,
  };
}

describe("durable media jobs controller", () => {
  it("subscribes before snapshot and reconciles live gaps by monotonic event ID", async () => {
    const calls: string[] = [];
    let onEvent: ((value: MediaJobEvent) => void) | undefined;
    const runningJob: MediaJobRecord = {
      ...testMediaJob,
      state: "running",
      stage: "running",
      progress: { completed: 3, total: 10, unit: "items" },
      attempt: 1,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    const listMediaJobs = vi
      .fn<VideoBackend["listMediaJobs"]>()
      .mockImplementationOnce(async () => {
        calls.push("snapshot");
        return {
          schemaVersion: 1,
          jobs: [testMediaJob],
          unsettledParentCount: 1,
          nextBeforeUpdatedAt: null,
          nextBeforeJobId: null,
          latestEventId: 1,
          recovery: null,
        };
      })
      .mockResolvedValue({
        schemaVersion: 1,
        jobs: [runningJob],
        unsettledParentCount: 1,
        nextBeforeUpdatedAt: null,
        nextBeforeJobId: null,
        latestEventId: 3,
        recovery: null,
      });
    const getMediaJobEvents = vi.fn<VideoBackend["getMediaJobEvents"]>(async () => ({
      schemaVersion: 1,
      events: [event(2), event(3)],
      latestEventId: 3,
      hasMore: false,
    }));
    const backend = mediaBackend({
      listMediaJobs,
      getMediaJobEvents,
      listenMediaJobEvents: vi.fn(async (handler) => {
        calls.push("subscribe");
        onEvent = handler;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useMediaJobs(backend));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(calls.slice(0, 2)).toEqual(["subscribe", "snapshot"]);
    expect(result.current.latestEventId).toBe(1);

    act(() => onEvent?.(event(3)));
    await waitFor(() => expect(result.current.latestEventId).toBe(3));
    expect(result.current.events.map(({ eventId }) => eventId)).toEqual([2, 3]);
    expect(result.current.jobs[0]?.state).toBe("running");

    const durableCalls = getMediaJobEvents.mock.calls.length;
    act(() => onEvent?.(event(2)));
    expect(getMediaJobEvents).toHaveBeenCalledTimes(durableCalls);
  });

  it("keeps retry and recovered completion authoritative in the controller snapshot", async () => {
    const blocked = {
      ...testMediaJob,
      state: "blocked",
      stage: "blocked",
      error: {
        code: "temporary_preview_failure",
        category: "transient_io",
        message: "Preview preparation needs attention.",
        retryable: true,
        action: "retry",
      },
      updatedAt: timestamp,
    } as MediaJobRecord;
    const retrying = {
      ...blocked,
      state: "retrying",
      stage: "retry_wait",
      retryAt: "2026-07-26T12:01:00.000Z",
      attempt: 1,
      updatedAt: "2026-07-26T12:00:02.000Z",
    } as MediaJobRecord;
    const complete = {
      ...blocked,
      state: "complete",
      stage: "complete",
      progress: { completed: 2, total: 2, unit: "stages" },
      error: null,
      settledAt: "2026-07-26T12:00:03.000Z",
      updatedAt: "2026-07-26T12:00:03.000Z",
      resultAvailable: true,
    } as MediaJobRecord;
    let current = blocked;
    let onEvent: ((value: MediaJobEvent) => void) | undefined;
    const recoveredEvent = event(2, "complete");
    const backend = mediaBackend({
      listMediaJobs: vi.fn<VideoBackend["listMediaJobs"]>(async () => ({
        schemaVersion: 1,
        jobs: [current],
        unsettledParentCount: current.state === "complete" ? 0 : 1,
        nextBeforeUpdatedAt: null,
        nextBeforeJobId: null,
        latestEventId: current.state === "complete" ? 2 : 1,
        recovery: null,
      })),
      getMediaJobEvents: vi.fn<VideoBackend["getMediaJobEvents"]>(async () => ({
        schemaVersion: 1,
        events: current.state === "complete" ? [recoveredEvent] : [],
        latestEventId: current.state === "complete" ? 2 : 1,
        hasMore: false,
      })),
      retryMediaJob: vi.fn<VideoBackend["retryMediaJob"]>(async () => {
        current = retrying;
        return { schemaVersion: 1, job: retrying };
      }),
      listenMediaJobEvents: vi.fn(async (handler) => {
        onEvent = handler;
        return () => undefined;
      }),
    });
    const { result } = renderHook(() => useMediaJobs(backend));
    await waitFor(() => expect(result.current.jobs[0]?.state).toBe("blocked"));

    await act(() => result.current.retryJob(blocked));
    expect(result.current.jobs[0]?.state).toBe("retrying");

    current = complete;
    act(() => onEvent?.(recoveredEvent));
    await waitFor(() => expect(result.current.jobs[0]?.state).toBe("complete"));
    expect(result.current.latestEventId).toBe(2);
  });

  it("picks a fresh destination and reauthorizes the same blocked render UUID", async () => {
    const blocked = {
      ...testMediaJob,
      kind: "final_render",
      state: "blocked",
      stage: "authorization",
      error: {
        code: "output_authorization_required",
        category: "output_authorization_required",
        message: "Choose the export destination again to continue.",
        retryable: false,
        action: "reauthorize_output",
      },
    } as MediaJobRecord;
    const queued = {
      ...blocked,
      state: "queued",
      stage: "queued",
      error: null,
      updatedAt: timestamp,
    } as MediaJobRecord;
    let current = blocked;
    const pickVideoExportPath = vi.fn(async () => "C:\\Exports\\launch.mp4");
    const reauthorizeMediaJobOutput = vi.fn<VideoBackend["reauthorizeMediaJobOutput"]>(
      async (request) => {
        expect(request).toEqual({
          jobId: blocked.id,
          outputPath: "C:\\Exports\\launch.mp4",
        });
        current = queued;
        return { schemaVersion: 1, job: queued };
      },
    );
    const backend = mediaBackend({
      pickVideoExportPath,
      reauthorizeMediaJobOutput,
      listMediaJobs: vi.fn<VideoBackend["listMediaJobs"]>(async () => ({
        schemaVersion: 1,
        jobs: [current],
        unsettledParentCount: 1,
        nextBeforeUpdatedAt: null,
        nextBeforeJobId: null,
        latestEventId: 1,
        recovery: null,
      })),
    });
    const { result } = renderHook(() => useMediaJobs(backend));
    await waitFor(() => expect(result.current.jobs[0]?.state).toBe("blocked"));

    await act(() => result.current.reauthorizeJobOutput(blocked));

    expect(pickVideoExportPath).toHaveBeenCalledWith("export.mp4");
    expect(reauthorizeMediaJobOutput).toHaveBeenCalledOnce();
    expect(result.current.jobs[0]).toMatchObject({ id: blocked.id, state: "queued" });
    expect(result.current.pendingJobIds).toEqual([]);
    expect(backend.retryMediaJob).not.toHaveBeenCalled();
  });

  it("falls back to snapshots after listener failure and refreshes again on resume", async () => {
    const backend = mediaBackend({
      listenMediaJobEvents: vi.fn(async () => {
        throw new Error("listener unavailable");
      }),
    });
    const { result } = renderHook(() => useMediaJobs(backend));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.listenerError?.message).toBe("listener unavailable");
    expect(backend.listMediaJobs).toHaveBeenCalledOnce();

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(backend.listMediaJobs).toHaveBeenCalledTimes(2));
    expect(backend.getMediaCacheStatus).toHaveBeenCalledTimes(2);
  });

  it("loads equal-timestamp pages once, guards duplicate requests, and refreshes the exposed depth", async () => {
    const newest = pagedJob("70000000-0000-4000-8000-000000000093");
    const boundary = pagedJob("70000000-0000-4000-8000-000000000092");
    const oldest = pagedJob("70000000-0000-4000-8000-000000000091");
    let resolveOlder!: (page: MediaJobList) => void;
    let olderPending = true;
    const listMediaJobs = vi.fn<VideoBackend["listMediaJobs"]>((request = {}) => {
      if (request.beforeUpdatedAt === null || request.beforeUpdatedAt === undefined) {
        return Promise.resolve({
          schemaVersion: 1,
          jobs: [newest, boundary],
          unsettledParentCount: 3,
          nextBeforeUpdatedAt: timestamp,
          nextBeforeJobId: boundary.id,
          latestEventId: 1,
          recovery: null,
        });
      }
      if (olderPending) {
        return new Promise<MediaJobList>((resolve) => {
          resolveOlder = resolve;
        });
      }
      return Promise.resolve({
        schemaVersion: 1,
        jobs: [boundary, oldest],
        unsettledParentCount: 3,
        nextBeforeUpdatedAt: null,
        nextBeforeJobId: null,
        latestEventId: 1,
        recovery: null,
      });
    });
    const backend = mediaBackend({ listMediaJobs });
    const { result } = renderHook(() => useMediaJobs(backend));
    await waitFor(() => expect(result.current.hasOlderJobs).toBe(true));
    expect(result.current.loadedPageCount).toBe(1);
    expect(result.current.unsettledParentCount).toBe(3);

    let firstLoad!: ReturnType<typeof result.current.loadOlderJobs>;
    act(() => {
      firstLoad = result.current.loadOlderJobs();
      void result.current.loadOlderJobs();
    });
    expect(result.current.loadingOlder).toBe(true);
    expect(listMediaJobs).toHaveBeenCalledTimes(2);
    olderPending = false;
    await act(async () => {
      resolveOlder({
        schemaVersion: 1,
        jobs: [boundary, oldest],
        unsettledParentCount: 3,
        nextBeforeUpdatedAt: null,
        nextBeforeJobId: null,
        latestEventId: 1,
        recovery: null,
      });
      await firstLoad;
    });

    expect(result.current.jobs.map(({ id }) => id)).toEqual([newest.id, boundary.id, oldest.id]);
    expect(result.current.unsettledParentCount).toBe(3);
    expect(result.current.loadedPageCount).toBe(2);
    expect(result.current.hasOlderJobs).toBe(false);
    expect(result.current.olderResultAnnouncement).toBe(
      "1 older job loaded. All available jobs are shown.",
    );
    expect(listMediaJobs.mock.calls[1]?.[0]).toMatchObject({
      beforeUpdatedAt: timestamp,
      beforeJobId: boundary.id,
    });

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(listMediaJobs).toHaveBeenCalledTimes(4));
    expect(listMediaJobs.mock.calls[2]?.[0]).toMatchObject({
      beforeUpdatedAt: null,
      beforeJobId: null,
    });
    expect(listMediaJobs.mock.calls[3]?.[0]).toMatchObject({
      beforeUpdatedAt: timestamp,
      beforeJobId: boundary.id,
    });
    expect(result.current.jobs.map(({ id }) => id)).toEqual([newest.id, boundary.id, oldest.id]);
  });

  it("drops jobs absent from an authoritative loaded-depth refresh and disables stale actions", async () => {
    const newest = pagedJob("70000000-0000-4000-8000-000000000099");
    const boundary = pagedJob("70000000-0000-4000-8000-000000000098");
    const removed = {
      ...pagedJob("70000000-0000-4000-8000-000000000097"),
      state: "blocked",
      stage: "blocked",
      error: {
        code: "temporary_preview_failure",
        category: "transient_io",
        message: "Preview preparation needs attention.",
        retryable: true,
        action: "retry",
      },
    } as MediaJobRecord;
    const oldest = pagedJob("70000000-0000-4000-8000-000000000096");
    const replacement = pagedJob("70000000-0000-4000-8000-000000000095");
    let refreshed = false;
    const listMediaJobs = vi.fn<VideoBackend["listMediaJobs"]>((request = {}) => {
      if (request.beforeUpdatedAt === null || request.beforeUpdatedAt === undefined) {
        return Promise.resolve({
          schemaVersion: 1,
          jobs: [newest, boundary],
          unsettledParentCount: 4,
          nextBeforeUpdatedAt: timestamp,
          nextBeforeJobId: boundary.id,
          latestEventId: refreshed ? 2 : 1,
          recovery: null,
        });
      }
      const jobs = refreshed ? [oldest, replacement] : [removed, oldest];
      const pageBoundary = jobs.at(-1)!;
      return Promise.resolve({
        schemaVersion: 1,
        jobs,
        unsettledParentCount: 4,
        nextBeforeUpdatedAt: timestamp,
        nextBeforeJobId: pageBoundary.id,
        latestEventId: refreshed ? 2 : 1,
        recovery: null,
      });
    });
    const backend = mediaBackend({ listMediaJobs });
    const { result } = renderHook(() => useMediaJobs(backend));
    await waitFor(() => expect(result.current.hasOlderJobs).toBe(true));
    await act(() => result.current.loadOlderJobs());

    expect(result.current.loadedPageCount).toBe(2);
    expect(result.current.canCancelJob(removed)).toBe(true);
    expect(result.current.canRetryJob(removed)).toBe(true);

    refreshed = true;
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() =>
      expect(result.current.jobs.map(({ id }) => id)).toEqual([
        newest.id,
        boundary.id,
        oldest.id,
        replacement.id,
      ]),
    );

    expect(result.current.loadedPageCount).toBe(2);
    expect(result.current.nextCursor).toEqual({
      beforeUpdatedAt: timestamp,
      beforeJobId: replacement.id,
    });
    expect(result.current.canCancelJob(removed)).toBe(false);
    expect(result.current.canCancelJob(removed.id)).toBe(false);
    expect(result.current.canRetryJob(removed)).toBe(false);
    expect(result.current.canRetryJob(removed.id)).toBe(false);
    await expect(result.current.cancelJob(removed)).resolves.toBeNull();
    await expect(result.current.retryJob(removed)).resolves.toBeNull();
    expect(backend.cancelMediaJob).not.toHaveBeenCalled();
    expect(backend.retryMediaJob).not.toHaveBeenCalled();
  });

  it("preserves loaded jobs and retries the same cursor after an older-page failure", async () => {
    const newest = pagedJob("70000000-0000-4000-8000-000000000096");
    const oldest = pagedJob("70000000-0000-4000-8000-000000000095");
    let olderAttempt = 0;
    const listMediaJobs = vi.fn<VideoBackend["listMediaJobs"]>((request = {}) => {
      if (request.beforeUpdatedAt === null || request.beforeUpdatedAt === undefined) {
        return Promise.resolve({
          schemaVersion: 1,
          jobs: [newest],
          unsettledParentCount: 2,
          nextBeforeUpdatedAt: timestamp,
          nextBeforeJobId: newest.id,
          latestEventId: 1,
          recovery: null,
        });
      }
      olderAttempt += 1;
      if (olderAttempt === 1) return Promise.reject(new Error("older page unavailable"));
      return Promise.resolve({
        schemaVersion: 1,
        jobs: [oldest],
        unsettledParentCount: 2,
        nextBeforeUpdatedAt: null,
        nextBeforeJobId: null,
        latestEventId: 1,
        recovery: null,
      });
    });
    const backend = mediaBackend({ listMediaJobs });
    const { result } = renderHook(() => useMediaJobs(backend));
    await waitFor(() => expect(result.current.hasOlderJobs).toBe(true));

    await act(() => result.current.loadOlderJobs());
    expect(result.current.olderError?.message).toBe("older page unavailable");
    expect(result.current.jobs.map(({ id }) => id)).toEqual([newest.id]);
    expect(result.current.hasOlderJobs).toBe(true);

    await act(() => result.current.loadOlderJobs());
    expect(result.current.olderError).toBeNull();
    expect(result.current.jobs.map(({ id }) => id)).toEqual([newest.id, oldest.id]);
    expect(listMediaJobs.mock.calls[1]?.[0]).toEqual(listMediaJobs.mock.calls[2]?.[0]);
  });

  it("guards invalid and duplicate actions while refreshing jobs and cache", async () => {
    let finishCancel!: (value: { schemaVersion: 1; job: MediaJobRecord }) => void;
    let finishClear!: (value: Awaited<ReturnType<VideoBackend["clearLegacyMediaCache"]>>) => void;
    const cancelledJob: MediaJobRecord = {
      ...testMediaJob,
      state: "cancelled",
      stage: "cancelled",
      settledAt: timestamp,
      updatedAt: timestamp,
    };
    const clearedStatus: MediaCacheStatus = {
      ...testMediaCacheStatus,
      legacyBytes: 0,
      legacyEntryCount: 0,
      legacyUnsafeEntryCount: 0,
      legacyClearAvailable: false,
    };
    const cancelMediaJob = vi.fn(
      () =>
        new Promise<{ schemaVersion: 1; job: MediaJobRecord }>((resolve) => {
          finishCancel = resolve;
        }),
    );
    const clearLegacyMediaCache = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<VideoBackend["clearLegacyMediaCache"]>>>((resolve) => {
          finishClear = resolve;
        }),
    );
    const backend = mediaBackend({ cancelMediaJob, clearLegacyMediaCache });
    const { result } = renderHook(() => useMediaJobs(backend));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canRetryJob(testMediaJob)).toBe(false);
    await act(() => result.current.retryJob(testMediaJob));
    expect(backend.retryMediaJob).not.toHaveBeenCalled();

    let firstCancel!: ReturnType<typeof result.current.cancelJob>;
    act(() => {
      firstCancel = result.current.cancelJob(testMediaJob);
      void result.current.cancelJob(testMediaJob);
    });
    expect(cancelMediaJob).toHaveBeenCalledOnce();
    expect(result.current.pendingJobIds).toEqual([testMediaJob.id]);
    await act(async () => {
      finishCancel({ schemaVersion: 1, job: cancelledJob });
      await firstCancel;
    });
    expect(result.current.pendingJobIds).toEqual([]);
    expect(result.current.cacheStatus).not.toBeNull();

    let firstClear!: ReturnType<typeof result.current.clearLegacyCache>;
    act(() => {
      firstClear = result.current.clearLegacyCache();
      void result.current.clearLegacyCache();
    });
    expect(clearLegacyMediaCache).toHaveBeenCalledOnce();
    await act(async () => {
      finishClear({
        schemaVersion: 1,
        clearedBytes: testMediaCacheStatus.legacyBytes,
        clearedEntryCount: 1,
        skippedUnsafeEntryCount: 0,
        status: clearedStatus,
      });
      await firstClear;
    });
    expect(result.current.cacheStatus).toEqual(clearedStatus);
    expect(result.current.canClearLegacyCache).toBe(false);
  });

  it("ignores stale cache refreshes that complete out of order", async () => {
    const resolvers: Array<(status: MediaCacheStatus) => void> = [];
    const getMediaCacheStatus = vi.fn(
      () =>
        new Promise<MediaCacheStatus>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const backend = mediaBackend({ getMediaCacheStatus });
    const { result } = renderHook(() => useMediaJobs(backend));
    await waitFor(() => expect(backend.listMediaJobs).toHaveBeenCalledOnce());

    act(() => resolvers[0]!(testMediaCacheStatus));
    await waitFor(() => expect(result.current.cacheStatus).toEqual(testMediaCacheStatus));
    act(() => {
      void result.current.refreshCache();
      void result.current.refreshCache();
    });
    expect(resolvers).toHaveLength(3);
    const newest = { ...testMediaCacheStatus, managedBytes: 6_000_000 };
    const stale = { ...testMediaCacheStatus, managedBytes: 4_000_000 };
    await act(async () => resolvers[2]!(newest));
    await act(async () => resolvers[1]!(stale));
    expect(result.current.cacheStatus?.managedBytes).toBe(6_000_000);
  });
});
