/*
 * QC and delivery contracts shared by the render worker events, the QC
 * package and the Review / Deliver UI. Mirrors `video/qc.rs` and
 * `video/delivery.rs` in the desktop backend.
 */
import { z } from "zod";

export const QC_FINDING_KIND = {
  blackFrames: "black_frames",
  freezeFrames: "freeze_frames",
  silence: "silence",
  audioClipping: "audio_clipping",
  loudnessOffTarget: "loudness_off_target",
  subtitleOutOfBounds: "subtitle_out_of_bounds",
  readingTimeShort: "reading_time_short",
  textOutsideSafeArea: "text_outside_safe_area",
  textOverlap: "text_overlap",
  missingMedia: "missing_media",
  repeatedAsset: "repeated_asset",
  uncoveredBeat: "uncovered_beat",
  mustShowMissing: "must_show_missing",
  mustNotShowPresent: "must_not_show_present",
  rightsBlocked: "rights_blocked",
  motionStutter: "motion_stutter",
  motionDrift: "motion_drift",
  motionCutJump: "motion_cut_jump",
  cutOffMusicBeat: "cut_off_music_beat",
  musicFit: "music_fit",
  shotLengthOutOfRange: "shot_length_out_of_range",
  steadyShotRun: "steady_shot_run",
} as const;
export type QcFindingKind = (typeof QC_FINDING_KIND)[keyof typeof QC_FINDING_KIND];

export const QC_SEVERITY = { blocker: "blocker", warning: "warning", info: "info" } as const;
export type QcSeverity = (typeof QC_SEVERITY)[keyof typeof QC_SEVERITY];

export const QC_SOURCE = {
  deterministic: "deterministic",
  editorial: "editorial",
  rights: "rights",
} as const;
export type QcSource = (typeof QC_SOURCE)[keyof typeof QC_SOURCE];

export const QC_STATUS = { passed: "passed", warnings: "warnings", blocked: "blocked" } as const;
export type QcStatus = (typeof QC_STATUS)[keyof typeof QC_STATUS];

const kindValues = Object.values(QC_FINDING_KIND) as [QcFindingKind, ...QcFindingKind[]];
const severityValues = Object.values(QC_SEVERITY) as [QcSeverity, ...QcSeverity[]];
const sourceValues = Object.values(QC_SOURCE) as [QcSource, ...QcSource[]];
const statusValues = Object.values(QC_STATUS) as [QcStatus, ...QcStatus[]];

export const qcSha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Microsecond range on the output timeline (end exclusive, end >= start). */
export const qcRangeSchema = z
  .strictObject({
    startUs: z.number().int().safe().nonnegative(),
    endUs: z.number().int().safe().nonnegative(),
  })
  .refine((range) => range.endUs >= range.startUs, { message: "range end before start" });
export type QcRange = z.infer<typeof qcRangeSchema>;

export const QC_FINDING_MESSAGE_MAX = 480;
export const QC_FINDING_SUBJECT_MAX = 128;
export const QC_MAX_FINDINGS = 512;

export const qcFindingSchema = z.strictObject({
  findingId: qcSha256HexSchema,
  kind: z.enum(kindValues),
  severity: z.enum(severityValues),
  source: z.enum(sourceValues),
  /**
   * Stable subject inside the range. Part of the `findingId` hash. One of:
   * - an asset id, beat id or caption id;
   * - `"<graphicsClipId>:<layerIndex>"` for a graphics text layer;
   * - for `text_overlap`, the two involved subjects sorted (byte order) and
   *   joined with `+`, e.g. `"<captionId>+<graphicsClipId>:0"`;
   * - `""` when there is none.
   */
  subject: z.string().max(QC_FINDING_SUBJECT_MAX),
  range: qcRangeSchema,
  message: z.string().min(1).max(QC_FINDING_MESSAGE_MAX),
});
export type QcFinding = z.infer<typeof qcFindingSchema>;

/** QC result attached to a completed render event. */
export const renderQcResultSchema = z.strictObject({
  status: z.enum(statusValues),
  findings: z.array(qcFindingSchema).max(QC_MAX_FINDINGS),
  manifestPath: z.string().min(1).max(32_768),
  manifestSha256: qcSha256HexSchema,
});
export type RenderQcResult = z.infer<typeof renderQcResultSchema>;

/** Error `details.category` values the render worker uses for QC failures. */
export const QC_FAILURE_CATEGORY = {
  invalidEditorialEvaluation: "invalid_editorial_evaluation",
  qcReleaseBlocked: "qc_release_blocked",
  qcUnavailable: "qc_unavailable",
  manifestWrite: "manifest_write",
} as const;
export type QcFailureCategory = (typeof QC_FAILURE_CATEGORY)[keyof typeof QC_FAILURE_CATEGORY];

export const DELIVERY_PRESET_ID = {
  landscape: "landscape_16x9_1080p",
  portrait: "portrait_9x16_1080p",
  square: "square_1x1_1080p",
} as const;
export type DeliveryPresetId = (typeof DELIVERY_PRESET_ID)[keyof typeof DELIVERY_PRESET_ID];
const presetIdValues = Object.values(DELIVERY_PRESET_ID) as [
  DeliveryPresetId,
  ...DeliveryPresetId[],
];

/** Text-safe insets per side in permille (top/bottom of height, left/right of width). */
export const safeAreaPermilleSchema = z.strictObject({
  top: z.number().int().min(0).max(450),
  right: z.number().int().min(0).max(450),
  bottom: z.number().int().min(0).max(450),
  left: z.number().int().min(0).max(450),
});
export type SafeAreaPermille = z.infer<typeof safeAreaPermilleSchema>;

export const deliveryPresetSchema = z.strictObject({
  id: z.enum(presetIdValues),
  label: z.string().min(1).max(64),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(7680),
  container: z.literal("mp4"),
  videoCodec: z.literal("h264"),
  audioCodec: z.literal("aac"),
  captions: z.enum(["burn_in", "sidecar"]),
  /** Thumbnail frame as a permille of duration (0 = first frame). */
  thumbnailAtPermille: z.number().int().min(0).max(1000),
  /** Area text must stay inside; mirrors `safe_area` in `video/delivery.rs`. */
  safeArea: safeAreaPermilleSchema,
});
export type DeliveryPreset = z.infer<typeof deliveryPresetSchema>;

export const DELIVERY_PRESETS: readonly DeliveryPreset[] = [
  {
    id: DELIVERY_PRESET_ID.landscape,
    label: "Landscape 16:9 (1920×1080)",
    width: 1920,
    height: 1080,
    safeArea: { top: 50, right: 50, bottom: 50, left: 50 },
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    captions: "burn_in",
    thumbnailAtPermille: 100,
  },
  {
    id: DELIVERY_PRESET_ID.portrait,
    label: "Vertical 9:16 (1080×1920)",
    // The safe area stays clear of the social apps' top bar, side buttons and caption UI.
    width: 1080,
    height: 1920,
    safeArea: { top: 120, right: 120, bottom: 200, left: 60 },
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    captions: "burn_in",
    thumbnailAtPermille: 100,
  },
  {
    id: DELIVERY_PRESET_ID.square,
    label: "Square 1:1 (1080×1080)",
    width: 1080,
    height: 1080,
    safeArea: { top: 50, right: 50, bottom: 50, left: 50 },
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    captions: "burn_in",
    thumbnailAtPermille: 100,
  },
];

export function deliveryPresetById(id: DeliveryPresetId): DeliveryPreset | undefined {
  return DELIVERY_PRESETS.find((preset) => preset.id === id);
}
