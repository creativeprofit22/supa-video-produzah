import {
  loadMusicBeatAnalysisRequestSchema,
  musicBeatAnalysisV1Schema,
  musicBeatDetectionResultRequestSchema,
  musicBeatDetectionResultSchema,
  musicBeatDetectionStartedSchema,
  musicBeatRuntimeStatusSchema,
  startMusicBeatDetectionRequestSchema,
} from "@supa-video/media";
import type {
  MusicBeatAnalysisV1,
  MusicBeatDetectionResult,
  MusicBeatDetectionStarted,
  MusicBeatRuntimeStatus,
  StartMusicBeatDetectionRequest,
} from "@supa-video/media";
import { invoke } from "@tauri-apps/api/core";

import { normalizeVideoCommandError, VideoIpcResponseError } from "./video-ipc";

async function invokeMusicBeatCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
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

export async function getMusicBeatRuntimeStatus(): Promise<MusicBeatRuntimeStatus> {
  const response = await invokeMusicBeatCommand("video_music_beat_runtime_status");
  return parsed(musicBeatRuntimeStatusSchema.safeParse(response));
}

/** Opens a native folder picker; resolves `null` when the user cancels. */
export async function chooseMusicBeatRuntimeFolder(): Promise<MusicBeatRuntimeStatus | null> {
  const response = await invokeMusicBeatCommand("video_music_beat_set_runtime");
  return parsed(musicBeatRuntimeStatusSchema.nullable().safeParse(response));
}

/** Starts detection: Beat This! when its runtime is ready, else the in-app fallback. */
export async function startMusicBeatDetection(
  request: StartMusicBeatDetectionRequest,
): Promise<MusicBeatDetectionStarted> {
  const validated = startMusicBeatDetectionRequestSchema.parse(request);
  const response = await invokeMusicBeatCommand("video_start_music_beat_detection", {
    request: validated,
  });
  return parsed(musicBeatDetectionStartedSchema.safeParse(response));
}

export async function getMusicBeatDetectionResult(
  jobId: string,
): Promise<MusicBeatDetectionResult> {
  const request = musicBeatDetectionResultRequestSchema.parse({ jobId });
  const response = await invokeMusicBeatCommand("video_music_beat_detection_result", { request });
  return parsed(musicBeatDetectionResultSchema.safeParse(response));
}

export async function loadMusicBeatAnalysis(analysisKey: string): Promise<MusicBeatAnalysisV1> {
  const request = loadMusicBeatAnalysisRequestSchema.parse({ analysisKey });
  const response = await invokeMusicBeatCommand("video_load_music_beat_analysis", { request });
  return parsed(musicBeatAnalysisV1Schema.safeParse(response));
}

export interface MusicBeatBackend {
  readonly getMusicBeatRuntimeStatus: typeof getMusicBeatRuntimeStatus;
  readonly chooseMusicBeatRuntimeFolder: typeof chooseMusicBeatRuntimeFolder;
  readonly startMusicBeatDetection: typeof startMusicBeatDetection;
  readonly getMusicBeatDetectionResult: typeof getMusicBeatDetectionResult;
  readonly loadMusicBeatAnalysis: typeof loadMusicBeatAnalysis;
}

export const tauriMusicBeatBackend = {
  getMusicBeatRuntimeStatus,
  chooseMusicBeatRuntimeFolder,
  startMusicBeatDetection,
  getMusicBeatDetectionResult,
  loadMusicBeatAnalysis,
} satisfies MusicBeatBackend;
