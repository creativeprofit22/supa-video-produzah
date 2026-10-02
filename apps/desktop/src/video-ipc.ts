import {
  absoluteNativePathSchema,
  commandGroupRequestSchema,
  commandResultSchema,
  deliveryPresetSchema,
  mediaProbeSchema,
  openedProjectV2Schema,
  projectInspectorSchema,
  projectProjectionSchema,
  renderPlanSchema,
  VideoDomainError,
  videoErrorCodes,
  videoRenderEventSchema,
  videoRenderStartedSchema,
  videoToolStatusSchema,
} from "@supa-video/contracts";
import {
  editorialEvaluationSchema,
  reviewDecisionRequestSchema,
  reviewStateSchema,
  type EditorialEvaluation,
  type ReviewDecisionRequest,
  type ReviewState,
} from "@supa-video/qc";
import type {
  CommandGroupRequest,
  CommandResult,
  DeliveryPresetId,
  MediaProbe,
  OpenedProjectV2,
  ProjectInspector,
  ProjectProjection,
  RenderPlan,
  VideoErrorCode,
  VideoRenderEvent,
  VideoRenderStarted,
  VideoToolStatus,
} from "@supa-video/contracts";
import {
  clearLegacyMediaCacheRequestSchema,
  clearLegacyMediaCacheResponseSchema,
  getMediaCacheStatusRequestSchema,
  getMediaJobEventsRequestSchema,
  listMediaJobsRequestSchema,
  mediaCacheStatusSchema,
  mediaJobActionRequestSchema,
  mediaJobActionResponseSchema,
  mediaJobEventListSchema,
  mediaJobEventSchema,
  mediaJobListSchema,
  prepareVideoAssetRequestSchema,
  preparedVideoAssetSchema,
  reauthorizeMediaJobOutputRequestSchema,
  transcriptArtifactV1Schema,
} from "@supa-video/media";
import type {
  ClearLegacyMediaCacheRequest,
  ClearLegacyMediaCacheResponse,
  GetMediaCacheStatusRequest,
  GetMediaJobEventsRequest,
  ListMediaJobsRequest,
  MediaCacheStatus,
  MediaJobActionRequest,
  MediaJobActionResponse,
  MediaJobEvent,
  MediaJobEventList,
  MediaJobList,
  PreparedVideoAsset,
  PrepareVideoAssetRequest,
  ReauthorizeMediaJobOutputRequest,
  TranscriptArtifactV1,
} from "@supa-video/media";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";

const selectedPathSchema = absoluteNativePathSchema.nullable();
const emptyCommandResponseSchema = z.null();
const managedTranscriptArtifactKeySchema = z.string().regex(/^[0-9a-f]{64}$/u);
const videoErrorCodeSet = new Set<string>(videoErrorCodes);
const VIDEO_RENDER_EVENT = "video:render-event";
const VIDEO_MEDIA_JOB_EVENT = "video:media-job-event";

export class VideoIpcResponseError extends Error {
  constructor() {
    super("The desktop service returned an invalid response");
    this.name = "VideoIpcResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVideoErrorCode(value: unknown): value is VideoErrorCode {
  return typeof value === "string" && videoErrorCodeSet.has(value);
}

export function normalizeVideoCommandError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (isRecord(value) && isVideoErrorCode(value.code)) {
    const message =
      typeof value.message === "string" && value.message.trim().length > 0
        ? value.message
        : "The video command failed";
    const details = isRecord(value.details) ? value.details : {};
    return new VideoDomainError(value.code, message, details);
  }
  return new Error("The desktop command failed unexpectedly");
}

async function invokeVideoCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke<unknown>(command, args);
  } catch (error) {
    throw normalizeVideoCommandError(error);
  }
}

function parseResponse<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) {
    throw new VideoIpcResponseError();
  }
  return result.data;
}

export async function getVideoToolStatus(): Promise<VideoToolStatus> {
  const response = await invokeVideoCommand("video_ffmpeg_status");
  return parseResponse(videoToolStatusSchema.safeParse(response));
}

export async function pickVideoSource(): Promise<string | null> {
  const response = await invokeVideoCommand("video_pick_source");
  return parseResponse(selectedPathSchema.safeParse(response));
}

export async function pickNewVideoProjectPath(defaultName: string): Promise<string | null> {
  const response = await invokeVideoCommand("video_pick_new_project_path", { defaultName });
  return parseResponse(selectedPathSchema.safeParse(response));
}

export async function createVideoProject(path: string, name: string): Promise<ProjectProjection> {
  const response = await invokeVideoCommand("video_create_project", {
    path: absoluteNativePathSchema.parse(path),
    name,
  });
  return parseResponse(projectProjectionSchema.safeParse(response));
}

export async function openVideoProject(): Promise<OpenedProjectV2 | null> {
  const response = await invokeVideoCommand("video_open_project");
  return parseResponse(openedProjectV2Schema.nullable().safeParse(response));
}

export async function executeVideoProjectGroup(
  request: CommandGroupRequest,
): Promise<CommandResult> {
  const validated = commandGroupRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_execute_project_group", { request: validated });
  return parseResponse(commandResultSchema.safeParse(response));
}

async function invokeHistoryOperation(
  command: "video_undo_project" | "video_redo_project",
  projectId: string,
  baseRevision: number,
  operationId: string,
): Promise<CommandResult> {
  const response = await invokeVideoCommand(command, { projectId, baseRevision, operationId });
  return parseResponse(commandResultSchema.safeParse(response));
}

export function undoVideoProject(
  projectId: string,
  baseRevision: number,
  operationId: string,
): Promise<CommandResult> {
  return invokeHistoryOperation("video_undo_project", projectId, baseRevision, operationId);
}

export function redoVideoProject(
  projectId: string,
  baseRevision: number,
  operationId: string,
): Promise<CommandResult> {
  return invokeHistoryOperation("video_redo_project", projectId, baseRevision, operationId);
}

export async function getVideoProjectInspector(projectId: string): Promise<ProjectInspector> {
  const response = await invokeVideoCommand("video_project_inspector", { projectId });
  return parseResponse(projectInspectorSchema.safeParse(response));
}

export async function closeVideoProject(projectId: string): Promise<void> {
  const response = await invokeVideoCommand("video_close_project", { projectId });
  parseResponse(emptyCommandResponseSchema.safeParse(response));
}

export async function relinkVideoProjectAsset(
  projectId: string,
  assetId: string,
): Promise<CommandResult | null> {
  const response = await invokeVideoCommand("video_relink_project_asset", { projectId, assetId });
  return parseResponse(commandResultSchema.nullable().safeParse(response));
}

export async function pickVideoExportPath(defaultName: string): Promise<string | null> {
  const response = await invokeVideoCommand("video_pick_export_path", { defaultName });
  return parseResponse(selectedPathSchema.safeParse(response));
}

export async function probeVideoSource(path: string): Promise<MediaProbe> {
  const response = await invokeVideoCommand("video_probe_media", { path });
  return parseResponse(mediaProbeSchema.safeParse(response));
}

/** Picks a PNG/JPEG for a graphics image layer; the path is granted as a source. */
export async function pickStillImage(): Promise<string | null> {
  const response = await invokeVideoCommand("video_pick_still_image");
  return parseResponse(selectedPathSchema.safeParse(response));
}

const stillProbeSchema = mediaProbeSchema.refine(
  (probe) => probe.still === true,
  "The native still-image probe must report a still",
);

/** Header-validated probe of a granted still image (≤ 4096 px per side, ≤ 32 MB). */
export async function probeStillImage(path: string): Promise<MediaProbe> {
  const response = await invokeVideoCommand("video_probe_still_image", { path });
  return parseResponse(stillProbeSchema.safeParse(response));
}

export async function prepareVideoAsset(
  request: PrepareVideoAssetRequest,
): Promise<PreparedVideoAsset> {
  const args = prepareVideoAssetRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_prepare_asset", args);
  return parseResponse(preparedVideoAssetSchema.safeParse(response));
}

export async function startVideoRender(
  plan: RenderPlan,
  overwrite: boolean,
  editorial: EditorialEvaluation,
): Promise<VideoRenderStarted> {
  const validatedPlan = renderPlanSchema.parse(plan);
  const response = await invokeVideoCommand("video_start_render", {
    plan: validatedPlan,
    overwrite,
    editorial: editorialEvaluationSchema.parse(editorial),
  });
  return parseResponse(videoRenderStartedSchema.safeParse(response));
}

export async function cancelVideoRender(jobId: string): Promise<void> {
  const response = await invokeVideoCommand("video_cancel_render", { jobId });
  parseResponse(emptyCommandResponseSchema.safeParse(response));
}

export async function readReviewState(outputPath: string): Promise<ReviewState> {
  const response = await invokeVideoCommand("video_read_review_state", { outputPath });
  return parseResponse(reviewStateSchema.safeParse(response));
}

export async function recordReviewDecision(
  outputPath: string,
  decision: ReviewDecisionRequest,
): Promise<ReviewState> {
  const response = await invokeVideoCommand("video_record_review_decision", {
    outputPath,
    decision: reviewDecisionRequestSchema.parse(decision),
  });
  return parseResponse(reviewStateSchema.safeParse(response));
}

export interface DeliveryPresetJob {
  readonly presetId: DeliveryPresetId;
  readonly plan: RenderPlan;
  readonly editorial: EditorialEvaluation;
}

export async function startVideoDelivery(
  sourceOutputPath: string,
  presets: readonly DeliveryPresetJob[],
): Promise<readonly VideoRenderStarted[]> {
  const response = await invokeVideoCommand("video_start_delivery", {
    request: {
      sourceOutputPath,
      presets: presets.map((preset) => ({
        presetId: deliveryPresetSchema.shape.id.parse(preset.presetId),
        plan: renderPlanSchema.parse(preset.plan),
        editorial: editorialEvaluationSchema.parse(preset.editorial),
      })),
    },
  });
  return parseResponse(z.array(videoRenderStartedSchema).max(3).safeParse(response));
}

export async function listMediaJobs(request: ListMediaJobsRequest = {}): Promise<MediaJobList> {
  const validated = listMediaJobsRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_list_media_jobs", { request: validated });
  return parseResponse(mediaJobListSchema.safeParse(response));
}

export async function getMediaJobEvents(
  request: GetMediaJobEventsRequest = {},
): Promise<MediaJobEventList> {
  const validated = getMediaJobEventsRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_get_media_job_events", { request: validated });
  return parseResponse(mediaJobEventListSchema.safeParse(response));
}

export async function cancelMediaJob(
  request: MediaJobActionRequest,
): Promise<MediaJobActionResponse> {
  const validated = mediaJobActionRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_cancel_media_job", { request: validated });
  return parseResponse(mediaJobActionResponseSchema.safeParse(response));
}

export async function retryMediaJob(
  request: MediaJobActionRequest,
): Promise<MediaJobActionResponse> {
  const validated = mediaJobActionRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_retry_media_job", { request: validated });
  return parseResponse(mediaJobActionResponseSchema.safeParse(response));
}

export async function reauthorizeMediaJobOutput(
  request: ReauthorizeMediaJobOutputRequest,
): Promise<MediaJobActionResponse> {
  const validated = reauthorizeMediaJobOutputRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_reauthorize_media_job_output", {
    request: validated,
  });
  return parseResponse(mediaJobActionResponseSchema.safeParse(response));
}

export async function getMediaCacheStatus(
  request: GetMediaCacheStatusRequest = {},
): Promise<MediaCacheStatus> {
  getMediaCacheStatusRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_get_media_cache_status");
  return parseResponse(mediaCacheStatusSchema.safeParse(response));
}

export async function clearLegacyMediaCache(
  request: ClearLegacyMediaCacheRequest,
): Promise<ClearLegacyMediaCacheResponse> {
  const validated = clearLegacyMediaCacheRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_clear_legacy_media_cache", {
    request: validated,
  });
  return parseResponse(clearLegacyMediaCacheResponseSchema.safeParse(response));
}

export async function loadManagedTranscriptArtifact(
  artifactKey: string,
): Promise<TranscriptArtifactV1> {
  const validatedKey = managedTranscriptArtifactKeySchema.parse(artifactKey);
  const response = await invokeVideoCommand("video_load_managed_transcript_artifact", {
    request: { artifactKey: validatedKey },
  });
  return parseResponse(transcriptArtifactV1Schema.safeParse(response));
}

type FailedVideoRenderEvent = Extract<VideoRenderEvent, { type: "failed" }>;

export type VideoRenderNotification =
  | Exclude<VideoRenderEvent, FailedVideoRenderEvent>
  | (Omit<FailedVideoRenderEvent, "error"> & { error: VideoDomainError });

export async function listenMediaJobEvents(
  handler: (event: MediaJobEvent) => void,
  onError?: (error: VideoIpcResponseError) => void,
): Promise<UnlistenFn> {
  const unlisten = await listen<unknown>(VIDEO_MEDIA_JOB_EVENT, (event) => {
    const parsed = mediaJobEventSchema.safeParse(event.payload);
    if (!parsed.success) {
      onError?.(new VideoIpcResponseError());
      return;
    }
    handler(parsed.data);
  });
  let disposed = false;

  return () => {
    if (disposed) return;
    disposed = true;
    unlisten();
  };
}

export async function listenVideoRenderEvents(
  handler: (event: VideoRenderNotification) => void,
): Promise<UnlistenFn> {
  const unlisten = await listen<unknown>(VIDEO_RENDER_EVENT, (event) => {
    const parsedEvent = parseResponse(videoRenderEventSchema.safeParse(event.payload));
    if (parsedEvent.type === "failed") {
      handler({
        ...parsedEvent,
        error: new VideoDomainError(
          parsedEvent.error.code,
          parsedEvent.error.message,
          parsedEvent.error.details,
        ),
      });
      return;
    }
    handler(parsedEvent);
  });
  let disposed = false;

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    unlisten();
  };
}

export interface VideoBackend {
  readonly getVideoToolStatus: typeof getVideoToolStatus;
  readonly pickNewVideoProjectPath: typeof pickNewVideoProjectPath;
  readonly createVideoProject: typeof createVideoProject;
  readonly openVideoProject: typeof openVideoProject;
  readonly executeVideoProjectGroup: typeof executeVideoProjectGroup;
  readonly undoVideoProject: typeof undoVideoProject;
  readonly redoVideoProject: typeof redoVideoProject;
  readonly getVideoProjectInspector: typeof getVideoProjectInspector;
  readonly closeVideoProject: typeof closeVideoProject;
  readonly relinkVideoProjectAsset: typeof relinkVideoProjectAsset;
  readonly pickVideoSource: typeof pickVideoSource;
  readonly probeVideoSource: typeof probeVideoSource;
  readonly prepareVideoAsset: typeof prepareVideoAsset;
  readonly pickVideoExportPath: typeof pickVideoExportPath;
  readonly startVideoRender: typeof startVideoRender;
  readonly cancelVideoRender: typeof cancelVideoRender;
  readonly listenVideoRenderEvents: typeof listenVideoRenderEvents;
  readonly listMediaJobs: typeof listMediaJobs;
  readonly getMediaJobEvents: typeof getMediaJobEvents;
  readonly cancelMediaJob: typeof cancelMediaJob;
  readonly retryMediaJob: typeof retryMediaJob;
  readonly reauthorizeMediaJobOutput: typeof reauthorizeMediaJobOutput;
  readonly getMediaCacheStatus: typeof getMediaCacheStatus;
  readonly clearLegacyMediaCache: typeof clearLegacyMediaCache;
  readonly loadManagedTranscriptArtifact: typeof loadManagedTranscriptArtifact;
  readonly listenMediaJobEvents: typeof listenMediaJobEvents;
  readonly convertFileSrc: typeof convertFileSrc;
}

export const tauriVideoBackend = {
  getVideoToolStatus,
  pickNewVideoProjectPath,
  createVideoProject,
  openVideoProject,
  executeVideoProjectGroup,
  undoVideoProject,
  redoVideoProject,
  getVideoProjectInspector,
  closeVideoProject,
  relinkVideoProjectAsset,
  pickVideoSource,
  probeVideoSource,
  prepareVideoAsset,
  pickVideoExportPath,
  startVideoRender,
  cancelVideoRender,
  listenVideoRenderEvents,
  listMediaJobs,
  getMediaJobEvents,
  cancelMediaJob,
  retryMediaJob,
  reauthorizeMediaJobOutput,
  getMediaCacheStatus,
  clearLegacyMediaCache,
  loadManagedTranscriptArtifact,
  listenMediaJobEvents,
  convertFileSrc,
} satisfies VideoBackend;
