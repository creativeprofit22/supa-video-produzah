import {
  mediaProbeSchema,
  prepareVideoAssetRequestSchema,
  preparedVideoAssetSchema,
  renderPlanV1Schema,
  VideoDomainError,
  videoErrorCodes,
  videoRenderEventSchema,
  videoRenderStartedSchema,
  videoToolStatusSchema,
} from "@supa-video/contracts";
import type {
  MediaProbe,
  PreparedVideoAsset,
  PrepareVideoAssetRequest,
  RenderPlanV1,
  VideoErrorCode,
  VideoRenderEvent,
  VideoRenderStarted,
  VideoToolStatus,
} from "@supa-video/contracts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";

const selectedPathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((path) => !path.includes("\0"))
  .nullable();
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
