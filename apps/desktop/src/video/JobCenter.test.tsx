// @vitest-environment jsdom

import type { MediaCacheStatus, MediaJobRecord, MediaJobRecoveryReport } from "@supa-video/media";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testMediaCacheStatus, testMediaJob } from "../test-video-service";
import type { MediaJobsController } from "../use-media-jobs";
import { JobCenter } from "./JobCenter";

const later = "2026-07-26T12:00:01.000Z";

function job(overrides: Partial<MediaJobRecord>): MediaJobRecord {
  return { ...testMediaJob, ...overrides } as MediaJobRecord;
}

const proxyChild = job({
  id: "70000000-0000-4000-8000-000000000082",
  kind: "proxy",
  parentId: testMediaJob.id,
  state: "complete",
  stage: "cache_hit",
  progress: { completed: 1, total: 1, unit: "items" },
  summary: "Build preview proxy",
  startedAt: later,
  settledAt: later,
  updatedAt: later,
  resultAvailable: true,
});
const thumbnailChild = job({
  id: "70000000-0000-4000-8000-000000000083",
  kind: "thumbnail_tile",
  parentId: testMediaJob.id,
  state: "running",
  stage: "extracting_frames",
  progress: { completed: 18, total: 40, unit: "frames" },
  summary: "Build thumbnail strip",
  startedAt: later,
  updatedAt: later,
  attempt: 1,
});
const blockedJob = job({
  id: "70000000-0000-4000-8000-000000000084",
  kind: "final_render",
  priority: "export",
  state: "blocked",
  stage: "awaiting_output_authorization",
  progress: { completed: 0, total: 120, unit: "frames" },
  summary: "Export launch film with a deliberately long but safe summary",
  error: {
    code: "output_grant_required",
    category: "output_authorization_required",
    message: "Choose the export destination again.",
    retryable: true,
    action: "reauthorize_output",
  },
  attempt: 1,
  updatedAt: later,
});

const recovery: MediaJobRecoveryReport = {
  schemaVersion: 1,
  requeuedCount: 1,
  blockedCount: 1,
  cancelledCount: 0,
  staleLeaseCount: 2,
  databaseRecovered: true,
  warning: "Local job metadata was rebuilt safely. Project files were not changed.",
  recoveredAt: later,
};

function controller(overrides: Partial<MediaJobsController> = {}): MediaJobsController {
  const cacheStatus: MediaCacheStatus = {
    ...testMediaCacheStatus,
    budgetBytes: 10_000_000,
    managedBytes: 12_000_000,
    leasedBytes: 12_000_000,
    reclaimableBytes: 0,
    artifactCount: 4,
    leasedArtifactCount: 4,
    pressure: "pinned",
    legacyUnsafeEntryCount: 1,
  };
  return {
    jobs: [testMediaJob, proxyChild, thumbnailChild, blockedJob],
    events: [],
    latestEventId: 0,
    recovery,
    loading: false,
    refreshing: false,
    nextCursor: null,
    loadedPageCount: 1,
    loadingOlder: false,
    olderError: null,
    olderResultAnnouncement: "",
    hasOlderJobs: false,
    loadOlderJobs: vi.fn(async () => 0),
    error: null,
    listenerError: null,
    cacheStatus,
    cacheRefreshing: false,
    cacheError: null,
    pendingJobIds: [],
    actionError: null,
    clearingLegacyCache: false,
    canClearLegacyCache: true,
    canCancelJob: vi.fn(() => true),
    canRetryJob: vi.fn(() => true),
    refresh: vi.fn(async () => undefined),
    refreshMediaJobs: vi.fn(async () => undefined),
    refreshCache: vi.fn(async () => undefined),
    cancelJob: vi.fn(async () => null),
    cancelMediaJob: vi.fn(async () => null),
    retryJob: vi.fn(async () => null),
    retryMediaJob: vi.fn(async () => null),
    clearLegacyCache: vi.fn(async () => ({
      schemaVersion: 1,
      clearedBytes: cacheStatus.legacyBytes,
      clearedEntryCount: cacheStatus.legacyEntryCount,
      skippedUnsafeEntryCount: cacheStatus.legacyUnsafeEntryCount,
      status: {
        ...cacheStatus,
        legacyBytes: 0,
        legacyEntryCount: 0,
        legacyUnsafeEntryCount: 0,
        legacyClearAvailable: false,
      },
    })),
    clearLegacyMediaCache: vi.fn(async () => null),
    ...overrides,
  } as MediaJobsController;
}

afterEach(cleanup);

describe("JobCenter", () => {
  it("renders ordered parent jobs, child stages, recovery and pinned cache health without axe violations", async () => {
    const value = controller();
    const { container } = render(<JobCenter controller={value} onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Job Center" })).toBeTruthy();
    expect(container.querySelector("ol.job-list")?.tagName).toBe("OL");
    expect(screen.getByText("Proxy video")).toBeTruthy();
    expect(screen.getByText("Thumbnail strip")).toBeTruthy();
    expect(screen.getByText("Pinned pressure")).toBeTruthy();
    expect(screen.getByText("Job database recovered")).toBeTruthy();
    expect(screen.getByText("Choose the export destination again, then retry.")).toBeTruthy();
    expect(screen.getAllByRole("progressbar").length).toBeGreaterThanOrEqual(4);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));

    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
    });
    expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
  });

  it("exposes only lifecycle-valid actions and disables duplicate requests", () => {
    const cancelJob = vi.fn(async () => null);
    const retryJob = vi.fn(async () => null);
    const value = controller({ pendingJobIds: [blockedJob.id], cancelJob, retryJob });
    render(<JobCenter controller={value} onClose={vi.fn()} />);

    const retryButtons = screen.getAllByRole("button", { name: /Retry/ });
    expect(retryButtons).toHaveLength(1);
    expect((retryButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Cancel$/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(cancelJob).toHaveBeenCalledWith(testMediaJob);
    expect(retryJob).not.toHaveBeenCalled();
  });

  it("keeps older pagination reachable when the loaded page contains only child jobs", () => {
    const loadOlderJobs = vi.fn(async () => 1);
    render(
      <JobCenter
        controller={controller({
          jobs: [proxyChild, thumbnailChild],
          hasOlderJobs: true,
          nextCursor: { beforeUpdatedAt: later, beforeJobId: thumbnailChild.id },
          loadOlderJobs,
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("No media jobs yet")).toBeNull();
    expect(screen.getByText("Parent jobs are not loaded yet")).toBeTruthy();
    const loadButton = screen.getByRole("button", {
      name: "Load older work to show parent jobs",
    });
    loadButton.focus();
    fireEvent.click(loadButton);
    expect(loadOlderJobs).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(loadButton);
  });

  it("exposes pending, retry, and no-more pagination states without losing button focus", () => {
    const loadOlderJobs = vi.fn(async () => 1);
    const value = controller({
      hasOlderJobs: true,
      nextCursor: { beforeUpdatedAt: later, beforeJobId: blockedJob.id },
      loadOlderJobs,
    });
    const { rerender } = render(<JobCenter controller={value} onClose={vi.fn()} />);
    const loadButton = screen.getByRole("button", { name: "Load older jobs" });
    loadButton.focus();
    fireEvent.click(loadButton);
    expect(loadOlderJobs).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(loadButton);

    rerender(
      <JobCenter
        controller={controller({
          hasOlderJobs: true,
          nextCursor: { beforeUpdatedAt: later, beforeJobId: blockedJob.id },
          loadingOlder: true,
        })}
        onClose={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Loading older jobs" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    rerender(
      <JobCenter
        controller={controller({
          hasOlderJobs: true,
          nextCursor: { beforeUpdatedAt: later, beforeJobId: blockedJob.id },
          olderError: new Error("unavailable"),
          loadOlderJobs,
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("jobs already shown are unchanged");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading older jobs" }));
    expect(loadOlderJobs).toHaveBeenCalledTimes(2);

    rerender(<JobCenter controller={controller()} onClose={vi.fn()} />);
    expect(
      (screen.getByRole("button", { name: "All jobs loaded" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("All available jobs are shown.")).toBeTruthy();
  });

  it("announces only the added older-job count through the polite status", () => {
    render(
      <JobCenter
        controller={controller({ olderResultAnnouncement: "2 older jobs loaded." })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("2 older jobs loaded.").getAttribute("aria-live")).toBe("polite");
  });

  it("uses safe dialog focus, confirms legacy cleanup, and returns focus", async () => {
    const clearLegacyCache = vi.fn(async () => ({
      schemaVersion: 1 as const,
      clearedBytes: 1_000,
      clearedEntryCount: 1,
      skippedUnsafeEntryCount: 1,
      status: {
        ...testMediaCacheStatus,
        legacyBytes: 0,
        legacyEntryCount: 0,
        legacyUnsafeEntryCount: 0,
        legacyClearAvailable: false,
      },
    }));
    const value = controller({ clearLegacyCache });
    render(<JobCenter controller={value} onClose={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Clear legacy preview cache" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Clear legacy preview cache?" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep legacy cache" }));

    fireEvent.click(screen.getByRole("button", { name: "Clear legacy cache" }));
    await waitFor(() => expect(clearLegacyCache).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps private diagnostics out of visible job and dialog recovery copy", () => {
    const privateJob = {
      ...blockedJob,
      summary: "Export C:\\Users\\Editor\\private.mp4",
      error: { ...blockedJob.error!, message: "ffmpeg failed at C:\\Users\\Editor\\private.mp4" },
    } as MediaJobRecord;
    const value = controller({
      jobs: [privateJob],
      cacheError: new Error("C:\\Users\\Editor\\cache failed"),
      recovery: { ...recovery, warning: "Recovered C:\\Users\\Editor\\media-state.sqlite3" },
    });
    const { container } = render(<JobCenter controller={value} onClose={vi.fn()} />);

    expect(container.textContent).not.toContain("Users");
    expect(container.textContent).not.toContain("media-state.sqlite3");
    fireEvent.click(screen.getByRole("button", { name: "Clear legacy preview cache" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toContain("Legacy cache was not cleared");
    expect(dialog.textContent).not.toContain("Users");
  });

  it("renders loading, empty, disconnect, and recoverable service errors", () => {
    const { rerender } = render(
      <JobCenter
        controller={controller({ loading: true, jobs: [], cacheStatus: null })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading durable jobs")).toBeTruthy();

    rerender(
      <JobCenter
        controller={controller({
          jobs: [],
          recovery: null,
          listenerError: new Error("offline"),
          error: new Error("snapshot failed"),
          cacheError: new Error("cache failed"),
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("No media jobs yet")).toBeTruthy();
    expect(screen.getByText("Live job updates disconnected")).toBeTruthy();
    expect(screen.getByText("Could not load media jobs")).toBeTruthy();
    expect(screen.getByText("Could not update cache health")).toBeTruthy();
  });
});
