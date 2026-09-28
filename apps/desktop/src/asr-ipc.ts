import {
  asrConsentRequestSchema,
  asrRuntimeStatusSchema,
  startTranscriptionRequestSchema,
  transcriptionJobResultSchema,
  transcriptionResultRequestSchema,
  transcriptionStartedSchema,
} from "@supa-video/media";
import type {
  AsrRuntimeStatus,
  StartTranscriptionRequest,
  TranscriptionJobResult,
  TranscriptionStarted,
} from "@supa-video/media";
import { invoke } from "@tauri-apps/api/core";

import { normalizeVideoCommandError, VideoIpcResponseError } from "./video-ipc";

async function invokeAsrCommand(command: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    return await invoke<unknown>(command, args);
  } catch (error) {
    throw normalizeVideoCommandError(error);
  }
}

function parsed<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) {
    throw new VideoIpcResponseError();
  }
  return result.data;
}

export async function getAsrRuntimeStatus(): Promise<AsrRuntimeStatus> {
  const response = await invokeAsrCommand("video_asr_runtime_status");
  return parsed(asrRuntimeStatusSchema.safeParse(response));
}

/** Opens a native folder picker; resolves `null` when the user cancels. */
export async function chooseAsrRuntimeFolder(): Promise<AsrRuntimeStatus | null> {
  const response = await invokeAsrCommand("video_asr_set_runtime");
  return parsed(asrRuntimeStatusSchema.nullable().safeParse(response));
}

export async function setAsrConsent(
  accepted: boolean,
  manifestSha256: string,
): Promise<AsrRuntimeStatus> {
  const request = asrConsentRequestSchema.parse({ accepted, manifestSha256 });
  const response = await invokeAsrCommand("video_asr_accept_consent", { request });
  return parsed(asrRuntimeStatusSchema.safeParse(response));
}

export async function startTranscription(
  request: StartTranscriptionRequest,
): Promise<TranscriptionStarted> {
  const validated = startTranscriptionRequestSchema.parse(request);
  const response = await invokeAsrCommand("video_start_transcription", { request: validated });
  return parsed(transcriptionStartedSchema.safeParse(response));
}

export async function getTranscriptionResult(jobId: string): Promise<TranscriptionJobResult> {
  const request = transcriptionResultRequestSchema.parse({ jobId });
  const response = await invokeAsrCommand("video_transcription_result", { request });
  return parsed(transcriptionJobResultSchema.safeParse(response));
}

export interface TranscriptionBackend {
  readonly getAsrRuntimeStatus: typeof getAsrRuntimeStatus;
  readonly chooseAsrRuntimeFolder: typeof chooseAsrRuntimeFolder;
  readonly setAsrConsent: typeof setAsrConsent;
  readonly startTranscription: typeof startTranscription;
  readonly getTranscriptionResult: typeof getTranscriptionResult;
}

export const tauriTranscriptionBackend = {
  getAsrRuntimeStatus,
  chooseAsrRuntimeFolder,
  setAsrConsent,
  startTranscription,
  getTranscriptionResult,
} satisfies TranscriptionBackend;

export type SubtitleFileFormat = "srt" | "vtt" | "ass";

/** Opens a native save dialog; resolves the granted path or `null` on cancel. */
export async function pickSubtitlePath(
  format: SubtitleFileFormat,
  defaultName: string,
): Promise<string | null> {
  const response = await invokeAsrCommand("video_pick_subtitle_path", {
    request: { format, defaultName },
  });
  if (response === null) return null;
  if (typeof response !== "string" || response.length === 0) throw new VideoIpcResponseError();
  return response;
}

export async function writeSubtitles(
  format: SubtitleFileFormat,
  path: string,
  contents: string,
): Promise<void> {
  await invokeAsrCommand("video_write_subtitles", { request: { format, path, contents } });
}
