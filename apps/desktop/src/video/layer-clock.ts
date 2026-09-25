import type { ProgramMonitorLayer } from "./ProgramMonitor";

function layerTimelineEndFrame(layer: ProgramMonitorLayer): number {
  return (
    layer.timelineStartFrame +
    (layer.timelineDurationFrames ?? layer.sourceOutFrame - layer.sourceInFrame)
  );
}

export function layerIsActiveAtTimelineFrame(layer: ProgramMonitorLayer, frame: number): boolean {
  return layer.timelineStartFrame <= frame && frame < layerTimelineEndFrame(layer);
}

export function clockLayerAtTimelineFrame(
  layers: readonly ProgramMonitorLayer[],
  frame: number,
): ProgramMonitorLayer | null {
  // Prefer a visible active clock, but hidden/audio clips still own time.
  const visibleLayers = layers.filter((layer) => !layer.hidden && !layer.audioOnly);
  return (
    visibleLayers.find((layer) => layerIsActiveAtTimelineFrame(layer, frame)) ??
    layers.find((layer) => layerIsActiveAtTimelineFrame(layer, frame)) ??
    layers.find((layer) => layer.timelineStartFrame >= frame) ??
    layers.at(-1) ??
    null
  );
}
