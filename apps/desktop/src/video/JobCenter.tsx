import type { MediaCacheStatus, MediaJobRecord } from "@supa-video/media";
import {
  AlertCircle,
  AlertTriangle,
  ListTodo,
  RefreshCw,
  RotateCcw,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { canCancelMediaJob, canRetryMediaJob, type MediaJobsController } from "../use-media-jobs";
import { MediaJobStateIcon, mediaJobStateLabels } from "./MediaJobStatus";
interface JobCenterProps {
  readonly controller: MediaJobsController;
  readonly focusJobId?: string | null;
  readonly onClose: () => void;
}

const terminalStates = new Set<MediaJobRecord["state"]>(["cancelled", "failed", "complete"]);
const kindLabels: Record<MediaJobRecord["kind"], string> = {
  asset_preparation: "Preview preparation",
  proxy: "Proxy video",
  thumbnail_tile: "Thumbnail strip",
  final_render: "Final export",
};
const recoveryActionLabels = {
  reauthorize_source: "Choose the source again, then retry.",
  reauthorize_output: "Choose the export destination again, then retry.",
  verify_toolchain: "Repair the bundled media tools, then retry.",
  free_cache: "Close media using the cache or clear available space, then retry.",
  retry: "Retry the job when the issue is resolved.",
} as const;

function safePublicText(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const containsPrivatePath =
    /(?:\b[a-z]:[\\/]|\\\\|file:\/\/|(?:^|\s)\/(?:users|home|var|tmp|volumes|mnt|media|opt|srv)(?:\/|\s|$))/i.test(
      normalized,
    );
  const containsRawData = /(?:\b[0-9a-f]{32,}\b|(?:\\x[0-9a-f]{2}){4,})/i.test(normalized);
  return containsPrivatePath || containsRawData ? fallback : normalized;
}

function jobSummary(job: MediaJobRecord): string {
  return safePublicText(job.summary, kindLabels[job.kind]);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes.toLocaleString()} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1_024;
  let unit: (typeof units)[number] = units[0];
  for (const nextUnit of units.slice(1)) {
    if (value < 1_024) break;
    value /= 1_024;
    unit = nextUnit;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}

function formatProgress(job: MediaJobRecord): string {
  const { completed, total, unit } = job.progress;
  if (total === 0) return "Progress unavailable";
  if (unit === "bytes") return `${formatBytes(completed)} of ${formatBytes(total)}`;
  const unitLabel = unit === "microseconds" ? "time units" : unit;
  return `${completed.toLocaleString()} of ${total.toLocaleString()} ${unitLabel}`;
}

function formatStage(stage: string): string {
  return stage.replaceAll("_", " ");
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function JobProgress({
  job,
  compact = false,
}: {
  readonly job: MediaJobRecord;
  readonly compact?: boolean;
}) {
  const label = `${jobSummary(job)}: ${formatProgress(job)}`;
  return (
    <div className={compact ? "job-progress is-compact" : "job-progress"}>
      <progress
        aria-label={label}
        max={job.progress.total || undefined}
        value={job.progress.total > 0 ? job.progress.completed : undefined}
      />
      <span>{formatProgress(job)}</span>
    </div>
  );
}

function JobItem({
  job,
  children,
  controller,
  focused,
  focusRef,
}: {
  readonly job: MediaJobRecord;
  readonly children: readonly MediaJobRecord[];
  readonly controller: MediaJobsController;
  readonly focused: boolean;
  readonly focusRef: React.Ref<HTMLElement> | null;
}) {
  const pending = controller.pendingJobIds.includes(job.id);
  const summary = jobSummary(job);
  const showCancel = !terminalStates.has(job.state);
  const showRetry =
    canRetryMediaJob(job) || (pending && (job.state === "blocked" || job.state === "failed"));
  const error =
    job.state === "blocked" || job.state === "retrying" || job.state === "failed"
      ? job.error
      : null;

  return (
    <li className={`job-item job-state-${job.state}${focused ? " is-targeted" : ""}`}>
      <article
        ref={focusRef}
        tabIndex={focused ? -1 : undefined}
        aria-labelledby={`job-${job.id}-title`}
      >
        <div className="job-item-heading">
          <div className="job-item-identity">
            <p className="job-kind">{kindLabels[job.kind]}</p>
            <h3 id={`job-${job.id}-title`}>{summary}</h3>
          </div>
          <span className="job-state-label">
            <MediaJobStateIcon state={job.state} />
            {job.cancellationRequested ? "Cancelling" : mediaJobStateLabels[job.state]}
          </span>
        </div>

        <div className="job-item-meta">
          <span>{formatStage(job.stage)}</span>
          <span aria-hidden>•</span>
          <span>
            Attempt {job.attempt + 1} of {job.maxAttempts}
          </span>
          <span aria-hidden>•</span>
          <span>Updated {formatTime(job.updatedAt)}</span>
        </div>

        <JobProgress job={job} />

        {error !== null ? (
          <div className="job-message" role={job.state === "failed" ? "alert" : "status"}>
            <strong>{safePublicText(error.message, "The media job needs attention.")}</strong>
            {error.action !== null ? <p>{recoveryActionLabels[error.action]}</p> : null}
            {job.state === "retrying" && job.retryAt !== null ? (
              <p>Next attempt at {formatTime(job.retryAt)}.</p>
            ) : null}
          </div>
        ) : null}

        {children.length > 0 ? (
          <div className="job-stages">
            <p>Stages</p>
            <ul>
              {children.map((child) => (
                <li key={child.id}>
                  <div>
                    <span>{kindLabels[child.kind]}</span>
                    <span className="job-child-state">{mediaJobStateLabels[child.state]}</span>
                  </div>
                  <JobProgress job={child} compact />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {showCancel || showRetry ? (
          <div className="job-actions">
            {showRetry ? (
              <button
                className="secondary-button compact-button"
                type="button"
                disabled={pending || !canRetryMediaJob(job)}
                onClick={() => void controller.retryJob(job)}
              >
                <RotateCcw size={16} aria-hidden />
                {pending ? "Retrying" : "Retry"}
              </button>
            ) : null}
            {showCancel ? (
              <button
                className="secondary-button compact-button"
                type="button"
                disabled={pending || !canCancelMediaJob(job)}
                onClick={() => void controller.cancelJob(job)}
              >
                <X size={16} aria-hidden />
                {pending || job.cancellationRequested ? "Cancelling" : "Cancel"}
              </button>
            ) : null}
          </div>
        ) : null}
      </article>
    </li>
  );
}

function CacheHealth({
  status,
  controller,
  onRequestLegacyClear,
}: {
  readonly status: MediaCacheStatus | null;
  readonly controller: MediaJobsController;
  readonly onRequestLegacyClear: (trigger: HTMLButtonElement) => void;
}) {
  if (status === null) {
    return (
      <section className="cache-health" aria-labelledby="cache-health-title" aria-busy="true">
        <div className="cache-health-heading">
          <div>
            <p className="state-kicker">Local storage</p>
            <h3 id="cache-health-title">Cache health</h3>
          </div>
          <span className="spinner" aria-hidden />
        </div>
        <p className="job-center-guidance">Measuring managed and legacy media cache usage.</p>
      </section>
    );
  }

  const pressureCopy =
    status.pressure === "pinned"
      ? "Cache is over budget, but active media is pinning every reclaimable item. Background work may pause."
      : status.pressure === "over_budget"
        ? "Cache is over budget. Unused managed media will be reclaimed automatically."
        : "Managed media is within the local cache budget.";

  return (
    <section className="cache-health" aria-labelledby="cache-health-title">
      <div className="cache-health-heading">
        <div>
          <p className="state-kicker">Local storage</p>
          <h3 id="cache-health-title">Cache health</h3>
        </div>
        <span className={`cache-pressure cache-pressure-${status.pressure}`}>
          {status.pressure === "normal"
            ? "Within budget"
            : status.pressure === "pinned"
              ? "Pinned pressure"
              : "Over budget"}
        </span>
      </div>

      <div className="cache-meter">
        <div>
          <span>{formatBytes(status.managedBytes)} managed</span>
          <span>{formatBytes(status.budgetBytes)} budget</span>
        </div>
        <progress
          aria-label={`Managed cache usage: ${formatBytes(status.managedBytes)} of ${formatBytes(status.budgetBytes)}`}
          max={Math.max(status.budgetBytes, status.managedBytes, 1)}
          value={status.managedBytes}
        />
      </div>

      <p
        className={status.pressure === "normal" ? "job-center-guidance" : "cache-pressure-message"}
      >
        {pressureCopy}
      </p>
      <dl className="cache-facts">
        <div>
          <dt>Active leases</dt>
          <dd>
            {status.leasedArtifactCount.toLocaleString()} items · {formatBytes(status.leasedBytes)}
          </dd>
        </div>
        <div>
          <dt>Reclaimable</dt>
          <dd>{formatBytes(status.reclaimableBytes)}</dd>
        </div>
        <div>
          <dt>Managed items</dt>
          <dd>{status.artifactCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Legacy cache</dt>
          <dd>
            {formatBytes(status.legacyBytes)} · {status.legacyEntryCount.toLocaleString()} items
          </dd>
        </div>
      </dl>

      {status.recoveryWarning !== null ? (
        <div className="job-center-notice is-warning" role="status">
          <AlertTriangle size={18} aria-hidden />
          <div>
            <strong>Cache catalog recovered</strong>
            <p>
              {safePublicText(
                status.recoveryWarning,
                "The local cache catalog was recovered safely.",
              )}
            </p>
          </div>
        </div>
      ) : null}

      <div className="legacy-cache-action">
        <div>
          <strong>Legacy preview cache</strong>
          <p>
            This older unmanaged cache is never removed automatically.
            {status.legacyUnsafeEntryCount > 0
              ? ` ${status.legacyUnsafeEntryCount.toLocaleString()} unsafe entries will be skipped.`
              : ""}
          </p>
        </div>
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={!controller.canClearLegacyCache}
          onClick={(event) => onRequestLegacyClear(event.currentTarget)}
        >
          <Trash2 size={16} aria-hidden />
          {controller.clearingLegacyCache
            ? "Clearing legacy cache"
            : status.legacyClearAvailable
              ? "Clear legacy preview cache"
              : "Legacy cache empty"}
        </button>
      </div>
    </section>
  );
}

export function JobCenter({ controller, focusJobId = null, onClose }: JobCenterProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const focusedJobRef = useRef<HTMLElement>(null);
  const focusAppliedRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepCacheRef = useRef<HTMLButtonElement>(null);
  const legacyButtonRef = useRef<HTMLElement | null>(null);
  const paginationStatusRef = useRef<HTMLParagraphElement>(null);
  const paginationKeyboardActivationRef = useRef(false);
  const previousLoadingOlderRef = useRef(controller.loadingOlder);
  const [legacyDialogOpen, setLegacyDialogOpen] = useState(false);

  const parentJobs = useMemo(
    () => controller.jobs.filter((job) => job.parentId === null),
    [controller.jobs],
  );
  const childrenByParent = useMemo(() => {
    const children = new Map<string, MediaJobRecord[]>();
    for (const job of controller.jobs) {
      if (job.parentId === null) continue;
      const group = children.get(job.parentId) ?? [];
      group.push(job);
      children.set(job.parentId, group);
    }
    return children;
  }, [controller.jobs]);
  const hasOnlyChildJobs = parentJobs.length === 0 && controller.jobs.length > 0;

  const announcement = useMemo(() => {
    if (controller.olderResultAnnouncement !== "") return controller.olderResultAnnouncement;
    const event = [...controller.events]
      .reverse()
      .find((candidate) => candidate.eventType !== "progress");
    if (event === undefined) return "";
    const job = controller.jobs.find((candidate) => candidate.id === event.jobId);
    return `${job === undefined ? "Media job" : jobSummary(job)}: ${mediaJobStateLabels[event.state]}.`;
  }, [controller.events, controller.jobs, controller.olderResultAnnouncement]);

  useEffect(() => {
    focusAppliedRef.current = false;
  }, [focusJobId]);

  useEffect(() => {
    if (focusAppliedRef.current) return;
    if (focusJobId === null) {
      closeRef.current?.focus();
      focusAppliedRef.current = true;
      return;
    }
    if (controller.loading) return;
    (focusedJobRef.current ?? closeRef.current)?.focus();
    focusAppliedRef.current = true;
  }, [controller.loading, focusJobId, parentJobs]);

  useEffect(() => {
    const wasLoadingOlder = previousLoadingOlderRef.current;
    previousLoadingOlderRef.current = controller.loadingOlder;
    if (
      wasLoadingOlder &&
      !controller.loadingOlder &&
      !controller.hasOlderJobs &&
      controller.olderError === null &&
      paginationKeyboardActivationRef.current
    ) {
      queueMicrotask(() => paginationStatusRef.current?.focus());
    }
    if (!controller.loadingOlder) paginationKeyboardActivationRef.current = false;
  }, [controller.hasOlderJobs, controller.loadingOlder, controller.olderError]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (legacyDialogOpen && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      keepCacheRef.current?.focus();
    } else if (!legacyDialogOpen && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [legacyDialogOpen]);

  const closeLegacyDialog = useCallback(() => {
    setLegacyDialogOpen(false);
    queueMicrotask(() => legacyButtonRef.current?.focus());
  }, []);

  const requestLegacyClear = useCallback((trigger: HTMLButtonElement) => {
    legacyButtonRef.current = trigger;
    setLegacyDialogOpen(true);
  }, []);

  const confirmLegacyClear = useCallback(async () => {
    const result = await controller.clearLegacyCache();
    if (result !== null) closeLegacyDialog();
  }, [closeLegacyDialog, controller]);

  const recovery = controller.recovery;
  const hasRecoveryNotice =
    recovery !== null &&
    (recovery.databaseRecovered ||
      recovery.requeuedCount > 0 ||
      recovery.blockedCount > 0 ||
      recovery.warning !== null);

  return (
    <section
      id="job-center"
      className="job-center"
      aria-labelledby="job-center-title"
      aria-busy={controller.loading || controller.refreshing || controller.loadingOlder}
    >
      <div className="job-center-inner shared-rail">
        <div className="job-center-heading">
          <div>
            <p className="state-kicker">Durable media work</p>
            <h2 id="job-center-title">Job Center</h2>
            <p className="job-center-guidance">
              Track preview preparation and exports across projects and app restarts.
            </p>
          </div>
          <div className="job-center-heading-actions">
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={controller.refreshing || controller.cacheRefreshing}
              onClick={() => void controller.refresh()}
            >
              <RefreshCw size={16} aria-hidden />
              {controller.refreshing || controller.cacheRefreshing ? "Refreshing" : "Refresh"}
            </button>
            <button
              ref={closeRef}
              className="secondary-button compact-button"
              type="button"
              onClick={onClose}
            >
              <X size={16} aria-hidden />
              Close
            </button>
          </div>
        </div>

        {controller.listenerError !== null ? (
          <div className="job-center-notice is-warning" role="status">
            <WifiOff size={18} aria-hidden />
            <div>
              <strong>Live job updates disconnected</strong>
              <p>Job Center is using durable snapshots. Refresh to check for the latest state.</p>
            </div>
          </div>
        ) : null}
        {controller.error !== null ? (
          <div className="job-center-notice is-error" role="alert">
            <AlertCircle size={18} aria-hidden />
            <div>
              <strong>Could not load media jobs</strong>
              <p>Existing work is still durable. Refresh to reconnect to the desktop service.</p>
            </div>
          </div>
        ) : null}
        {controller.actionError !== null ? (
          <div className="job-center-notice is-error" role="alert">
            <AlertCircle size={18} aria-hidden />
            <div>
              <strong>Job action did not finish</strong>
              <p>The saved job state was preserved. Refresh before trying again.</p>
            </div>
          </div>
        ) : null}
        {controller.cacheError !== null ? (
          <div className="job-center-notice is-error" role="alert">
            <AlertCircle size={18} aria-hidden />
            <div>
              <strong>Could not update cache health</strong>
              <p>No cache content was changed. Refresh to try again.</p>
            </div>
          </div>
        ) : null}
        {hasRecoveryNotice && recovery !== null ? (
          <div className="job-center-notice is-warning" role="status">
            <AlertTriangle size={18} aria-hidden />
            <div>
              <strong>
                {recovery.databaseRecovered
                  ? "Job database recovered"
                  : "Media work recovered after restart"}
              </strong>
              <p>
                {recovery.warning === null
                  ? `${recovery.requeuedCount.toLocaleString()} jobs resumed; ${recovery.blockedCount.toLocaleString()} need attention.`
                  : safePublicText(recovery.warning, "Local media work was recovered safely.")}
              </p>
            </div>
          </div>
        ) : null}

        <div className="job-center-grid">
          <section className="job-ledger" aria-labelledby="job-ledger-title">
            <div className="job-ledger-heading">
              <div>
                <p className="state-kicker">Production ledger</p>
                <h3 id="job-ledger-title">Recent jobs</h3>
              </div>
              <span>{parentJobs.length.toLocaleString()} shown</span>
            </div>

            {controller.loading ? (
              <div className="job-center-empty" role="status">
                <span className="spinner" aria-hidden />
                <strong>Loading durable jobs</strong>
                <p>Connecting to the local media ledger.</p>
              </div>
            ) : hasOnlyChildJobs ? (
              <div className="job-center-empty">
                <ListTodo size={22} aria-hidden />
                <strong>
                  {controller.hasOlderJobs
                    ? "Parent jobs are not loaded yet"
                    : "Parent jobs are unavailable"}
                </strong>
                <p>
                  {controller.hasOlderJobs
                    ? "This page contains preparation stages."
                    : "Preparation stages are loaded, but their parent jobs are not available."}
                </p>
              </div>
            ) : parentJobs.length === 0 ? (
              <div className="job-center-empty">
                <ListTodo size={22} aria-hidden />
                <strong>No media jobs yet</strong>
                <p>
                  Preview preparation and exports will appear here, even when no project is open.
                </p>
              </div>
            ) : (
              <ol className="job-list">
                {parentJobs.map((job) => (
                  <JobItem
                    key={job.id}
                    job={job}
                    children={childrenByParent.get(job.id) ?? []}
                    controller={controller}
                    focused={job.id === focusJobId}
                    focusRef={job.id === focusJobId ? focusedJobRef : null}
                  />
                ))}
              </ol>
            )}

            {!controller.loading && (parentJobs.length > 0 || controller.hasOlderJobs) ? (
              <div className="job-ledger-pagination">
                {controller.olderError !== null ? (
                  <p id="older-jobs-error" className="job-ledger-pagination-error" role="alert">
                    Older jobs could not be loaded. The jobs already shown are unchanged.
                  </p>
                ) : null}
                <button
                  className="secondary-button compact-button"
                  type="button"
                  disabled={controller.loadingOlder || !controller.hasOlderJobs}
                  aria-describedby={controller.olderError === null ? undefined : "older-jobs-error"}
                  onClick={(event) => {
                    paginationKeyboardActivationRef.current = event.detail === 0;
                    void controller.loadOlderJobs();
                  }}
                >
                  {controller.loadingOlder
                    ? "Loading older jobs"
                    : controller.hasOlderJobs
                      ? controller.olderError === null
                        ? hasOnlyChildJobs
                          ? "Load older work to show parent jobs"
                          : "Load older jobs"
                        : "Retry loading older jobs"
                      : "All jobs loaded"}
                </button>
                {!controller.hasOlderJobs ? (
                  <p
                    ref={paginationStatusRef}
                    className="job-ledger-pagination-status"
                    tabIndex={-1}
                  >
                    All available jobs are shown.
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>

          <CacheHealth
            status={controller.cacheStatus}
            controller={controller}
            onRequestLegacyClear={requestLegacyClear}
          />
        </div>

        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      </div>

      <dialog
        ref={dialogRef}
        className="overwrite-dialog legacy-cache-dialog"
        aria-labelledby="legacy-cache-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          closeLegacyDialog();
        }}
        onClose={() => legacyButtonRef.current?.focus()}
      >
        <Trash2 size={22} aria-hidden />
        <h2 id="legacy-cache-dialog-title">Clear legacy preview cache?</h2>
        <p>
          This permanently removes {formatBytes(controller.cacheStatus?.legacyBytes ?? 0)} of older
          preview files. Current projects and managed media stay unchanged. Unsafe entries are
          skipped.
        </p>
        {controller.cacheError !== null ? (
          <p className="dialog-error" role="alert">
            Legacy cache was not cleared. Keep the cache or try again.
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            ref={keepCacheRef}
            className="secondary-button"
            type="button"
            onClick={closeLegacyDialog}
          >
            Keep legacy cache
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={controller.clearingLegacyCache}
            onClick={() => void confirmLegacyClear()}
          >
            {controller.clearingLegacyCache ? "Clearing legacy cache" : "Clear legacy cache"}
          </button>
        </div>
      </dialog>
    </section>
  );
}
