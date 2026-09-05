import { z } from "zod";

import { projectRevisionDescriptorV2Schema } from "./project-revision.js";
import { projectUuidSchema } from "./project.js";
import { mediaContentIdentityV1Schema, sha256DigestSchema } from "./source-content.js";
import {
  rationalRateSchema,
  rationalTimeSchema,
  type RationalRate,
  type RationalTime,
} from "./time.js";

const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
const safePositiveIntegerSchema = z.number().int().safe().positive();
const languageTagSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);
const cueIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/)
  .min(1)
  .max(128);
const transcriptWordIdSchema = z.string().min(1).max(256);
const rgbaColorSchema = z.string().regex(/^#[0-9a-f]{8}$/);

export const CAPTION_VALIDATION_ISSUE_CODES = [
  "CAPTION_SCHEMA_INVALID",
  "CAPTION_VERSION_UNSUPPORTED",
  "CAPTION_TRACK_LINK_INVALID",
  "CAPTION_STYLE_INVALID",
  "CAPTION_SAFE_AREA_INVALID",
  "CAPTION_DURATION_PROFILE_INVALID",
  "CAPTION_SOURCE_SPAN_INVALID",
  "CAPTION_SOURCE_WORD_DUPLICATE",
  "CAPTION_CUE_ID_DUPLICATE",
  "CAPTION_CUE_RATE_MISMATCH",
  "CAPTION_CUE_DURATION_NON_POSITIVE",
  "CAPTION_CUE_OVERLAP",
  "CAPTION_LINE_COUNT_EXCEEDED",
  "CAPTION_LINE_LENGTH_EXCEEDED",
  "CAPTION_CUE_TOO_SHORT",
  "CAPTION_CUE_TOO_LONG",
  "CAPTION_CPS_EXCEEDED",
  "CAPTION_SAFE_AREA_EXCEEDED",
  "CAPTION_TRANSCRIPT_LINK_MISMATCH",
  "CAPTION_SOURCE_LINK_OVERLAP",
  "CAPTION_TRANSCRIPT_WORD_REUSED",
] as const;

export const captionValidationIssueCodeSchema = z.enum(CAPTION_VALIDATION_ISSUE_CODES);
export type CaptionValidationIssueCode = z.infer<typeof captionValidationIssueCodeSchema>;

export const captionValidationIssueV1Schema = z
  .object({
    code: captionValidationIssueCodeSchema,
    path: z.string().min(1).max(1_024),
    cueId: cueIdSchema.nullable(),
  })
  .strict();
export type CaptionValidationIssueV1 = z.infer<typeof captionValidationIssueV1Schema>;

const MAX_CAPTION_VALIDATION_ISSUES = 100_000;

export const captionValidationResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    valid: z.boolean(),
    issues: z.array(captionValidationIssueV1Schema).max(MAX_CAPTION_VALIDATION_ISSUES),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.valid !== (result.issues.length === 0)) {
      context.addIssue({ code: "custom", message: "Validation status must match its issues" });
    }
  });
export type CaptionValidationResultV1 = z.infer<typeof captionValidationResultV1Schema>;

export function unicodeScalarLength(text: string): number {
  return Array.from(text).length;
}

const captionLineV1Schema = z
  .string()
  .min(1)
  .refine((text) => text.trim().length > 0, "Caption lines cannot be blank")
  .refine((text) => unicodeScalarLength(text) <= 4_096, {
    message: "Caption lines cannot exceed 4096 Unicode scalars",
  });

export const captionTrackLinkV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: projectUuidSchema,
    projectRevision: projectRevisionDescriptorV2Schema,
    sequenceId: projectUuidSchema,
    captionTrackId: projectUuidSchema,
  })
  .strict();
export type CaptionTrackLinkV1 = z.infer<typeof captionTrackLinkV1Schema>;

export const captionTypographyV1Schema = z
  .object({
    fontFamily: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0),
    fontSizePx: safePositiveIntegerSchema.min(8).max(256),
    fontWeight: safePositiveIntegerSchema
      .min(100)
      .max(900)
      .refine((value) => value % 100 === 0),
    fontStyle: z.enum(["normal", "italic"]),
    lineHeightPermille: safePositiveIntegerSchema.min(500).max(3_000),
    foregroundColorRgba: rgbaColorSchema,
  })
  .strict();
export type CaptionTypographyV1 = z.infer<typeof captionTypographyV1Schema>;

export const captionAlignmentV1Schema = z
  .object({
    horizontal: z.enum(["left", "center", "right"]),
    vertical: z.enum(["top", "center", "bottom"]),
  })
  .strict();
export type CaptionAlignmentV1 = z.infer<typeof captionAlignmentV1Schema>;

export const captionStyleV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    typography: captionTypographyV1Schema,
    alignment: captionAlignmentV1Schema,
  })
  .strict();
export type CaptionStyleV1 = z.infer<typeof captionStyleV1Schema>;

export const captionSafeAreaV1Schema = z
  .object({
    topPermille: safeNonNegativeIntegerSchema.max(999),
    rightPermille: safeNonNegativeIntegerSchema.max(999),
    bottomPermille: safeNonNegativeIntegerSchema.max(999),
    leftPermille: safeNonNegativeIntegerSchema.max(999),
  })
  .strict()
  .superRefine((safeArea, context) => {
    if (safeArea.leftPermille + safeArea.rightPermille >= 1_000) {
      addIssue(context, ["rightPermille"], "CAPTION_SAFE_AREA_INVALID");
    }
    if (safeArea.topPermille + safeArea.bottomPermille >= 1_000) {
      addIssue(context, ["bottomPermille"], "CAPTION_SAFE_AREA_INVALID");
    }
  });
export type CaptionSafeAreaV1 = z.infer<typeof captionSafeAreaV1Schema>;

export const captionValidationProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    maxLinesPerCue: safePositiveIntegerSchema.max(8),
    maxCharactersPerLine: safePositiveIntegerSchema.max(1_024),
    maxCharactersPerSecond: safePositiveIntegerSchema.max(1_000),
    minimumCueDuration: rationalTimeSchema,
    maximumCueDuration: rationalTimeSchema,
    safeArea: captionSafeAreaV1Schema,
  })
  .strict()
  .superRefine((profile, context) => {
    if (compareDurations(profile.minimumCueDuration, profile.maximumCueDuration) > 0) {
      addIssue(context, ["maximumCueDuration"], "CAPTION_DURATION_PROFILE_INVALID");
    }
  });
export type CaptionValidationProfileV1 = z.infer<typeof captionValidationProfileV1Schema>;

export const captionAnchorV1Schema = z
  .object({
    xPermille: safeNonNegativeIntegerSchema.max(1_000),
    yPermille: safeNonNegativeIntegerSchema.max(1_000),
  })
  .strict();
export type CaptionAnchorV1 = z.infer<typeof captionAnchorV1Schema>;

export const captionSourceLinkV1Schema = z
  .object({
    transcriptArtifactIdentityKey: sha256DigestSchema,
    sourceStartUs: safeNonNegativeIntegerSchema,
    sourceEndUs: safePositiveIntegerSchema,
    transcriptWordIds: z.array(transcriptWordIdSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((link, context) => {
    if (link.sourceEndUs <= link.sourceStartUs) {
      addIssue(context, ["sourceEndUs"], "CAPTION_SOURCE_SPAN_INVALID");
    }
    const wordIds = new Set<string>();
    link.transcriptWordIds.forEach((wordId, index) => {
      if (wordIds.has(wordId)) {
        addIssue(context, ["transcriptWordIds", index], "CAPTION_SOURCE_WORD_DUPLICATE");
      }
      wordIds.add(wordId);
    });
  });
export type CaptionSourceLinkV1 = z.infer<typeof captionSourceLinkV1Schema>;

export const captionCueV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    cueId: cueIdSchema,
    start: rationalTimeSchema,
    end: rationalTimeSchema,
    lines: z.array(captionLineV1Schema).min(1).max(8),
    anchor: captionAnchorV1Schema,
    sourceLinks: z.array(captionSourceLinkV1Schema).min(1).max(10_000),
  })
  .strict();
export type CaptionCueV1 = z.infer<typeof captionCueV1Schema>;

export const captionArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    trackLink: captionTrackLinkV1Schema,
    sourceIdentity: mediaContentIdentityV1Schema,
    transcriptArtifactIdentityKey: sha256DigestSchema,
    language: languageTagSchema,
    timelineRate: rationalRateSchema,
    style: captionStyleV1Schema,
    validationProfile: captionValidationProfileV1Schema,
    cues: z.array(captionCueV1Schema).max(100_000),
  })
  .strict()
  .superRefine((artifact, context) => {
    validateCaptionCues(artifact, context);
  });
export type CaptionArtifactV1 = z.infer<typeof captionArtifactV1Schema>;

export function validateCaptionArtifactV1(input: unknown): CaptionValidationResultV1 {
  const parsed = captionArtifactV1Schema.safeParse(input);
  if (parsed.success) {
    return { schemaVersion: 1, valid: true, issues: [] };
  }

  const issues = parsed.error.issues
    .map((issue): CaptionValidationIssueV1 => {
      const path = issue.path.map((segment) =>
        typeof segment === "string" || typeof segment === "number" ? segment : String(segment),
      );
      return {
        code: validationCodeForIssue(issue.message, path),
        path: validationPath(path),
        cueId: cueIdForPath(input, path),
      };
    })
    .sort((left, right) =>
      `${left.path}\0${left.code}\0${left.cueId ?? ""}`.localeCompare(
        `${right.path}\0${right.code}\0${right.cueId ?? ""}`,
      ),
    )
    .filter(
      (issue, index, all) =>
        index === 0 ||
        issue.path !== all[index - 1]!.path ||
        issue.code !== all[index - 1]!.code ||
        issue.cueId !== all[index - 1]!.cueId,
    )
    .slice(0, MAX_CAPTION_VALIDATION_ISSUES);

  return { schemaVersion: 1, valid: false, issues };
}

interface CaptionArtifactValidationInput {
  readonly transcriptArtifactIdentityKey: string;
  readonly timelineRate: RationalRate;
  readonly validationProfile: CaptionValidationProfileV1;
  readonly cues: readonly CaptionCueV1[];
}

function validateCaptionCues(
  artifact: CaptionArtifactValidationInput,
  context: z.RefinementCtx,
): void {
  const cueIds = new Set<string>();
  let previousEnd: RationalTime | undefined;

  artifact.cues.forEach((cue, cueIndex) => {
    const cuePath = ["cues", cueIndex] as const;
    if (cueIds.has(cue.cueId)) {
      addIssue(context, [...cuePath, "cueId"], "CAPTION_CUE_ID_DUPLICATE");
    }
    cueIds.add(cue.cueId);

    if (
      !timeUsesRate(cue.start, artifact.timelineRate) ||
      !timeUsesRate(cue.end, artifact.timelineRate)
    ) {
      addIssue(context, [...cuePath, "start"], "CAPTION_CUE_RATE_MISMATCH");
      return;
    }
    if (cue.end.value <= cue.start.value) {
      addIssue(context, [...cuePath, "end"], "CAPTION_CUE_DURATION_NON_POSITIVE");
      return;
    }
    if (previousEnd !== undefined && cue.start.value < previousEnd.value) {
      addIssue(context, [...cuePath, "start"], "CAPTION_CUE_OVERLAP");
    }
    previousEnd = cue.end;

    validateCueThresholds(cue, cueIndex, artifact.validationProfile, context);
    validateSourceLinks(cue, cueIndex, artifact.transcriptArtifactIdentityKey, context);
  });
}

function validateCueThresholds(
  cue: CaptionCueV1,
  cueIndex: number,
  profile: CaptionValidationProfileV1,
  context: z.RefinementCtx,
): void {
  if (cue.lines.length > profile.maxLinesPerCue) {
    addIssue(context, ["cues", cueIndex, "lines"], "CAPTION_LINE_COUNT_EXCEEDED");
  }

  let scalarCount = 0;
  cue.lines.forEach((line, lineIndex) => {
    const length = unicodeScalarLength(line);
    scalarCount += length;
    if (length > profile.maxCharactersPerLine) {
      addIssue(context, ["cues", cueIndex, "lines", lineIndex], "CAPTION_LINE_LENGTH_EXCEEDED");
    }
  });

  const duration = cue.end.value - cue.start.value;
  if (compareFrameDuration(duration, cue.start, profile.minimumCueDuration) < 0) {
    addIssue(context, ["cues", cueIndex, "end"], "CAPTION_CUE_TOO_SHORT");
  }
  if (compareFrameDuration(duration, cue.start, profile.maximumCueDuration) > 0) {
    addIssue(context, ["cues", cueIndex, "end"], "CAPTION_CUE_TOO_LONG");
  }

  const cpsLeft = BigInt(scalarCount) * BigInt(cue.start.rateNumerator);
  const cpsRight =
    BigInt(profile.maxCharactersPerSecond) * BigInt(duration) * BigInt(cue.start.rateDenominator);
  if (cpsLeft > cpsRight) {
    addIssue(context, ["cues", cueIndex, "lines"], "CAPTION_CPS_EXCEEDED");
  }

  const { safeArea } = profile;
  if (
    cue.anchor.xPermille < safeArea.leftPermille ||
    cue.anchor.xPermille > 1_000 - safeArea.rightPermille ||
    cue.anchor.yPermille < safeArea.topPermille ||
    cue.anchor.yPermille > 1_000 - safeArea.bottomPermille
  ) {
    addIssue(context, ["cues", cueIndex, "anchor"], "CAPTION_SAFE_AREA_EXCEEDED");
  }
}

function validateSourceLinks(
  cue: CaptionCueV1,
  cueIndex: number,
  transcriptArtifactIdentityKey: string,
  context: z.RefinementCtx,
): void {
  let previousEndUs: number | undefined;
  const cueWordIds = new Set<string>();
  cue.sourceLinks.forEach((link, linkIndex) => {
    if (link.transcriptArtifactIdentityKey !== transcriptArtifactIdentityKey) {
      addIssue(
        context,
        ["cues", cueIndex, "sourceLinks", linkIndex, "transcriptArtifactIdentityKey"],
        "CAPTION_TRANSCRIPT_LINK_MISMATCH",
      );
    }
    if (previousEndUs !== undefined && link.sourceStartUs < previousEndUs) {
      addIssue(
        context,
        ["cues", cueIndex, "sourceLinks", linkIndex, "sourceStartUs"],
        "CAPTION_SOURCE_LINK_OVERLAP",
      );
    }
    previousEndUs = link.sourceEndUs;
    link.transcriptWordIds.forEach((wordId, wordIndex) => {
      if (cueWordIds.has(wordId)) {
        addIssue(
          context,
          ["cues", cueIndex, "sourceLinks", linkIndex, "transcriptWordIds", wordIndex],
          "CAPTION_TRANSCRIPT_WORD_REUSED",
        );
      }
      cueWordIds.add(wordId);
    });
  });
}

function validationCodeForIssue(
  message: string,
  path: readonly (string | number)[],
): CaptionValidationIssueCode {
  if (isCaptionValidationIssueCode(message)) {
    return message;
  }
  if (path.at(-1) === "schemaVersion") {
    return "CAPTION_VERSION_UNSUPPORTED";
  }
  if (path[0] === "trackLink") {
    return "CAPTION_TRACK_LINK_INVALID";
  }
  if (path[0] === "style") {
    return "CAPTION_STYLE_INVALID";
  }
  return "CAPTION_SCHEMA_INVALID";
}

function isCaptionValidationIssueCode(value: string): value is CaptionValidationIssueCode {
  return (CAPTION_VALIDATION_ISSUE_CODES as readonly string[]).includes(value);
}

function validationPath(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return "$";
  }
  return `$${path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${segment}`))
    .join("")}`;
}

function cueIdForPath(input: unknown, path: readonly (string | number)[]): string | null {
  if (
    path[0] !== "cues" ||
    typeof path[1] !== "number" ||
    typeof input !== "object" ||
    input === null
  ) {
    return null;
  }
  const cues = (input as { cues?: unknown }).cues;
  if (!Array.isArray(cues)) {
    return null;
  }
  const cue = cues[path[1]];
  if (typeof cue !== "object" || cue === null) {
    return null;
  }
  const cueId = (cue as { cueId?: unknown }).cueId;
  return typeof cueId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(cueId) ? cueId : null;
}

function timeUsesRate(time: RationalTime, rate: RationalRate): boolean {
  return time.rateNumerator === rate.numerator && time.rateDenominator === rate.denominator;
}

function compareDurations(left: RationalTime, right: RationalTime): -1 | 0 | 1 {
  return compareDurationProducts(
    BigInt(left.value) * BigInt(left.rateDenominator) * BigInt(right.rateNumerator),
    BigInt(right.value) * BigInt(right.rateDenominator) * BigInt(left.rateNumerator),
  );
}

function compareFrameDuration(
  frameCount: number,
  frameTime: RationalTime,
  threshold: RationalTime,
): -1 | 0 | 1 {
  return compareDurationProducts(
    BigInt(frameCount) * BigInt(frameTime.rateDenominator) * BigInt(threshold.rateNumerator),
    BigInt(threshold.value) * BigInt(threshold.rateDenominator) * BigInt(frameTime.rateNumerator),
  );
}

function compareDurationProducts(left: bigint, right: bigint): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  code: CaptionValidationIssueCode,
): void {
  context.addIssue({ code: "custom", path, message: code });
}
