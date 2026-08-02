import type {
  MediaCacheStatus,
  MediaJobEvent,
  MediaJobRecord,
  MediaJobRecoveryReport,
} from "@supa-video/media";
import { useCallback, useEffect, useRef, useState } from "react";

import { tauriVideoBackend, type VideoBackend } from "./video-ipc";

const TERMINAL_JOB_STATES = new Set<MediaJobRecord["state"]>(["cancelled", "failed", "complete"]);
const RETRYABLE_JOB_STATES = new Set<MediaJobRecord["state"]>(["blocked", "failed"]);
const MAX_RETAINED_EVENTS = 500;
const MEDIA_JOB_PAGE_SIZE = 100;

interface MediaJobCursor {
  readonly beforeUpdatedAt: string;
  readonly beforeJobId: string;
}

function compareDurableJobs(left: MediaJobRecord, right: MediaJobRecord): number {
  const timestampOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return timestampOrder === 0 ? right.id.localeCompare(left.id) : timestampOrder;
}

function mergeJobs(
  current: readonly MediaJobRecord[],
  incoming: readonly MediaJobRecord[],
): MediaJobRecord[] {
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) byId.set(job.id, newerJob(byId.get(job.id), job));
  return [...byId.values()].sort(compareDurableJobs);
}

function reconcileAuthoritativeJobs(
  current: readonly MediaJobRecord[],
  incoming: readonly MediaJobRecord[],
): MediaJobRecord[] {
  const incomingIds = new Set(incoming.map((job) => job.id));
  return mergeJobs(
    current.filter((job) => incomingIds.has(job.id)),
    incoming,
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The desktop operation failed unexpectedly");
}

export function canCancelMediaJob(job: MediaJobRecord): boolean {
  return !TERMINAL_JOB_STATES.has(job.state) && !job.cancellationRequested;
}

export function canRetryMediaJob(job: MediaJobRecord): boolean {
  return (
    RETRYABLE_JOB_STATES.has(job.state) &&
    job.error?.retryable === true &&
    !job.cancellationRequested &&
    job.attempt < job.maxAttempts
  );
}

export function canReauthorizeMediaJobOutput(job: MediaJobRecord): boolean {
  return (
    job.kind === "final_render" &&
    job.state === "blocked" &&
    job.error?.category === "output_authorization_required" &&
    job.error.action === "reauthorize_output" &&
    !job.cancellationRequested
  );
}

function mergeEvents(
  current: readonly MediaJobEvent[],
  incoming: readonly MediaJobEvent[],
): MediaJobEvent[] {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  return [...byId.values()]
    .sort((left, right) => left.eventId - right.eventId)
    .slice(-MAX_RETAINED_EVENTS);
}

function newerJob(current: MediaJobRecord | undefined, candidate: MediaJobRecord): MediaJobRecord {
  return current === undefined || Date.parse(candidate.updatedAt) >= Date.parse(current.updatedAt)
    ? candidate
    : current;
}

export interface UseMediaJobsOptions {
  readonly projectId?: string | null;
  readonly includeSettled?: boolean;
}

export function useMediaJobs(
  backend: VideoBackend = tauriVideoBackend,
  options: UseMediaJobsOptions = {},
) {
  const projectId = options.projectId ?? null;
  const includeSettled = options.includeSettled ?? true;
  const [jobs, setJobs] = useState<readonly MediaJobRecord[]>([]);
  const [unsettledParentCount, setUnsettledParentCount] = useState(0);
  const [events, setEvents] = useState<readonly MediaJobEvent[]>([]);
  const [latestEventId, setLatestEventId] = useState(0);
  const [recovery, setRecovery] = useState<MediaJobRecoveryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nextCursor, setNextCursor] = useState<MediaJobCursor | null>(null);
  const [loadedPageCount, setLoadedPageCount] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<Error | null>(null);
  const [olderResultAnnouncement, setOlderResultAnnouncement] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [listenerError, setListenerError] = useState<Error | null>(null);
  const [cacheStatus, setCacheStatus] = useState<MediaCacheStatus | null>(null);
  const [cacheRefreshing, setCacheRefreshing] = useState(false);
  const [cacheError, setCacheError] = useState<Error | null>(null);
  const [pendingJobIds, setPendingJobIds] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [clearingLegacyCache, setClearingLegacyCache] = useState(false);

  const mountedRef = useRef(false);
  const jobsRef = useRef<readonly MediaJobRecord[]>([]);
  const latestEventIdRef = useRef(0);
  const listenerRef = useRef<(() => void) | null>(null);
  const listenerConnectedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const snapshotOperationRef = useRef(0);
  const olderOperationRef = useRef(0);
  const snapshotPendingRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadedPageCountRef = useRef(0);
  const nextCursorRef = useRef<MediaJobCursor | null>(null);
  const eventOperationRef = useRef(0);
  const cacheOperationRef = useRef(0);
  const actionOperationRef = useRef(0);
  const actionOperationsRef = useRef(new Map<string, number>());
  const pendingJobIdsRef = useRef(new Set<string>());
  const clearingLegacyCacheRef = useRef(false);

  const replaceJobs = useCallback((next: readonly MediaJobRecord[]) => {
    const ordered = [...next].sort(compareDurableJobs);
    jobsRef.current = ordered;
    setJobs(ordered);
  }, []);

  const commitEvents = useCallback((incoming: readonly MediaJobEvent[]) => {
    const accepted = incoming
      .filter((event) => event.eventId > latestEventIdRef.current)
      .sort((left, right) => left.eventId - right.eventId);
    if (accepted.length === 0) return;
    setOlderResultAnnouncement("");
    const nextLatest = accepted.at(-1)!.eventId;
    latestEventIdRef.current = nextLatest;
    setLatestEventId(nextLatest);
    setEvents((current) => mergeEvents(current, accepted));
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const lifecycle = lifecycleRef.current;
    const operation = ++snapshotOperationRef.current;
    const requestedPageCount = Math.max(1, loadedPageCountRef.current);
    olderOperationRef.current += 1;
    loadingOlderRef.current = false;
    snapshotPendingRef.current = true;
    setLoadingOlder(false);
    setRefreshing(true);
    try {
      const incoming: MediaJobRecord[] = [];
      let cursor: MediaJobCursor | null = null;
      let latestSnapshotEventId = 0;
      let snapshotRecovery: MediaJobRecoveryReport | null = null;
      let snapshotUnsettledParentCount = 0;
      for (let pageIndex = 0; pageIndex < requestedPageCount; pageIndex += 1) {
        const requestedCursor = cursor;
        const snapshot = await backend.listMediaJobs({
          limit: MEDIA_JOB_PAGE_SIZE,
          includeSettled,
          projectId,
          beforeUpdatedAt: requestedCursor?.beforeUpdatedAt ?? null,
          beforeJobId: requestedCursor?.beforeJobId ?? null,
        });
        if (
          !mountedRef.current ||
          lifecycle !== lifecycleRef.current ||
          operation !== snapshotOperationRef.current
        )
          return;
        incoming.push(...snapshot.jobs);
        snapshotUnsettledParentCount = snapshot.unsettledParentCount;
        latestSnapshotEventId = Math.max(latestSnapshotEventId, snapshot.latestEventId);
        snapshotRecovery ??= snapshot.recovery;
        const returnedCursor =
          snapshot.nextBeforeUpdatedAt === null
            ? null
            : {
                beforeUpdatedAt: snapshot.nextBeforeUpdatedAt,
                beforeJobId: snapshot.nextBeforeJobId!,
              };
        if (
          returnedCursor !== null &&
          requestedCursor !== null &&
          returnedCursor.beforeUpdatedAt === requestedCursor.beforeUpdatedAt &&
          returnedCursor.beforeJobId === requestedCursor.beforeJobId
        ) {
          throw new Error("The desktop service returned a stalled media job page");
        }
        if (returnedCursor !== null && snapshot.jobs.length === 0) {
          throw new Error("The desktop service returned an empty media job page with a cursor");
        }
        cursor = returnedCursor;
        if (cursor === null) break;
      }
      const current = loadedPageCountRef.current === 0 ? [] : jobsRef.current;
      replaceJobs(reconcileAuthoritativeJobs(current, incoming));
      setUnsettledParentCount(snapshotUnsettledParentCount);
      nextCursorRef.current = cursor;
      setNextCursor(cursor);
      loadedPageCountRef.current = requestedPageCount;
      setLoadedPageCount(requestedPageCount);
      setRecovery(snapshotRecovery);
      if (latestSnapshotEventId > latestEventIdRef.current) {
        latestEventIdRef.current = latestSnapshotEventId;
        setLatestEventId(latestSnapshotEventId);
      }
      setOlderError(null);
      setError(null);
      setLoading(false);
    } catch (reason) {
      if (
        mountedRef.current &&
        lifecycle === lifecycleRef.current &&
        operation === snapshotOperationRef.current
      ) {
        setError(asError(reason));
        setLoading(false);
      }
    } finally {
      if (lifecycle === lifecycleRef.current && operation === snapshotOperationRef.current) {
        snapshotPendingRef.current = false;
        if (mountedRef.current) setRefreshing(false);
      }
    }
  }, [backend, includeSettled, projectId, replaceJobs]);

  const loadOlderJobs = useCallback(async () => {
    const requestedCursor = nextCursorRef.current;
    if (requestedCursor === null || loadingOlderRef.current || snapshotPendingRef.current) return 0;
    const lifecycle = lifecycleRef.current;
    const operation = ++olderOperationRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    setOlderResultAnnouncement("");
    try {
      const page = await backend.listMediaJobs({
        limit: MEDIA_JOB_PAGE_SIZE,
        includeSettled,
        projectId,
        beforeUpdatedAt: requestedCursor.beforeUpdatedAt,
        beforeJobId: requestedCursor.beforeJobId,
      });
      if (
        !mountedRef.current ||
        lifecycle !== lifecycleRef.current ||
        operation !== olderOperationRef.current
      )
        return 0;
      const returnedCursor =
        page.nextBeforeUpdatedAt === null
          ? null
          : { beforeUpdatedAt: page.nextBeforeUpdatedAt, beforeJobId: page.nextBeforeJobId! };
      if (
        returnedCursor !== null &&
        returnedCursor.beforeUpdatedAt === requestedCursor.beforeUpdatedAt &&
        returnedCursor.beforeJobId === requestedCursor.beforeJobId
      ) {
        throw new Error("The desktop service returned a stalled media job page");
      }
      if (returnedCursor !== null && page.jobs.length === 0) {
        throw new Error("The desktop service returned an empty media job page with a cursor");
      }
      const existingIds = new Set(jobsRef.current.map((job) => job.id));
      const merged = mergeJobs(jobsRef.current, page.jobs);
      const addedCount = merged.reduce(
        (count, job) => count + (existingIds.has(job.id) ? 0 : 1),
        0,
      );
      replaceJobs(merged);
      setUnsettledParentCount(page.unsettledParentCount);
      nextCursorRef.current = returnedCursor;
      setNextCursor(returnedCursor);
      const nextPageCount = loadedPageCountRef.current + 1;
      loadedPageCountRef.current = nextPageCount;
      setLoadedPageCount(nextPageCount);
      if (page.recovery !== null) setRecovery(page.recovery);
      if (page.latestEventId > latestEventIdRef.current) {
        latestEventIdRef.current = page.latestEventId;
        setLatestEventId(page.latestEventId);
      }
      setOlderResultAnnouncement(
        `${addedCount.toLocaleString()} older ${addedCount === 1 ? "job" : "jobs"} loaded.${returnedCursor === null ? " All available jobs are shown." : ""}`,
      );
      return addedCount;
    } catch (reason) {
      if (
        mountedRef.current &&
        lifecycle === lifecycleRef.current &&
        operation === olderOperationRef.current
      )
        setOlderError(asError(reason));
      return 0;
    } finally {
      if (lifecycle === lifecycleRef.current && operation === olderOperationRef.current) {
        loadingOlderRef.current = false;
        if (mountedRef.current) setLoadingOlder(false);
      }
    }
  }, [backend, includeSettled, projectId, replaceJobs]);

  const refreshCache = useCallback(async () => {
    const lifecycle = lifecycleRef.current;
    const operation = ++cacheOperationRef.current;
    setCacheRefreshing(true);
    try {
      const status = await backend.getMediaCacheStatus();
      if (
        !mountedRef.current ||
        lifecycle !== lifecycleRef.current ||
        operation !== cacheOperationRef.current
      )
        return;
      setCacheStatus(status);
      setCacheError(null);
    } catch (reason) {
      if (
        mountedRef.current &&
        lifecycle === lifecycleRef.current &&
        operation === cacheOperationRef.current
      )
        setCacheError(asError(reason));
    } finally {
      if (
        mountedRef.current &&
        lifecycle === lifecycleRef.current &&
        operation === cacheOperationRef.current
      )
        setCacheRefreshing(false);
    }
  }, [backend]);

  const reconcileDurableEvents = useCallback(async () => {
    const lifecycle = lifecycleRef.current;
    const operation = ++eventOperationRef.current;
    let cursor = latestEventIdRef.current;
    const incoming: MediaJobEvent[] = [];
    try {
      for (;;) {
        const page = await backend.getMediaJobEvents({
          jobId: null,
          afterEventId: cursor,
          limit: 500,
        });
        if (
          !mountedRef.current ||
          lifecycle !== lifecycleRef.current ||
          operation !== eventOperationRef.current
        )
          return;
        const next = page.events
          .filter((event) => event.eventId > cursor)
          .sort((left, right) => left.eventId - right.eventId);
        incoming.push(...next);
        const nextCursor = next.at(-1)?.eventId ?? cursor;
        if (!page.hasMore) break;
        if (nextCursor === cursor)
          throw new Error("The desktop service returned a stalled media event page");
        cursor = nextCursor;
      }
      commitEvents(incoming);
      if (listenerConnectedRef.current) setListenerError(null);
      await refreshSnapshot();
    } catch (reason) {
      if (
        mountedRef.current &&
        lifecycle === lifecycleRef.current &&
        operation === eventOperationRef.current
      ) {
        setError(asError(reason));
        await refreshSnapshot();
      }
    }
  }, [backend, commitEvents, refreshSnapshot]);

  const refresh = useCallback(async () => {
    await Promise.all([reconcileDurableEvents(), refreshCache()]);
  }, [reconcileDurableEvents, refreshCache]);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    mountedRef.current = true;
    snapshotPendingRef.current = false;
    loadingOlderRef.current = false;
    loadedPageCountRef.current = 0;
    nextCursorRef.current = null;
    latestEventIdRef.current = 0;
    replaceJobs([]);
    setUnsettledParentCount(0);
    setEvents([]);
    setLatestEventId(0);
    setRecovery(null);
    setNextCursor(null);
    setLoadedPageCount(0);
    setLoadingOlder(false);
    setOlderError(null);
    setOlderResultAnnouncement("");
    setError(null);
    setLoading(true);
    const handleEvent = (event: MediaJobEvent) => {
      if (!mountedRef.current || lifecycle !== lifecycleRef.current) return;
      if (event.eventId <= latestEventIdRef.current) return;
      void reconcileDurableEvents();
      void refreshCache();
    };
    const handleListenerError = (reason: Error) => {
      if (!mountedRef.current || lifecycle !== lifecycleRef.current) return;
      setListenerError(reason);
      void refresh();
    };
    const handleResume = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    };

    const start = async () => {
      try {
        const unlisten = await backend.listenMediaJobEvents(handleEvent, handleListenerError);
        if (!mountedRef.current || lifecycle !== lifecycleRef.current) {
          unlisten();
          return;
        }
        listenerRef.current = unlisten;
        listenerConnectedRef.current = true;
        setListenerError(null);
      } catch (reason) {
        listenerConnectedRef.current = false;
        if (mountedRef.current && lifecycle === lifecycleRef.current)
          setListenerError(asError(reason));
      }
      if (!mountedRef.current || lifecycle !== lifecycleRef.current) return;
      await Promise.all([refreshSnapshot(), refreshCache()]);
    };

    window.addEventListener("focus", handleResume);
    document.addEventListener("visibilitychange", handleResume);
    void start();

    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      snapshotOperationRef.current += 1;
      olderOperationRef.current += 1;
      eventOperationRef.current += 1;
      cacheOperationRef.current += 1;
      actionOperationRef.current += 1;
      snapshotPendingRef.current = false;
      loadingOlderRef.current = false;
      actionOperationsRef.current.clear();
      listenerRef.current?.();
      listenerRef.current = null;
      listenerConnectedRef.current = false;
      window.removeEventListener("focus", handleResume);
      document.removeEventListener("visibilitychange", handleResume);
    };
  }, [backend, reconcileDurableEvents, refresh, refreshCache, refreshSnapshot, replaceJobs]);

  const findJob = useCallback((jobOrId: MediaJobRecord | string) => {
    const jobId = typeof jobOrId === "string" ? jobOrId : jobOrId.id;
    return jobsRef.current.find((job) => job.id === jobId);
  }, []);

  const canCancelJob = useCallback(
    (jobOrId: MediaJobRecord | string) => {
      const job = findJob(jobOrId);
      return job !== undefined && !pendingJobIdsRef.current.has(job.id) && canCancelMediaJob(job);
    },
    [findJob],
  );

  const canRetryJob = useCallback(
    (jobOrId: MediaJobRecord | string) => {
      const job = findJob(jobOrId);
      return job !== undefined && !pendingJobIdsRef.current.has(job.id) && canRetryMediaJob(job);
    },
    [findJob],
  );

  const canReauthorizeJobOutput = useCallback(
    (jobOrId: MediaJobRecord | string) => {
      const job = findJob(jobOrId);
      return (
        job !== undefined &&
        !pendingJobIdsRef.current.has(job.id) &&
        canReauthorizeMediaJobOutput(job)
      );
    },
    [findJob],
  );

  const runJobAction = useCallback(
    async (kind: "cancel" | "retry" | "reauthorize-output", jobId: string) => {
      const job = jobsRef.current.find((candidate) => candidate.id === jobId);
      const allowed =
        job !== undefined &&
        !pendingJobIdsRef.current.has(jobId) &&
        (kind === "cancel"
          ? canCancelMediaJob(job)
          : kind === "retry"
            ? canRetryMediaJob(job)
            : canReauthorizeMediaJobOutput(job));
      if (!allowed) return null;

      const lifecycle = lifecycleRef.current;
      const operation = ++actionOperationRef.current;
      actionOperationsRef.current.set(jobId, operation);
      pendingJobIdsRef.current.add(jobId);
      setPendingJobIds([...pendingJobIdsRef.current]);
      setActionError(null);
      try {
        let response;
        if (kind === "cancel") {
          response = await backend.cancelMediaJob({ jobId });
        } else if (kind === "retry") {
          response = await backend.retryMediaJob({ jobId });
        } else {
          const outputPath = await backend.pickVideoExportPath("export.mp4");
          if (
            outputPath === null ||
            !mountedRef.current ||
            lifecycle !== lifecycleRef.current ||
            actionOperationsRef.current.get(jobId) !== operation
          )
            return null;
          response = await backend.reauthorizeMediaJobOutput({ jobId, outputPath });
        }
        if (
          !mountedRef.current ||
          lifecycle !== lifecycleRef.current ||
          actionOperationsRef.current.get(jobId) !== operation
        )
          return null;
        replaceJobs(
          jobsRef.current.map((current) =>
            current.id === jobId ? newerJob(current, response.job) : current,
          ),
        );
        await refresh();
        return response.job;
      } catch (reason) {
        if (
          mountedRef.current &&
          lifecycle === lifecycleRef.current &&
          actionOperationsRef.current.get(jobId) === operation
        )
          setActionError(asError(reason));
        return null;
      } finally {
        if (
          lifecycle === lifecycleRef.current &&
          actionOperationsRef.current.get(jobId) === operation
        ) {
          actionOperationsRef.current.delete(jobId);
          pendingJobIdsRef.current.delete(jobId);
          if (mountedRef.current) setPendingJobIds([...pendingJobIdsRef.current]);
        }
      }
    },
    [backend, refresh, replaceJobs],
  );

  const cancelJob = useCallback(
    (jobOrId: MediaJobRecord | string) =>
      runJobAction("cancel", typeof jobOrId === "string" ? jobOrId : jobOrId.id),
    [runJobAction],
  );
  const retryJob = useCallback(
    (jobOrId: MediaJobRecord | string) =>
      runJobAction("retry", typeof jobOrId === "string" ? jobOrId : jobOrId.id),
    [runJobAction],
  );
  const reauthorizeJobOutput = useCallback(
    (jobOrId: MediaJobRecord | string) =>
      runJobAction("reauthorize-output", typeof jobOrId === "string" ? jobOrId : jobOrId.id),
    [runJobAction],
  );

  const clearLegacyCache = useCallback(async () => {
    if (clearingLegacyCacheRef.current || cacheStatus === null || !cacheStatus.legacyClearAvailable)
      return null;
    const lifecycle = lifecycleRef.current;
    const operation = ++cacheOperationRef.current;
    clearingLegacyCacheRef.current = true;
    setClearingLegacyCache(true);
    setCacheError(null);
    try {
      const result = await backend.clearLegacyMediaCache({ confirmed: true });
      if (
        !mountedRef.current ||
        lifecycle !== lifecycleRef.current ||
        operation !== cacheOperationRef.current
      )
        return null;
      setCacheStatus(result.status);
      return result;
    } catch (reason) {
      if (
        mountedRef.current &&
        lifecycle === lifecycleRef.current &&
        operation === cacheOperationRef.current
      )
        setCacheError(asError(reason));
      return null;
    } finally {
      if (lifecycle === lifecycleRef.current) {
        clearingLegacyCacheRef.current = false;
        if (mountedRef.current) setClearingLegacyCache(false);
      }
    }
  }, [backend, cacheStatus]);

  return {
    jobs,
    unsettledParentCount,
    events,
    latestEventId,
    recovery,
    loading,
    refreshing,
    nextCursor,
    loadedPageCount,
    loadingOlder,
    olderError,
    olderResultAnnouncement,
    hasOlderJobs: nextCursor !== null,
    loadOlderJobs,
    error,
    listenerError,
    cacheStatus,
    cacheRefreshing,
    cacheError,
    pendingJobIds,
    actionError,
    clearingLegacyCache,
    canClearLegacyCache: cacheStatus?.legacyClearAvailable === true && !clearingLegacyCache,
    canCancelJob,
    canRetryJob,
    canReauthorizeJobOutput,
    refresh,
    refreshMediaJobs: refresh,
    refreshCache,
    cancelJob,
    cancelMediaJob: cancelJob,
    retryJob,
    retryMediaJob: retryJob,
    reauthorizeJobOutput,
    reauthorizeMediaJobOutput: reauthorizeJobOutput,
    clearLegacyCache,
    clearLegacyMediaCache: clearLegacyCache,
  } as const;
}

export type MediaJobsController = ReturnType<typeof useMediaJobs>;
