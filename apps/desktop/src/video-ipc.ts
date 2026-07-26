import {
  absoluteNativePathSchema,
  mediaProbeSchema,
  openedVideoProjectSchema,
  prepareVideoAssetRequestSchema,
  preparedVideoAssetSchema,
  renderPlanV1Schema,
  VideoDomainError,
  videoErrorCodes,
  videoProjectFileV1Schema,
  videoRenderEventSchema,
  videoRenderStartedSchema,
  videoToolStatusSchema,
} from "@supa-video/contracts";
import type {
  MediaProbe,
  OpenedVideoProject,
  PreparedVideoAsset,
  PrepareVideoAssetRequest,
  RenderPlanV1,
  VideoErrorCode,
  VideoProjectFileV1,
  VideoRenderEvent,
  VideoRenderStarted,
  VideoToolStatus,
} from "@supa-video/contracts";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";

const selectedPathSchema = absoluteNativePathSchema.nullable();
const emptyCommandResponseSchema = z.null();
const videoErrorCodeSet = new Set<string>(videoErrorCodes);
const VIDEO_RENDER_EVENT = "video:render-event";

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

export async function openVideoProject(): Promise<OpenedVideoProject | null> {
  const response = await invokeVideoCommand("video_open_project");
  return parseResponse(openedVideoProjectSchema.nullable().safeParse(response));
}

export async function saveVideoProject(
  path: string,
  document: Readonly<VideoProjectFileV1>,
): Promise<void> {
  const validatedPath = absoluteNativePathSchema.parse(path);
  const validatedDocument = videoProjectFileV1Schema.parse(document);
  const response = await invokeVideoCommand("video_save_project", {
    path: validatedPath,
    document: validatedDocument,
  });
  parseResponse(emptyCommandResponseSchema.safeParse(response));
}

export async function pickVideoExportPath(defaultName: string): Promise<string | null> {
  const response = await invokeVideoCommand("video_pick_export_path", { defaultName });
  return parseResponse(selectedPathSchema.safeParse(response));
}

export async function probeVideoSource(path: string): Promise<MediaProbe> {
  const response = await invokeVideoCommand("video_probe_media", { path });
  return parseResponse(mediaProbeSchema.safeParse(response));
}

export async function prepareVideoAsset(
  request: PrepareVideoAssetRequest,
): Promise<PreparedVideoAsset> {
  const args = prepareVideoAssetRequestSchema.parse(request);
  const response = await invokeVideoCommand("video_prepare_asset", args);
  return parseResponse(preparedVideoAssetSchema.safeParse(response));
}

export async function startVideoRender(
  plan: RenderPlanV1,
  overwrite: boolean,
): Promise<VideoRenderStarted> {
  const validatedPlan = renderPlanV1Schema.parse(plan);
  const response = await invokeVideoCommand("video_start_render", {
    plan: validatedPlan,
    overwrite,
  });
  return parseResponse(videoRenderStartedSchema.safeParse(response));
}

export async function cancelVideoRender(jobId: string): Promise<void> {
  const response = await invokeVideoCommand("video_cancel_render", { jobId });
  parseResponse(emptyCommandResponseSchema.safeParse(response));
}

type FailedVideoRenderEvent = Extract<VideoRenderEvent, { type: "failed" }>;

export type VideoRenderNotification =
  | Exclude<VideoRenderEvent, FailedVideoRenderEvent>
  | (Omit<FailedVideoRenderEvent, "error"> & { error: VideoDomainError });

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
  readonly openVideoProject: typeof openVideoProject;
  readonly saveVideoProject: typeof saveVideoProject;
  readonly pickVideoSource: typeof pickVideoSource;
  readonly probeVideoSource: typeof probeVideoSource;
  readonly prepareVideoAsset: typeof prepareVideoAsset;
  readonly pickVideoExportPath: typeof pickVideoExportPath;
  readonly startVideoRender: typeof startVideoRender;
  readonly cancelVideoRender: typeof cancelVideoRender;
  readonly listenVideoRenderEvents: typeof listenVideoRenderEvents;
  readonly convertFileSrc: typeof convertFileSrc;
}

export const tauriVideoBackend: VideoBackend = {
  getVideoToolStatus,
  pickNewVideoProjectPath,
  openVideoProject,
  saveVideoProject,
  pickVideoSource,
  probeVideoSource,
  prepareVideoAsset,
  pickVideoExportPath,
  startVideoRender,
  cancelVideoRender,
  listenVideoRenderEvents,
  convertFileSrc,
};
