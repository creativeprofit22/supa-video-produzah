import {
  DELIVERY_PRESETS,
  type DeliveryPreset,
  type DeliveryPresetId,
  type ProjectProjection,
  type RenderPlan,
  type UsePolicyProfile,
} from "@supa-video/contracts";
import { compileActiveSequenceRenderPlan } from "@supa-video/render";

/**
 * Compiles the delivery plan for one preset from the exact reviewed revision.
 * Only the output frame size changes; the revision id (and so the state hash
 * the worker checks) stays the reviewed one.
 */
export function compileDeliveryPlan(input: {
  readonly planId: string;
  readonly projection: Readonly<ProjectProjection>;
  readonly preset: DeliveryPreset;
  readonly inputPathsByAssetId: Readonly<Record<string, string>>;
  readonly outputPath: string;
  readonly intendedUse?: UsePolicyProfile;
}): Readonly<RenderPlan> {
  const { projection, preset } = input;
  const state = {
    ...projection.state,
    sequences: projection.state.sequences.map((sequence) =>
      sequence.id === projection.state.activeSequenceId
        ? { ...sequence, width: preset.width, height: preset.height }
        : sequence,
    ),
  };
  return compileActiveSequenceRenderPlan({
    planId: input.planId,
    revision: { revision: projection.revision, state },
    inputPathsByAssetId: input.inputPathsByAssetId,
    outputPath: input.outputPath,
    ...(input.intendedUse === undefined ? {} : { intendedUse: input.intendedUse }),
  });
}

/** Default file name for a preset output next to the reviewed export. */
export function deliveryFileName(baseName: string, presetId: DeliveryPresetId): string {
  const stem = baseName.replace(/\.mp4$/iu, "").slice(0, 80) || "export";
  const suffix = {
    landscape_16x9_1080p: "16x9",
    portrait_9x16_1080p: "9x16",
    square_1x1_1080p: "1x1",
  }[presetId];
  return `${stem}-${suffix}.mp4`;
}

export function presetById(id: DeliveryPresetId): DeliveryPreset {
  const preset = DELIVERY_PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) throw new Error(`Unknown delivery preset ${id}`);
  return preset;
}
