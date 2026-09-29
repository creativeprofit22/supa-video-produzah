import type { APIRequestContext } from "@playwright/test";
import { z } from "zod";

// Known media-time events written by generate-speed-parity.mjs from the same ffmpeg filters that
// speed_export_parity.rs verifies. The gate measures each channel against this ground truth instead
// of comparing two live clocks through the machine's audio output path.
const clipEventsSchema = z.object({
  fpsNumerator: z.number().int().positive(),
  fpsDenominator: z.number().int().positive(),
  eventFrame: z.number().int().nonnegative(),
  audioEventFrame: z.number().int().nonnegative(),
  burstStartSeconds: z.number().nonnegative(),
  burstEndSeconds: z.number().nonnegative(),
});
const eventsFileSchema = z.object({ clips: z.record(z.string(), clipEventsSchema) });

export type ClipEvents = Readonly<z.infer<typeof clipEventsSchema>>;

export async function loadClipEvents(
  request: APIRequestContext,
  clipName: string,
): Promise<ClipEvents> {
  const response = await request.get("/browser-tests/speed-parity-events.json");
  if (!response.ok()) throw new Error(`speed-parity-events.json unavailable: ${response.status()}`);
  const clip = eventsFileSchema.parse(await response.json()).clips[clipName];
  if (!clip) throw new Error(`speed-parity-events.json has no entry for ${clipName}`);
  return clip;
}

/** Context-clock and media-clock pair read in the same task, taken at a `playing` event. */
export type PlaybackAnchor = Readonly<{ context: number; media: number; rate: number }>;

/** Maps an AudioContext render time to element media time through the latest earlier anchor. */
export function audioMediaTime(
  contextTime: number,
  anchors: readonly PlaybackAnchor[],
): { mediaTime: number; anchor: PlaybackAnchor } | null {
  const anchor = anchors.filter((candidate) => candidate.context <= contextTime).at(-1);
  if (!anchor) return null;
  return { mediaTime: anchor.media + (contextTime - anchor.context) * anchor.rate, anchor };
}

export type KnownTimeResult = Readonly<{
  expectedMediaSeconds: number;
  videoErrorFrames: number;
  audioErrorFrames: number;
  differenceFrames: number;
}>;

/**
 * Errors are in sequence frames. `sequenceFramesPerMediaSecond` is fps for 1x media (final exports,
 * raw clips) and fps / speed for preview, where the element plays source media at `speed`.
 */
export function knownTimeGate(input: {
  expectedMediaSeconds: number;
  videoMediaSeconds: number;
  audioMediaSeconds: number;
  sequenceFramesPerMediaSecond: number;
}): KnownTimeResult {
  const videoErrorFrames =
    (input.videoMediaSeconds - input.expectedMediaSeconds) * input.sequenceFramesPerMediaSecond;
  const audioErrorFrames =
    (input.audioMediaSeconds - input.expectedMediaSeconds) * input.sequenceFramesPerMediaSecond;
  return {
    expectedMediaSeconds: input.expectedMediaSeconds,
    videoErrorFrames,
    audioErrorFrames,
    differenceFrames: audioErrorFrames - videoErrorFrames,
  };
}
