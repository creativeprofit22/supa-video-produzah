import { describe, expect, it } from "vitest";

import { videoErrorCodeSchema } from "./errors.js";
import {
  DELIVERY_PRESETS,
  DELIVERY_PRESET_ID,
  deliveryPresetById,
  deliveryPresetSchema,
  qcFindingSchema,
  renderQcResultSchema,
} from "./qc.js";
import { verifiedRenderOutputSchema } from "./render-plan.js";

const finding = {
  findingId: "a".repeat(64),
  kind: "black_frames",
  severity: "blocker",
  source: "deterministic",
  subject: "",
  range: { startUs: 0, endUs: 1_000_000 },
  message: "Black frames for 1.0 s",
} as const;

const probe = {
  durationMicroseconds: 4_000_000,
  averageFrameRate: { numerator: 30, denominator: 1 },
  realFrameRate: { numerator: 30, denominator: 1 },
  variableFrameRate: false,
  width: 1_920,
  height: 1_080,
  videoCodecName: "h264",
  audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
  fileSizeBytes: 12_000_000,
} as const;

describe("delivery presets", () => {
  it.each([
    [DELIVERY_PRESET_ID.landscape, 1920, 1080],
    [DELIVERY_PRESET_ID.portrait, 1080, 1920],
    [DELIVERY_PRESET_ID.square, 1080, 1080],
  ])("%s is %ix%i H.264/AAC MP4", (id, width, height) => {
    const preset = deliveryPresetById(id);
    expect(preset).toMatchObject({ width, height, container: "mp4", videoCodec: "h264" });
    expect(deliveryPresetSchema.parse(preset)).toEqual(preset);
  });

  it.each([
    [DELIVERY_PRESET_ID.landscape, { top: 50, right: 50, bottom: 50, left: 50 }],
    [DELIVERY_PRESET_ID.portrait, { top: 120, right: 120, bottom: 200, left: 60 }],
    [DELIVERY_PRESET_ID.square, { top: 50, right: 50, bottom: 50, left: 50 }],
  ])("%s defines its text safe area", (id, safeArea) => {
    expect(deliveryPresetById(id)?.safeArea).toEqual(safeArea);
  });

  it("has unique ids", () => {
    expect(new Set(DELIVERY_PRESETS.map((preset) => preset.id)).size).toBe(DELIVERY_PRESETS.length);
  });

  it.each([
    { container: "mov" },
    { videoCodec: "hevc" },
    { thumbnailAtPermille: 1001 },
    { safeArea: { top: 50, right: 50, bottom: 50 } },
    { safeArea: { top: 500, right: 50, bottom: 50, left: 50 } },
    { id: "custom" },
    { extra: true },
  ])("rejects %j", (patch) => {
    expect(deliveryPresetSchema.safeParse({ ...DELIVERY_PRESETS[0], ...patch }).success).toBe(
      false,
    );
  });
});

describe("QC contracts", () => {
  it("accepts a valid finding and rejects inverted ranges, unknown kinds and long messages", () => {
    expect(qcFindingSchema.parse(finding)).toEqual(finding);
    for (const bad of [
      { ...finding, range: { startUs: 2, endUs: 1 } },
      { ...finding, kind: "glitch" },
      { ...finding, message: "x".repeat(481) },
      { ...finding, findingId: "A".repeat(64) },
    ]) {
      expect(qcFindingSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("carries QC results on completed render output", () => {
    const qc = {
      status: "blocked",
      findings: [finding],
      manifestPath: "C:\\Exports\\clip.mp4.manifest.json",
      manifestSha256: "b".repeat(64),
    } as const;
    expect(renderQcResultSchema.parse(qc)).toEqual(qc);
    const output = { outputPath: "C:\\Exports\\clip.mp4", previewPath: "C:\\p.mp4", probe, qc };
    expect(verifiedRenderOutputSchema.parse(output)).toEqual(output);
    expect(
      verifiedRenderOutputSchema.safeParse({ ...output, qc: { ...qc, status: "ok" } }).success,
    ).toBe(false);
  });

  it.each(["invalid_editorial_evaluation", "qc_release_blocked", "qc_unavailable"])(
    "knows error code %s",
    (code) => {
      expect(videoErrorCodeSchema.parse(code)).toBe(code);
    },
  );
});
