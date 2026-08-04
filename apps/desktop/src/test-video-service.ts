import type {
  CommandGroupRequest,
  ProjectCommandV2,
  ProjectProjection,
  RecoveryReport,
} from "@supa-video/contracts";
import {
  listMediaJobsRequestSchema,
  reauthorizeMediaJobOutputRequestSchema,
} from "@supa-video/media";
import type {
  MediaCacheStatus,
  MediaJobEvent,
  MediaJobRecord,
  MediaJobRecoveryReport,
} from "@supa-video/media";

const timestamp = "2026-07-26T12:00:00.000Z";
const initialProjectId = "70000000-0000-4000-8000-000000000001";
const revisionId = (number: number) =>
  `70000000-0000-4000-8000-${(100 + number).toString().padStart(12, "0")}`;
const hash = (number: number) => number.toString(16).padStart(64, "0");

export const testProbe = {
  durationMicroseconds: 4_000_000,
  averageFrameRate: { numerator: 25, denominator: 1 },
  realFrameRate: { numerator: 25, denominator: 1 },
  variableFrameRate: false,
  width: 720,
  height: 576,
  videoCodecName: "h264",
  audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
  fileSizeBytes: 12_000_000,
} as const;
export const testSourceIdentity = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: testProbe.fileSizeBytes,
} as const;
const testProfileIdentity = {
  schemaVersion: 1,
  profileId: "preview-v1",
  profileDigest: "34".repeat(32),
} as const;
const identityBase = {
  schemaVersion: 1,
  sourceIdentity: testSourceIdentity,
  toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
  profileIdentity: testProfileIdentity,
  recipeDigest: "56".repeat(32),
} as const;
export const testPrepared = {
  sourceFingerprint: {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: "78".repeat(32),
    byteLength: testProbe.fileSizeBytes,
    modifiedUnixSeconds: 1_720_000_000,
    modifiedNanoseconds: 42,
  },
  sourceIdentity: testSourceIdentity,
  sourceProbe: testProbe,
  sequenceRate: testProbe.averageFrameRate,
  profileIdentity: testProfileIdentity,
  proxyIdentity: { ...identityBase, artifactKind: "proxy", key: "9a".repeat(32) },
  proxyPath: "C:\\Neutral\\Cache\\proxy.mp4",
  proxyProbe: { ...testProbe, width: 540, height: 720, fileSizeBytes: 5_000_000 },
  thumbnailIdentity: {
    ...identityBase,
    artifactKind: "thumbnail_tile",
    key: "bc".repeat(32),
  },
  thumbnailPath: "C:\\Neutral\\Cache\\thumb.jpg",
} as const;

export const testMediaJob = {
  schemaVersion: 1,
  id: "70000000-0000-4000-8000-000000000080",
  kind: "asset_preparation",
  parentId: null,
  projectId: initialProjectId,
  assetId: "70000000-0000-4000-8000-000000000081",
  revisionId: revisionId(0),
  priority: "interactive",
  state: "queued",
  stage: "queued",
  progress: { completed: 0, total: 2, unit: "stages" },
  attempt: 0,
  maxAttempts: 3,
  summary: "Prepare preview media",
  error: null,
  retryAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: null,
  settledAt: null,
  cancellationRequested: false,
  resultAvailable: false,
} satisfies MediaJobRecord;

export const testMediaCacheStatus: MediaCacheStatus = {
  schemaVersion: 1,
  budgetBytes: 10_000_000,
  managedBytes: 5_000_000,
  leasedBytes: 0,
  reclaimableBytes: 5_000_000,
  artifactCount: 2,
  leasedArtifactCount: 0,
  pressure: "normal",
  legacyBytes: 1_000,
  legacyEntryCount: 1,
  legacyUnsafeEntryCount: 0,
  legacyClearAvailable: true,
  recoveryWarning: null,
  refreshedAt: timestamp,
};

function emptyProjection(): ProjectProjection {
  return {
    projectId: initialProjectId,
    name: "workflow",
    revision: {
      number: 0,
      id: revisionId(0),
      parentId: null,
      committedAt: timestamp,
      operationId: "70000000-0000-4000-8000-000000000002",
      stateHash: hash(0),
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
function nextProjection(base: ProjectProjection, operationId: string): ProjectProjection {
  const number = base.revision.number + 1;
  return {
    ...structuredClone(base),
    revision: {
      number,
      id: revisionId(number),
      parentId: base.revision.id,
      committedAt: timestamp,
      operationId,
      stateHash: hash(number),
    },
    snapshotRevision: 0,
    journalHealth: "healthy",
  };
}

function commandSummary(command: ProjectCommandV2): string {
  switch (command.type) {
    case "ImportAsset":
      return "Imported asset";
    case "CreateSequence":
      return "Created sequence";
    case "InsertClip":
      return "Inserted clip";
    case "SplitClip":
      return "Split clip";
    case "MoveClip":
      return "Moved clip";
    case "TrimClip":
      return "Applied trim";
    default:
      return "Updated project";
  }
}

export function createMockVideoService(
  options: {
    recoveryStatus?: ProjectProjection["recoveryStatus"];
    recovery?: Partial<RecoveryReport>;
    sourceStatusOnOpen?: "missing" | "relink_required";
    checkpointWarningRevisions?: readonly number[];
    mediaJobs?: readonly MediaJobRecord[];
    mediaCacheStatus?: MediaCacheStatus;
    mediaRecovery?: MediaJobRecoveryReport | null;
  } = {},
) {
  let projection = emptyProjection();
  const checkpointWarningRevisions = new Set(options.checkpointWarningRevisions ?? []);
  const checkpointEvents = (next: ProjectProjection) => {
    const pending = checkpointWarningRevisions.has(next.revision.number);
    next.journalHealth = pending ? "snapshot_pending" : "healthy";
    return pending
      ? [{ type: "snapshot_warning" as const, message: "Periodic snapshot checkpoint failed" }]
      : [];
  };
  projection.recoveryStatus = options.recovery?.status ?? options.recoveryStatus ?? "clean";
  const undo: ProjectProjection[] = [];
  const redo: ProjectProjection[] = [];
  const path = "C:\\Neutral\\Projects\\workflow.svpvideo";
  const sourcePath = "C:\\Neutral\\Media\\clip.mp4";
  const replacementPath = "C:\\Neutral\\Media\\replacement.mp4";
  const outputPath = "C:\\Neutral\\Exports\\clip.mp4";
  let mediaJobs: MediaJobRecord[] = (options.mediaJobs ?? [testMediaJob]).map((job) =>
    structuredClone(job),
  );
  let mediaEvents: MediaJobEvent[] = mediaJobs.map((job, index) => ({
    schemaVersion: 1,
    eventId: index + 1,
    jobId: job.id,
    eventType: "created",
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    message: null,
    category: job.error?.category ?? null,
    createdAt: job.createdAt,
  }));
  const replaceMediaJobs = (next: readonly MediaJobRecord[]): MediaJobEvent => {
    mediaJobs = next.map((job) => structuredClone(job));
    const job = mediaJobs.at(-1);
    if (job === undefined) throw new Error("A mock media event requires at least one job");
    const event: MediaJobEvent = {
      schemaVersion: 1,
      eventId: (mediaEvents.at(-1)?.eventId ?? 0) + 1,
      jobId: job.id,
      eventType: "state_changed",
      state: job.state,
      stage: job.stage,
      progress: job.progress,
      message: null,
      category: job.error?.category ?? null,
      createdAt: job.updatedAt,
    };
    mediaEvents = [...mediaEvents, event];
    return structuredClone(event);
  };
  let mediaCacheStatus = structuredClone(options.mediaCacheStatus ?? testMediaCacheStatus);
  const mediaRecovery = structuredClone(options.mediaRecovery ?? null);
  const invoke = async (command: string, args?: unknown): Promise<unknown> => {
    if (command === "video_ffmpeg_status")
      return {
        source: "bundled",
        toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
        ffmpeg: { available: true, version: "8.1.2" },
        ffprobe: { available: true, version: "8.1.2" },
        ready: true,
      };
    if (command === "video_pick_new_project_path") return path;
    if (command === "video_create_project") {
      projection = emptyProjection();
      return structuredClone(projection);
    }
    if (command === "video_pick_source") return sourcePath;
    if (command === "video_probe_media") return testProbe;
    if (command === "video_prepare_asset") return testPrepared;
    if (command === "video_execute_project_group") {
      const request = (args as { request: CommandGroupRequest }).request;
      const prior = structuredClone(projection);
      undo.push(prior);
      redo.length = 0;
      const next = nextProjection(projection, request.groupId);
      for (const item of request.commands) {
        if (item.type === "ImportAsset") next.state.assets.push(item.asset);
        else if (item.type === "CreateSequence") {
          next.state.sequences.push(item.sequence);
          next.state.activeSequenceId = item.sequence.id;
        } else if (item.type === "InsertClip") {
          const sequence = next.state.sequences.find(({ id }) => id === item.sequenceId)!;
          const track = sequence.tracks.find(({ id }) => id === item.trackId)!;
          if (track.kind !== "caption") track.clips.push(item.clip);
        } else if (item.type === "SplitClip") {
          const sequence = next.state.sequences.find(({ id }) => id === item.sequenceId)!;
          const track = sequence.tracks.find(({ id }) => id === item.trackId)!;
          if (track.kind !== "caption") {
            const clipIndex = track.clips.findIndex(({ id }) => id === item.clipId);
            const leftClip = track.clips[clipIndex]!;
            const originalSourceIn = leftClip.sourceIn.value;
            const rightClip = structuredClone(leftClip);
            rightClip.id = item.rightClipId;
            rightClip.sourceIn = item.splitAt;
            rightClip.timelineStart = {
              ...leftClip.timelineStart,
              value: leftClip.timelineStart.value + item.splitAt.value - originalSourceIn,
            };
            leftClip.sourceOut = item.splitAt;
            track.clips.splice(clipIndex + 1, 0, rightClip);
          }
        } else if (item.type === "MoveClip") {
          const sequence = next.state.sequences.find(({ id }) => id === item.sequenceId)!;
          const track = sequence.tracks.find(({ id }) => id === item.trackId)!;
          if (track.kind !== "caption") {
            const clip = track.clips.find(({ id }) => id === item.clipId);
            if (clip) clip.timelineStart = item.timelineStart;
          }
        } else if (item.type === "TrimClip") {
          const sequence = next.state.sequences.find(({ id }) => id === item.sequenceId)!;
          const track = sequence.tracks.find(({ id }) => id === item.trackId)!;
          if (track.kind !== "caption") {
            const clip = track.clips.find(({ id }) => id === item.clipId);
            if (clip) {
              clip.sourceIn = item.sourceIn;
              clip.sourceOut = item.sourceOut;
            }
          }
        }
      }
      next.canUndo = true;
      next.canRedo = false;
      next.sources = next.state.assets.map((asset) => ({
        assetId: asset.id,
        status: "resolved" as const,
        resolvedPath: asset.locator.absolutePath ?? sourcePath,
      }));
      next.lastCommand = {
        operationId: request.groupId,
        groupId: request.groupId,
        summary: request.commands.map(commandSummary).join(", "),
      };
      const events = checkpointEvents(next);
      projection = next;
      return {
        projectId: next.projectId,
        operationId: request.groupId,
        groupId: request.groupId,
        priorRevision: prior.revision,
        newRevision: next.revision,
        stateHash: next.revision.stateHash,
        projection: structuredClone(next),
        affectedRanges: [],
        cacheInvalidations: [],
        events,
      };
    }
    if (command === "video_undo_project" || command === "video_redo_project") {
      const prior = structuredClone(projection);
      const operationId = (args as { operationId: string }).operationId;
      if (command === "video_undo_project") {
        const target = undo.pop()!;
        redo.push(prior);
        projection = {
          ...target,
          revision: nextProjection(prior, operationId).revision,
          canUndo: undo.length > 0,
          canRedo: true,
          lastCommand: {
            operationId,
            groupId: operationId,
            summary: `Undid ${prior.lastCommand?.summary ?? "project edit"}`,
          },
        };
      } else {
        const target = redo.pop()!;
        undo.push(prior);
        projection = {
          ...target,
          revision: nextProjection(prior, operationId).revision,
          canUndo: true,
          canRedo: redo.length > 0,
          lastCommand: {
            operationId,
            groupId: operationId,
            summary: `Redid ${target.lastCommand?.summary ?? "project edit"}`,
          },
        };
      }
      const events = checkpointEvents(projection);
      return {
        projectId: projection.projectId,
        operationId,
        groupId: operationId,
        priorRevision: prior.revision,
        newRevision: projection.revision,
        stateHash: projection.revision.stateHash,
        projection: structuredClone(projection),
        affectedRanges: [],
        cacheInvalidations: [],
        events,
      };
    }
    if (command === "video_open_project") {
      const openedProjection = structuredClone(projection);
      if (options.sourceStatusOnOpen !== undefined) {
        openedProjection.sources = openedProjection.sources.map((source) => ({
          ...source,
          status: options.sourceStatusOnOpen!,
          resolvedPath: null,
        }));
      }
      projection = structuredClone(openedProjection);
      return {
        projection: openedProjection,
        recovery: {
          status: projection.recoveryStatus,
          recoveredRevision: projection.revision.number,
          replayedRecordCount: projection.replayedRecordCount,
          discardedTailBytes: projection.recoveryStatus === "degraded" ? 32 : 0,
          message: "Mock recovery",
          legacyHistoryReset: false,
          ...options.recovery,
        } satisfies RecoveryReport,
      };
    }
    if (command === "video_close_project" || command === "video_cancel_render") return null;
    if (command === "video_pick_export_path") return outputPath;
    if (command === "video_start_render") {
      const plan = (args as { plan: { planId: string; revisionId: string } }).plan;
      return {
        jobId: "70000000-0000-4000-8000-000000000090",
        planId: plan.planId,
        revisionId: plan.revisionId,
      };
    }
    if (command === "video_list_media_jobs") {
      const request = listMediaJobsRequestSchema.parse((args as { request?: unknown })?.request);
      const terminalStates = new Set<MediaJobRecord["state"]>(["cancelled", "failed", "complete"]);
      const filtered = mediaJobs.filter(
        (job) =>
          (request.includeSettled || !terminalStates.has(job.state)) &&
          (request.projectId === null || job.projectId === request.projectId),
      );
      const unsettledParentCount = mediaJobs.filter(
        (job) =>
          job.parentId === null &&
          !terminalStates.has(job.state) &&
          (request.projectId === null || job.projectId === request.projectId),
      ).length;
      const beforeUpdatedAt =
        request.beforeUpdatedAt === null ? null : Date.parse(request.beforeUpdatedAt);
      const matching = filtered
        .filter((job) => {
          if (beforeUpdatedAt === null || request.beforeJobId === null) return true;
          const updatedAt = Date.parse(job.updatedAt);
          return (
            updatedAt < beforeUpdatedAt ||
            (updatedAt === beforeUpdatedAt && job.id < request.beforeJobId)
          );
        })
        .sort((left, right) => {
          const updatedAtOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
          if (updatedAtOrder !== 0) return updatedAtOrder;
          return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
        });
      const fetched = matching.slice(0, request.limit + 1);
      const hasMore = fetched.length > request.limit;
      const jobs = fetched.slice(0, request.limit);
      const lastJob = hasMore ? jobs.at(-1) : undefined;
      return {
        schemaVersion: 1,
        jobs,
        unsettledParentCount,
        nextBeforeUpdatedAt: lastJob?.updatedAt ?? null,
        nextBeforeJobId: lastJob?.id ?? null,
        latestEventId: mediaEvents.at(-1)?.eventId ?? 0,
        recovery: mediaRecovery,
      };
    }
    if (command === "video_get_media_job_events") {
      const request = (
        args as {
          request: { jobId: string | null; afterEventId: number; limit: number };
        }
      ).request;
      const matching = mediaEvents.filter(
        (event) =>
          event.eventId > request.afterEventId &&
          (request.jobId === null || event.jobId === request.jobId),
      );
      return {
        schemaVersion: 1,
        events: matching.slice(0, request.limit),
        latestEventId: mediaEvents.at(-1)?.eventId ?? 0,
        hasMore: matching.length > request.limit,
      };
    }
    if (
      command === "video_cancel_media_job" ||
      command === "video_retry_media_job" ||
      command === "video_reauthorize_media_job_output"
    ) {
      const request = (args as { request: unknown }).request;
      const { jobId } =
        command === "video_reauthorize_media_job_output"
          ? reauthorizeMediaJobOutputRequestSchema.parse(request)
          : (request as { jobId: string });
      const current = mediaJobs.find((job) => job.id === jobId);
      if (current === undefined) throw new Error("Unknown mock media job");
      const eventId = (mediaEvents.at(-1)?.eventId ?? 0) + 1;
      const cancelled = command === "video_cancel_media_job";
      const updated: MediaJobRecord = cancelled
        ? {
            ...current,
            state: "cancelled",
            stage: "cancelled",
            settledAt: timestamp,
            retryAt: null,
            error: null,
            resultAvailable: false,
            cancellationRequested: false,
          }
        : ({
            ...current,
            state: "queued",
            stage: "queued",
            settledAt: null,
            retryAt: null,
            error: null,
            resultAvailable: false,
            cancellationRequested: false,
          } as MediaJobRecord);
      mediaJobs = mediaJobs.map((job) => (job.id === jobId ? updated : job));
      mediaEvents = [
        ...mediaEvents,
        {
          schemaVersion: 1,
          eventId,
          jobId,
          eventType: "state_changed",
          state: updated.state,
          stage: updated.stage,
          progress: updated.progress,
          message: null,
          category: null,
          createdAt: timestamp,
        },
      ];
      return { schemaVersion: 1, job: structuredClone(updated) };
    }
    if (command === "video_get_media_cache_status") return structuredClone(mediaCacheStatus);
    if (command === "video_clear_legacy_media_cache") {
      const { confirmed } = (args as { request: { confirmed: boolean } }).request;
      if (!confirmed) throw new Error("Legacy cache clear requires confirmation");
      const clearedBytes = mediaCacheStatus.legacyBytes;
      const clearedEntryCount = mediaCacheStatus.legacyEntryCount;
      const skippedUnsafeEntryCount = mediaCacheStatus.legacyUnsafeEntryCount;
      mediaCacheStatus = {
        ...mediaCacheStatus,
        legacyBytes: 0,
        legacyEntryCount: 0,
        legacyUnsafeEntryCount: 0,
        legacyClearAvailable: false,
      };
      return {
        schemaVersion: 1,
        clearedBytes,
        clearedEntryCount,
        skippedUnsafeEntryCount,
        status: structuredClone(mediaCacheStatus),
      };
    }
    if (command === "video_project_inspector")
      return {
        projectId: projection.projectId,
        revision: projection.revision,
        lastCommand: projection.lastCommand,
        snapshotRevision: projection.snapshotRevision,
        journalHealth: projection.journalHealth,
        replayedRecordCount: projection.replayedRecordCount,
        recoveryStatus: projection.recoveryStatus,
      };
    if (command === "video_relink_project_asset") {
      const { projectId, assetId } = args as { projectId: string; assetId: string };
      if (projectId !== projection.projectId) throw new Error("Unexpected relink project");
      const prior = structuredClone(projection);
      const next = nextProjection(projection, "70000000-0000-4000-8000-000000000095");
      const asset = next.state.assets.find(({ id }) => id === assetId);
      if (asset === undefined) throw new Error("Unexpected relink asset");
      asset.locator = { absolutePath: replacementPath };
      asset.contentIdentity = testSourceIdentity;
      next.sources = next.sources.map((source) =>
        source.assetId === assetId
          ? { ...source, status: "resolved" as const, resolvedPath: replacementPath }
          : source,
      );
      next.canUndo = true;
      next.lastCommand = {
        operationId: next.revision.operationId,
        groupId: next.revision.operationId,
        summary: "Relinked asset",
      };
      projection = next;
      return {
        projectId: next.projectId,
        operationId: next.revision.operationId,
        groupId: next.revision.operationId,
        priorRevision: prior.revision,
        newRevision: next.revision,
        stateHash: next.revision.stateHash,
        projection: structuredClone(next),
        affectedRanges: [],
        cacheInvalidations: ["asset_source", "preview", "render_plan"],
        events: [],
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  return {
    invoke,
    get projection() {
      return projection;
    },
    path,
    sourcePath,
    replacementPath,
    outputPath,
    replaceMediaJobs,
  };
}
