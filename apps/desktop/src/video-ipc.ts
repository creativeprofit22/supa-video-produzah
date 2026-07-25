import {
  mediaProbeSchema,
  prepareVideoAssetRequestSchema,
  preparedVideoAssetSchema,
  VideoDomainError,
  videoErrorCodes,
  videoToolStatusSchema,
} from "@supa-video/contracts";
import type {
  MediaProbe,
  PreparedVideoAsset,
  PrepareVideoAssetRequest,
  VideoErrorCode,
  VideoToolStatus,
} from "@supa-video/contracts";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const selectedSourceSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((path) => !path.includes("\0"))
  .nullable();
const videoErrorCodeSet = new Set<string>(videoErrorCodes);

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
  return parseResponse(selectedSourceSchema.safeParse(response));
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
