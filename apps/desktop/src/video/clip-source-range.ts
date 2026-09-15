import {
  clipTimelineDuration,
  createRationalTime,
  rateOf,
  type ProjectClip,
  type RationalRate,
} from "@supa-video/contracts";

/** Canonical selected direct-asset timing, never the legacy trim draft. */
export interface SelectedMediaClip {
  sequenceId: string;
  trackId: string;
  clipId: string;
  label: string;
  locked: boolean;
  sourceIn: ProjectClip["sourceIn"];
  sourceOut: ProjectClip["sourceOut"];
  timelineStartFrame: number;
  totalAssetFrames: number;
  sequenceRate: RationalRate;
  speed?: ProjectClip["speed"];
  fades?: ProjectClip["fades"];
}

export function sourceRangeError(
  selection: SelectedMediaClip,
  inText: string,
  outText: string,
): string | null {
  const start = Number(inText),
    end = Number(outText);
  if (
    !inText.trim() ||
    !outText.trim() ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > selection.totalAssetFrames
  )
    return `Source range must contain positive whole frames within 0–${selection.totalAssetFrames}.`;
  try {
    const duration = clipTimelineDuration(
      {
        in: createRationalTime(start, rateOf(selection.sourceIn)),
        out: createRationalTime(end, rateOf(selection.sourceOut)),
      },
      selection.sequenceRate,
      selection.speed,
    ).value;
    if ((selection.fades?.inFrames ?? 0) + (selection.fades?.outFrames ?? 0) > duration)
      return "Source range is shorter than the existing audio fades. Edit fades first.";
    return null;
  } catch {
    return "Source range must map exactly to whole sequence frames at the current speed.";
  }
}
