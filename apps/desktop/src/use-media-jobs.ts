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
  const [events, setEvents] = useState<readonly MediaJobEvent[]>([]);
  const [latestEventId, setLatestEventId] = useState(0);
  const [recovery, setRecovery] = useState<MediaJobRecoveryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
  const eventOperationRef = useRef(0);
  const cacheOperationRef = useRef(0);
  const actionOperationRef = useRef(0);
  const actionOperationsRef = useRef(new Map<string, number>());
  const pendingJobIdsRef = useRef(new Set<string>());
  const clearingLegacyCacheRef = useRef(false);

  const replaceJobs = useCallback((next: readonly MediaJobRecord[]) => {
    jobsRef.current = next;
    setJobs(next);
  }, []);

  const commitEvents = useCallback((incoming: readonly MediaJobEvent[]) => {
    const accepted = incoming
      .filter((event) => event.eventId > latestEventIdRef.current)
      .sort((left, right) => left.eventId - right.eventId);
    if (accepted.length === 0) return;
    const nextLatest = accepted.at(-1)!.eventId;
    latestEventIdRef.current = nextLatest;
    setLatestEventId(nextLatest);
    setEvents((current) => mergeEvents(current, accepted));
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const lifecycle = lifecycleRef.current;
    const operation = ++snapshotOperationRef.current;
    setRefreshing(true);
    try {
      const snapshot = await backend.listMediaJobs({
        limit: 100,
        includeSettled,
        projectId,
        beforeUpdatedAt: null,
      });
      if (
        !mountedRef.current ||
        lifecycle !== lifecycleRef.current ||
        operation !== snapshotOperationRef.current
      )
        return;
      replaceJobs(snapshot.jobs);
      setRecovery(snapshot.recovery);
      if (snapshot.latestEventId > latestEventIdRef.current) {
        latestEventIdRef.current = snapshot.latestEventId;
        setLatestEventId(snapshot.latestEventId);
      }
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
      if (
        mountedRef.current &&
        lifecycle === lifecycleRef.current &&
        operation === snapshotOperationRef.current
      )
        setRefreshing(false);
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
      eventOperationRef.current += 1;
      cacheOperationRef.current += 1;
      actionOperationRef.current += 1;
      actionOperationsRef.current.clear();
      listenerRef.current?.();
      listenerRef.current = null;
      listenerConnectedRef.current = false;
      window.removeEventListener("focus", handleResume);
      document.removeEventListener("visibilitychange", handleResume);
    };
  }, [backend, reconcileDurableEvents, refresh, refreshCache, refreshSnapshot]);

  const findJob = useCallback(
    (jobOrId: MediaJobRecord | string) =>
      typeof jobOrId === "string"
        ? jobsRef.current.find((job) => job.id === jobOrId)
        : (jobsRef.current.find((job) => job.id === jobOrId.id) ?? jobOrId),
    [],
  );

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

  const runJobAction = useCallback(
    async (kind: "cancel" | "retry", jobId: string) => {
      const job = jobsRef.current.find((candidate) => candidate.id === jobId);
      const allowed =
        job !== undefined &&
        !pendingJobIdsRef.current.has(jobId) &&
        (kind === "cancel" ? canCancelMediaJob(job) : canRetryMediaJob(job));
      if (!allowed) return null;

      const lifecycle = lifecycleRef.current;
      const operation = ++actionOperationRef.current;
      actionOperationsRef.current.set(jobId, operation);
      pendingJobIdsRef.current.add(jobId);
      setPendingJobIds([...pendingJobIdsRef.current]);
      setActionError(null);
      try {
        const response = await (kind === "cancel"
          ? backend.cancelMediaJob({ jobId })
          : backend.retryMediaJob({ jobId }));
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
    events,
    latestEventId,
    recovery,
    loading,
    refreshing,
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
    refresh,
    refreshMediaJobs: refresh,
    refreshCache,
    cancelJob,
    cancelMediaJob: cancelJob,
    retryJob,
    retryMediaJob: retryJob,
    clearLegacyCache,
    clearLegacyMediaCache: clearLegacyCache,
  } as const;
}

export type MediaJobsController = ReturnType<typeof useMediaJobs>;
