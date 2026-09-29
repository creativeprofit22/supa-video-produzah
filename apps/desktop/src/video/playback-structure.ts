import {
  isTrackHidden,
  rescaleRationalTime,
  type RationalRate,
  type RationalTime,
  type VideoSequenceV2,
} from "@supa-video/contracts";

import { clockLayerAtTimelineFrame, layerIsActiveAtTimelineFrame } from "./layer-clock";
import type { ProgramMonitorCaption, ProgramMonitorLayer } from "./ProgramMonitor";
import { previewMediaWindow } from "./preview-media-window";

export function activeCaptionCuesForTimelineFrame(
  sequence: VideoSequenceV2 | null,
  timelineFrame: number | null,
): readonly ProgramMonitorCaption[] {
  if (sequence === null || timelineFrame === null) return [];
  const isActive = (start: RationalTime, end: RationalTime): boolean =>
    rescaleRationalTime(start, sequence.rate, "floor").value <= timelineFrame &&
    timelineFrame < rescaleRationalTime(end, sequence.rate, "ceil").value;
  // Same sources as export (compile-render-plan trackRenderCaptions): legacy items plus the
  // active caption artifact, which is where generated captions live.
  return sequence.tracks.flatMap((track) => {
    if (track.kind !== "caption" || isTrackHidden(track)) return [];
    const legacy = track.captions.flatMap((caption) =>
      isActive(caption.start, caption.end) ? [{ captionId: caption.id, text: caption.text }] : [],
    );
    const generated = (track.activeCaptionArtifact?.cues ?? []).flatMap((cue) =>
      isActive(cue.start, cue.end) ? [{ captionId: cue.cueId, text: cue.lines.join("\n") }] : [],
    );
    return [...legacy, ...generated];
  });
}

function layerTimelineEnd(layer: ProgramMonitorLayer): number {
  return (
    layer.timelineStartFrame +
    (layer.timelineDurationFrames ?? layer.sourceOutFrame - layer.sourceInFrame)
  );
}

/** Composition bounds owned by every source layer, including hidden and audio-only clips. */
export function compositionTimelineBounds(
  layers: readonly ProgramMonitorLayer[],
): { readonly start: number; readonly end: number } | null {
  if (layers.length === 0) return null;
  return {
    start: Math.min(...layers.map((layer) => layer.timelineStartFrame)),
    end: Math.max(...layers.map(layerTimelineEnd)),
  };
}

export const LEGACY_PLAYBACK_STRUCTURE_KEY = "legacy";

/**
 * Identity of everything the editor renders structurally at a timeline frame:
 * the clock layer, active layers, the loaded media window and active captions.
 * Two frames with the same key render the same element tree, so playback may
 * skip React commits between them. Uses the render's own functions so there is
 * a single source of truth for every boundary.
 */
export function playbackStructureKey(
  frame: number,
  layers: readonly ProgramMonitorLayer[],
  rate: RationalRate,
  sequence: VideoSequenceV2 | null,
  bounds: { readonly start: number; readonly end: number } | null = compositionTimelineBounds(
    layers,
  ),
): string {
  if (layers.length === 0) return LEGACY_PLAYBACK_STRUCTURE_KEY;
  const inRange = bounds !== null && bounds.start <= frame && frame < bounds.end;
  // Outside the composition the workspace falls back to another frame source;
  // commit every frame there rather than guess what it renders.
  if (!inRange) return `out:${frame}`;
  const clockId = clockLayerAtTimelineFrame(layers, frame)?.clipId ?? "";
  const active: string[] = [];
  for (const layer of layers) {
    if (layerIsActiveAtTimelineFrame(layer, frame)) active.push(layer.clipId);
  }
  const loaded = previewMediaWindow(layers, frame, rate, clockId === "" ? undefined : clockId).map(
    (layer) => layer.clipId,
  );
  const captions =
    active.length > 0
      ? activeCaptionCuesForTimelineFrame(sequence, frame).map((caption) => caption.captionId)
      : [];
  return JSON.stringify([clockId, active, loaded, captions]);
}
