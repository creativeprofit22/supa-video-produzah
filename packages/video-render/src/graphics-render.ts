/**
 * Graphics clips in the multi-track render plan (docs/adr/0003-graphics-clips.md).
 *
 * Each visible graphics clip becomes one sentinel FFmpeg input `graphics:<index>` that the native
 * renderer replaces with a rendered transparent overlay, shifted to the clip start and composited
 * over the clip's window. Rust rebuilds the same argv from the plan (`expected_v2_filter`).
 */
import {
  graphicsInputSentinel,
  isTrackHidden,
  MAX_RENDER_GRAPHICS_INPUTS,
  type RationalRate,
  type RationalTime,
  rationalTimeToMicroseconds,
  type RenderGraphicsInputV2,
  type VideoProjectStateV2,
  VideoDomainError,
} from "@supa-video/contracts";

type Sequence = VideoProjectStateV2["sequences"][number];
type Asset = VideoProjectStateV2["assets"][number];

export const MAX_GRAPHICS_CANVAS_SIDE = 4096;
/**
 * Export limits per graphics clip. They mirror the renderer description bounds `MAX_IMAGES` and
 * `MAX_TOTAL_IMAGE_BYTES` in apps/desktop/src-tauri/graphics-renderer/src/description.rs, so a
 * plan that compiles never fails mid-export on them.
 */
export const MAX_GRAPHICS_IMAGES_PER_CLIP = 16;
export const MAX_GRAPHICS_IMAGE_BYTES_PER_CLIP = 40 * 1024 * 1024;

function graphicsPlanError(message: string, details: Record<string, unknown> = {}): never {
  throw new VideoDomainError("invalid_render_plan", message, { category: "graphics", ...details });
}

function micros(time: RationalTime): number {
  return rationalTimeToMicroseconds(time, "nearestTiesAwayFromZero");
}

function usesRate(time: RationalTime, rate: RationalRate): boolean {
  return time.rateNumerator === rate.numerator && time.rateDenominator === rate.denominator;
}

/**
 * Visible graphics clips that start before the export ends, in compositing order: graphics tracks
 * bottom-up (the first track in the sequence ends on top, like video tracks), clips by start.
 */
export function compileGraphicsInputs(
  sequence: Sequence,
  durationMicroseconds: number,
  imagePathsByAssetId: Readonly<Record<string, string>>,
  assets: readonly Asset[],
): RenderGraphicsInputV2[] {
  const fileSizeByAssetId = new Map(assets.map((asset) => [asset.id, asset.probe.fileSizeBytes]));
  const tracks = sequence.tracks.filter(
    (track): track is Extract<Sequence["tracks"][number], { kind: "graphics" }> =>
      track.kind === "graphics" && !isTrackHidden(track),
  );
  const inputs = [...tracks].reverse().flatMap((track) =>
    track.graphicsClips.flatMap((clip): RenderGraphicsInputV2[] => {
      if (!usesRate(clip.timelineStart, sequence.rate) || !usesRate(clip.duration, sequence.rate))
        graphicsPlanError("Graphics clips must use the sequence rate", { graphicsClipId: clip.id });
      const startMicroseconds = micros(clip.timelineStart);
      if (startMicroseconds >= durationMicroseconds) return [];
      const endMicroseconds = micros({
        ...clip.timelineStart,
        value: clip.timelineStart.value + clip.duration.value,
      });
      const imageAssetIds = [
        ...new Set(clip.layers.flatMap((layer) => (layer.kind === "image" ? [layer.assetId] : []))),
      ].sort();
      if (imageAssetIds.length > MAX_GRAPHICS_IMAGES_PER_CLIP)
        graphicsPlanError(
          `A graphics clip can use at most ${String(MAX_GRAPHICS_IMAGES_PER_CLIP)} different images in an export`,
          { graphicsClipId: clip.id, imageCount: imageAssetIds.length },
        );
      const imageBytes = imageAssetIds.reduce((total, assetId) => {
        const size = fileSizeByAssetId.get(assetId);
        if (size === undefined)
          graphicsPlanError("Every graphics image layer must reference a project asset", {
            assetId,
          });
        return total + size;
      }, 0);
      if (imageBytes > MAX_GRAPHICS_IMAGE_BYTES_PER_CLIP)
        graphicsPlanError(
          `The images in one graphics clip can total at most ${String(MAX_GRAPHICS_IMAGE_BYTES_PER_CLIP / (1024 * 1024))} MB in an export`,
          { graphicsClipId: clip.id, imageBytes },
        );
      const imagePaths = Object.fromEntries(
        imageAssetIds.map((assetId) => {
          const path = imagePathsByAssetId[assetId];
          if (typeof path !== "string")
            graphicsPlanError("Every graphics image layer requires an input path", { assetId });
          return [assetId, path] as const;
        }),
      );
      return [
        {
          trackId: track.id,
          clip,
          startMicroseconds,
          endMicroseconds,
          imagePathsByAssetId: imagePaths,
        },
      ];
    }),
  );
  if (inputs.length > MAX_RENDER_GRAPHICS_INPUTS)
    graphicsPlanError(
      `At most ${String(MAX_RENDER_GRAPHICS_INPUTS)} graphics clips can be exported per sequence`,
      { graphicsClipCount: inputs.length },
    );
  if (
    inputs.length > 0 &&
    (sequence.width % 2 !== 0 ||
      sequence.height % 2 !== 0 ||
      sequence.width > MAX_GRAPHICS_CANVAS_SIDE ||
      sequence.height > MAX_GRAPHICS_CANVAS_SIDE)
  )
    graphicsPlanError(
      `Graphics export needs an even canvas of at most ${String(MAX_GRAPHICS_CANVAS_SIDE)} px per side`,
    );
  return inputs;
}

/** FFmpeg input arguments: one sentinel per overlay, swapped for a scratch file at run time. */
export function graphicsInputArguments(graphics: readonly RenderGraphicsInputV2[]): string[] {
  return graphics.flatMap((_input, index) => ["-i", graphicsInputSentinel(index)]);
}

/**
 * Filter steps compositing every overlay over `baseLabel`. Returns the new base label.
 * `firstInputIndex` is the FFmpeg input index of the first sentinel.
 */
export function graphicsOverlayFilters(
  graphics: readonly RenderGraphicsInputV2[],
  firstInputIndex: number,
  baseLabel: string,
  formatSeconds: (microseconds: number) => string,
): { readonly parts: string[]; readonly baseLabel: string } {
  const parts: string[] = [];
  let base = baseLabel;
  graphics.forEach((input, index) => {
    const start = formatSeconds(input.startMicroseconds);
    const end = formatSeconds(input.endMicroseconds);
    parts.push(
      `[${String(firstInputIndex + index)}:v:0]setpts=PTS-STARTPTS+${start}/TB[g${String(index)}]`,
      `[${base}][g${String(index)}]overlay=x=0:y=0:eof_action=pass:format=auto:enable='gte(t\\,${start})*lt(t\\,${end})'[gfx${String(index)}]`,
    );
    base = `gfx${String(index)}`;
  });
  return { parts, baseLabel: base };
}
