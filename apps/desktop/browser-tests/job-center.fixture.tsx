import type { MediaCacheStatus, MediaJobRecord } from "@supa-video/media";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { Film, ListTodo } from "lucide-react";
import { useRef, useState } from "react";
import ReactDOM from "react-dom/client";

import "../src/App.css";
import type { MediaJobsController } from "../src/use-media-jobs";
import { JobCenter } from "../src/video/JobCenter";

const timestamp = "2026-07-26T12:00:00.000Z";
const later = "2026-07-26T12:00:04.000Z";
const parentId = "70000000-0000-4000-8000-000000000080";

function record(overrides: Partial<MediaJobRecord>): MediaJobRecord {
  return {
    schemaVersion: 1,
    id: parentId,
    kind: "asset_preparation",
    parentId: null,
    projectId: "70000000-0000-4000-8000-000000000001",
    assetId: "70000000-0000-4000-8000-000000000081",
    revisionId: "revision-42",
    priority: "interactive",
    state: "running",
    stage: "building_preview_media",
    progress: { completed: 1, total: 2, unit: "stages" },
    attempt: 1,
    maxAttempts: 3,
    summary: `Prepare preview for launch-film-${"long-localized-name-".repeat(4)}.mov`,
    error: null,
    retryAt: null,
    createdAt: timestamp,
    updatedAt: later,
    startedAt: timestamp,
    settledAt: null,
    cancellationRequested: false,
    resultAvailable: false,
    ...overrides,
  } as MediaJobRecord;
}

const jobs: readonly MediaJobRecord[] = [
  record({}),
  record({
    id: "70000000-0000-4000-8000-000000000082",
    kind: "proxy",
    parentId,
    state: "complete",
    stage: "cache_hit",
    progress: { completed: 1, total: 1, unit: "items" },
    summary: "Build proxy video",
    settledAt: later,
    resultAvailable: true,
  }),
  record({
    id: "70000000-0000-4000-8000-000000000083",
    kind: "thumbnail_tile",
    parentId,
    stage: "extracting_frames",
    progress: { completed: 18, total: 40, unit: "frames" },
    summary: "Build thumbnail strip",
  }),
  record({
    id: "70000000-0000-4000-8000-000000000084",
    kind: "final_render",
    priority: "export",
    state: "blocked",
    stage: "awaiting_output_authorization",
    progress: { completed: 0, total: 240, unit: "frames" },
    summary: "Export current saved revision",
    error: {
      code: "output_grant_required",
      category: "output_authorization_required",
      message: "Fresh destination authorization is required after restart.",
      retryable: true,
      action: "reauthorize_output",
    },
  }),
];

const olderJob = record({
  id: "70000000-0000-4000-8000-000000000079",
  kind: "final_render",
  priority: "export",
  state: "complete",
  stage: "complete",
  progress: { completed: 240, total: 240, unit: "frames" },
  summary: `Archived export ${"with-a-long-localized-title-".repeat(5)}`,
  settledAt: later,
  resultAvailable: true,
});

const initialCache: MediaCacheStatus = {
  schemaVersion: 1,
  budgetBytes: 20 * 1_024 ** 3,
  managedBytes: 22 * 1_024 ** 3,
  leasedBytes: 22 * 1_024 ** 3,
  reclaimableBytes: 0,
  artifactCount: 14,
  leasedArtifactCount: 14,
  pressure: "pinned",
  legacyBytes: 384 * 1_024 ** 2,
  legacyEntryCount: 26,
  legacyUnsafeEntryCount: 1,
  legacyClearAvailable: true,
  recoveryWarning: "The cache catalog was rebuilt from verified owned media.",
  refreshedAt: later,
};

function Fixture() {
  const [open, setOpen] = useState(true);
  const [cacheStatus, setCacheStatus] = useState(initialCache);
  const [clearing, setClearing] = useState(false);
  const paginationModeRef = useRef(
    new URLSearchParams(window.location.search).get("pagination") ?? "ready",
  );
  const paginationMode = paginationModeRef.current;
  const [visibleJobs, setVisibleJobs] = useState<readonly MediaJobRecord[]>(
    paginationMode === "empty"
      ? []
      : paginationMode === "children-only"
        ? jobs.filter((job) => job.parentId !== null)
        : jobs,
  );
  const [hasOlderJobs, setHasOlderJobs] = useState(
    paginationMode !== "empty" && paginationMode !== "no-more",
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<Error | null>(null);
  const [olderResultAnnouncement, setOlderResultAnnouncement] = useState("");
  const [loadedPageCount, setLoadedPageCount] = useState(1);
  const olderAttemptRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    queueMicrotask(() => toggleRef.current?.focus());
  };
  const loadOlderJobs = async () => {
    if (!hasOlderJobs || loadingOlderRef.current) return 0;
    loadingOlderRef.current = true;
    olderAttemptRef.current += 1;
    setLoadingOlder(true);
    setOlderError(null);
    setOlderResultAnnouncement("");
    await new Promise((resolve) => setTimeout(resolve, paginationMode === "pending" ? 300 : 60));
    if (paginationMode === "failure" && olderAttemptRef.current === 1) {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      setOlderError(new Error("Older fixture page unavailable"));
      return 0;
    }
    const fetchedJobs =
      paginationMode === "children-only" ? jobs.filter((job) => job.id === parentId) : [olderJob];
    setVisibleJobs((current) =>
      [...new Map([...current, ...fetchedJobs].map((job) => [job.id, job])).values()].sort(
        (left, right) => {
          const timestampOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
          return timestampOrder === 0 ? right.id.localeCompare(left.id) : timestampOrder;
        },
      ),
    );
    setHasOlderJobs(false);
    setLoadedPageCount((count) => count + 1);
    setOlderResultAnnouncement("1 older job loaded. All available jobs are shown.");
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    return 1;
  };

  const controller = {
    jobs: visibleJobs,
    unsettledParentCount: 2,
    events: [],
    latestEventId: 4,
    recovery: {
      schemaVersion: 1,
      requeuedCount: 1,
      blockedCount: 1,
      cancelledCount: 0,
      staleLeaseCount: 2,
      databaseRecovered: true,
      warning: "Local job metadata recovered safely. Project files were not changed.",
      recoveredAt: later,
    },
    loading: false,
    refreshing: false,
    nextCursor: hasOlderJobs ? { beforeUpdatedAt: later, beforeJobId: parentId } : null,
    loadedPageCount,
    loadingOlder,
    olderError,
    olderResultAnnouncement,
    hasOlderJobs,
    loadOlderJobs,
    error: null,
    listenerError: null,
    cacheStatus,
    cacheRefreshing: false,
    cacheError: null,
    pendingJobIds: [],
    actionError: null,
    clearingLegacyCache: clearing,
    canClearLegacyCache: cacheStatus.legacyClearAvailable && !clearing,
    canCancelJob: () => true,
    canRetryJob: () => true,
    refresh: async () => undefined,
    refreshMediaJobs: async () => undefined,
    refreshCache: async () => undefined,
    cancelJob: async () => null,
    cancelMediaJob: async () => null,
    retryJob: async () => null,
    retryMediaJob: async () => null,
    clearLegacyCache: async () => {
      setClearing(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const status = {
        ...cacheStatus,
        legacyBytes: 0,
        legacyEntryCount: 0,
        legacyUnsafeEntryCount: 0,
        legacyClearAvailable: false,
      };
      setCacheStatus(status);
      setClearing(false);
      return {
        schemaVersion: 1 as const,
        clearedBytes: cacheStatus.legacyBytes,
        clearedEntryCount: cacheStatus.legacyEntryCount,
        skippedUnsafeEntryCount: cacheStatus.legacyUnsafeEntryCount,
        status,
      };
    },
    clearLegacyMediaCache: async () => null,
  } as MediaJobsController;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner shared-rail">
          <a className="brand" href="#job-center" aria-label="Supa Video Producer home">
            <span className="brand-mark" aria-hidden>
              <Film size={18} />
            </span>
            <span>Supa Video Producer</span>
          </a>
          <div className="app-header-actions">
            <span className="phase-label">Phase 3B · Durable media jobs</span>
            <button
              ref={toggleRef}
              className="jobs-toggle"
              type="button"
              aria-expanded={open}
              aria-controls="job-center"
              onClick={() => (open ? close() : setOpen(true))}
            >
              <ListTodo size={17} aria-hidden />
              <span>Jobs</span>
              <span className="jobs-count" aria-hidden>
                2
              </span>
              <span className="sr-only">2 unsettled jobs</span>
            </button>
          </div>
        </div>
      </header>
      {open ? <JobCenter controller={controller} onClose={close} /> : null}
      <main className="shared-rail" style={{ paddingBlock: 24 }}>
        <h1 style={{ fontSize: "1rem" }}>Browser evidence fixture</h1>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
