import type { CommandGroupRequest, ProjectProjection, RecoveryReport } from "@supa-video/contracts";

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
export const testPrepared = {
  proxyPath: "C:\\Neutral\\Cache\\proxy.mp4",
  thumbnailPath: "C:\\Neutral\\Cache\\thumb.jpg",
  proxyProbe: { ...testProbe, width: 540, height: 720, fileSizeBytes: 5_000_000 },
} as const;

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

export function createMockVideoService(
  options: {
    recoveryStatus?: ProjectProjection["recoveryStatus"];
    recovery?: Partial<RecoveryReport>;
    sourceStatusOnOpen?: "missing" | "relink_required";
    checkpointWarningRevisions?: readonly number[];
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
  const invoke = async (command: string, args?: unknown): Promise<unknown> => {
    if (command === "video_ffmpeg_status")
      return {
        ffmpeg: { available: true, version: "ffmpeg version 7.1" },
        ffprobe: { available: true, version: "ffprobe version 7.1" },
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
        } else if (item.type === "TrimClip") {
          for (const sequence of next.state.sequences)
            for (const track of sequence.tracks)
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
        summary: request.commands.some(({ type }) => type === "TrimClip")
          ? "Applied trim"
          : "Imported source",
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
        };
      } else {
        const target = redo.pop()!;
        undo.push(prior);
        projection = {
          ...target,
          revision: nextProjection(prior, operationId).revision,
          canUndo: true,
          canRedo: redo.length > 0,
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
  };
}
