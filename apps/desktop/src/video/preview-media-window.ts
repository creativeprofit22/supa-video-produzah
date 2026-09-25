import type { RationalRate } from "@supa-video/contracts";
import type { ProgramMonitorLayer } from "./ProgramMonitor";

/** All active layers, the clock (including gaps), and at most one nearby neighbour
 * on either side per track. The one-second window is in sequence time, not source time.
 * Total loaded media follows simultaneous layers/tracks, never total timeline length. */
export function previewMediaWindow(
  layers: readonly ProgramMonitorLayer[],
  frame: number,
  rate: RationalRate,
  clockClipId: string | undefined,
): readonly ProgramMonitorLayer[] {
  const windowFrames = Math.ceil(rate.numerator / rate.denominator);
  const selected = new Set<string>();
  const previous = new Map<number, { layer: ProgramMonitorLayer; end: number }>();
  const next = new Map<number, ProgramMonitorLayer>();
  for (const layer of layers) {
    const end =
      layer.timelineStartFrame +
      (layer.timelineDurationFrames ?? layer.sourceOutFrame - layer.sourceInFrame);
    if (layer.clipId === clockClipId || (layer.timelineStartFrame <= frame && frame < end)) {
      selected.add(layer.clipId);
    }
    if (end <= frame && frame - end <= windowFrames) {
      const candidate = previous.get(layer.canonicalTrackIndex);
      if (!candidate || end > candidate.end)
        previous.set(layer.canonicalTrackIndex, { layer, end });
    }
    if (layer.timelineStartFrame > frame && layer.timelineStartFrame - frame <= windowFrames) {
      const candidate = next.get(layer.canonicalTrackIndex);
      if (!candidate || layer.timelineStartFrame < candidate.timelineStartFrame)
        next.set(layer.canonicalTrackIndex, layer);
    }
  }
  for (const { layer } of previous.values()) selected.add(layer.clipId);
  for (const layer of next.values()) selected.add(layer.clipId);
  return layers.filter((layer) => selected.has(layer.clipId));
}
