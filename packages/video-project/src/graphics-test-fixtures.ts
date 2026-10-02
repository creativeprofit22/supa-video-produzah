// Shared graphics-track fixtures for package tests.
// Not exported from the package entry point.
import type {
  GraphicsClip,
  GraphicsProjectTrack,
  ProjectProjection,
  RationalRate,
} from "@supa-video/contracts";

const hold = (value: number) => [{ timeMicroseconds: 0, value }];

export function fixtureGraphicsClip(
  id: string,
  rate: RationalRate,
  startFrame: number,
  durationFrames: number,
  text = "Title",
): GraphicsClip {
  return {
    graphicsVersion: 1,
    id,
    timelineStart: {
      value: startFrame,
      rateNumerator: rate.numerator,
      rateDenominator: rate.denominator,
    },
    duration: {
      value: durationFrames,
      rateNumerator: rate.numerator,
      rateDenominator: rate.denominator,
    },
    fontKey: "segoe-ui-bold",
    layers: [
      {
        kind: "text",
        text,
        fontSize: 48,
        fill: "#FFFFFF",
        x: hold(100),
        y: hold(100),
        scale: hold(1),
        rotation: hold(0),
        opacity: hold(1),
      },
    ],
  };
}

export function fixtureGraphicsTrack(
  trackId: string,
  clips: readonly GraphicsClip[],
): GraphicsProjectTrack {
  return { id: trackId, name: "Graphics 1", kind: "graphics", graphicsClips: [...clips] };
}

/** The same projection with a one-clip graphics track appended to every sequence. */
export function withGraphicsTrack(
  projection: ProjectProjection,
  trackId = "9a000000-0000-4000-8000-000000000001",
  clipId = "9a000000-0000-4000-8000-000000000002",
): ProjectProjection {
  return {
    ...projection,
    state: {
      ...projection.state,
      sequences: projection.state.sequences.map((sequence) => ({
        ...sequence,
        tracks: [
          ...sequence.tracks,
          fixtureGraphicsTrack(trackId, [fixtureGraphicsClip(clipId, sequence.rate, 0, 5)]),
        ],
      })),
    },
  };
}
