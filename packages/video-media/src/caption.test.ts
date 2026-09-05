import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  captionArtifactV1Schema as contractsCaptionArtifactV1Schema,
  validateCaptionArtifactV1 as contractsValidateCaptionArtifactV1,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";
import {
  captionArtifactV1Schema,
  captionValidationResultV1Schema,
  type CaptionArtifactV1,
  type CaptionValidationIssueCode,
  unicodeScalarLength,
  validateCaptionArtifactV1,
} from "./caption.js";

const fixturePath = fileURLToPath(new URL("../fixtures/caption-artifact-v1.json", import.meta.url));

function fixture(): CaptionArtifactV1 {
  return captionArtifactV1Schema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
}

function oneCue(): CaptionArtifactV1 {
  const artifact = fixture();
  artifact.cues = [artifact.cues[0]!];
  return artifact;
}

function parses(artifact: CaptionArtifactV1): boolean {
  return captionArtifactV1Schema.safeParse(artifact).success;
}

function issueCodes(input: unknown): CaptionValidationIssueCode[] {
  const result = validateCaptionArtifactV1(input);
  expect(captionValidationResultV1Schema.safeParse(result).success).toBe(true);
  return result.issues.map(({ code }) => code);
}

describe("caption artifact v1", () => {
  it("keeps media exports as compatibility aliases of the contracts implementation", () => {
    expect(captionArtifactV1Schema).toBe(contractsCaptionArtifactV1Schema);
    expect(validateCaptionArtifactV1).toBe(contractsValidateCaptionArtifactV1);
  });

  it("parses the shared strict fixture with track, style, and rational timing", () => {
    const artifact = fixture();

    expect(artifact.trackLink).toMatchObject({
      schemaVersion: 1,
      projectId: "11111111-1111-4111-8111-111111111111",
      sequenceId: "44444444-4444-4444-8444-444444444444",
      captionTrackId: "55555555-5555-4555-8555-555555555555",
    });
    expect(artifact.trackLink.projectRevision.number).toBe(7);
    expect(artifact.style).toEqual({
      schemaVersion: 1,
      typography: {
        fontFamily: "Inter",
        fontSizePx: 48,
        fontWeight: 600,
        fontStyle: "normal",
        lineHeightPermille: 1_200,
        foregroundColorRgba: "#ffffffff",
      },
      alignment: { horizontal: "center", vertical: "bottom" },
    });
    expect(artifact.timelineRate).toEqual({ numerator: 24, denominator: 1 });
    expect(artifact.validationProfile.minimumCueDuration).toEqual({
      value: 1,
      rateNumerator: 2,
      rateDenominator: 1,
    });
    expect(artifact.cues.map(({ start, end }) => [start.value, end.value])).toEqual([
      [0, 24],
      [24, 72],
    ]);
    expect(validateCaptionArtifactV1(artifact)).toEqual({
      schemaVersion: 1,
      valid: true,
      issues: [],
    });
  });

  it("rejects unknown fields and every version boundary", () => {
    const topLevel = { ...fixture(), unexpected: true };
    expect(captionArtifactV1Schema.safeParse(topLevel).success).toBe(false);

    for (const mutate of [
      (artifact: CaptionArtifactV1) => Object.assign(artifact.trackLink, { unexpected: true }),
      (artifact: CaptionArtifactV1) =>
        Object.assign(artifact.style.typography, { unexpected: true }),
      (artifact: CaptionArtifactV1) =>
        Object.assign(artifact.cues[0]!.anchor, { unexpected: true }),
    ]) {
      const artifact = fixture();
      mutate(artifact);
      expect(parses(artifact)).toBe(false);
    }

    for (const mutate of [
      (artifact: CaptionArtifactV1) => {
        artifact.schemaVersion = 2 as 1;
      },
      (artifact: CaptionArtifactV1) => {
        artifact.trackLink.schemaVersion = 2 as 1;
      },
      (artifact: CaptionArtifactV1) => {
        artifact.style.schemaVersion = 2 as 1;
      },
      (artifact: CaptionArtifactV1) => {
        artifact.sourceIdentity.schemaVersion = 2 as 1;
      },
      (artifact: CaptionArtifactV1) => {
        artifact.validationProfile.schemaVersion = 2 as 1;
      },
      (artifact: CaptionArtifactV1) => {
        artifact.cues[0]!.schemaVersion = 2 as 1;
      },
    ]) {
      const artifact = fixture();
      mutate(artifact);
      expect(parses(artifact)).toBe(false);
      expect(issueCodes(artifact)).toContain("CAPTION_VERSION_UNSUPPORTED");
    }
  });

  it("strictly links a project revision, sequence, and caption track", () => {
    const revisionBoundary = fixture();
    revisionBoundary.trackLink.projectRevision.number = Number.MAX_SAFE_INTEGER;
    expect(parses(revisionBoundary)).toBe(true);

    const unsafeRevision = fixture();
    unsafeRevision.trackLink.projectRevision.number = Number.MAX_SAFE_INTEGER + 1;
    expect(parses(unsafeRevision)).toBe(false);
    expect(issueCodes(unsafeRevision)).toContain("CAPTION_TRACK_LINK_INVALID");

    for (const field of ["projectId", "sequenceId", "captionTrackId"] as const) {
      const artifact = fixture();
      artifact.trackLink[field] = "not-a-uuid";
      expect(parses(artifact)).toBe(false);
      expect(issueCodes(artifact)).toContain("CAPTION_TRACK_LINK_INVALID");
    }

    const invalidRevision = fixture();
    invalidRevision.trackLink.projectRevision.stateHash = "0";
    expect(issueCodes(invalidRevision)).toContain("CAPTION_TRACK_LINK_INVALID");
  });

  it("enforces versioned typography and alignment boundaries", () => {
    const boundaries = fixture();
    boundaries.style.typography.fontSizePx = 8;
    boundaries.style.typography.fontWeight = 100;
    boundaries.style.typography.lineHeightPermille = 500;
    boundaries.style.alignment = { horizontal: "left", vertical: "top" };
    expect(parses(boundaries)).toBe(true);

    boundaries.style.typography.fontSizePx = 256;
    boundaries.style.typography.fontWeight = 900;
    boundaries.style.typography.lineHeightPermille = 3_000;
    boundaries.style.alignment = { horizontal: "right", vertical: "bottom" };
    expect(parses(boundaries)).toBe(true);

    for (const mutate of [
      (artifact: CaptionArtifactV1) => {
        artifact.style.typography.fontSizePx = 7;
      },
      (artifact: CaptionArtifactV1) => {
        artifact.style.typography.fontWeight = 550;
      },
      (artifact: CaptionArtifactV1) => {
        artifact.style.typography.lineHeightPermille = 3_001;
      },
      (artifact: CaptionArtifactV1) => {
        artifact.style.typography.foregroundColorRgba = "#FFFFFF";
      },
      (artifact: CaptionArtifactV1) => {
        artifact.style.alignment.horizontal = "justify" as "center";
      },
    ]) {
      const artifact = fixture();
      mutate(artifact);
      expect(parses(artifact)).toBe(false);
      expect(issueCodes(artifact)).toContain("CAPTION_STYLE_INVALID");
    }
  });

  it("returns deterministic stable issue codes, paths, and cue linkage", () => {
    const overlapping = fixture();
    overlapping.cues[1]!.start.value -= 1;

    const first = validateCaptionArtifactV1(overlapping);
    const second = validateCaptionArtifactV1(structuredClone(overlapping));
    expect(first).toEqual(second);
    expect(first).toEqual({
      schemaVersion: 1,
      valid: false,
      issues: [
        {
          code: "CAPTION_CUE_OVERLAP",
          path: "$.cues[1].start",
          cueId: "caption-0002",
        },
      ],
    });
  });

  it("bounds deterministic diagnostics for large malformed inputs to the result contract", () => {
    const input = { cues: Array.from({ length: 15_000 }, () => ({})) };
    const result = validateCaptionArtifactV1(input);

    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.length).toBeLessThanOrEqual(100_000);
    expect(result.issues).toHaveLength(100_000);
    expect(validateCaptionArtifactV1(structuredClone(input))).toEqual(result);
    expect(captionValidationResultV1Schema.safeParse(result).success).toBe(true);
  });

  it("rejects unreduced, mixed, and non-positive rational cue timing", () => {
    const unreduced = oneCue();
    unreduced.timelineRate = { numerator: 48, denominator: 2 };
    expect(parses(unreduced)).toBe(false);

    const mixed = oneCue();
    mixed.cues[0]!.end.rateNumerator = 30;
    expect(parses(mixed)).toBe(false);
    expect(issueCodes(mixed)).toContain("CAPTION_CUE_RATE_MISMATCH");

    const empty = oneCue();
    empty.cues[0]!.end.value = empty.cues[0]!.start.value;
    expect(parses(empty)).toBe(false);
    expect(issueCodes(empty)).toContain("CAPTION_CUE_DURATION_NON_POSITIVE");
  });

  it("allows touching cues but rejects a one-frame overlap", () => {
    const touching = fixture();
    expect(touching.cues[1]!.start.value).toBe(touching.cues[0]!.end.value);
    expect(parses(touching)).toBe(true);

    const overlapping = fixture();
    overlapping.cues[1]!.start.value -= 1;
    expect(issueCodes(overlapping)).toEqual(["CAPTION_CUE_OVERLAP"]);
  });

  it("counts Unicode scalars with Array.from for line length and CPS", () => {
    expect(unicodeScalarLength("A😀")).toBe(2);
    expect(unicodeScalarLength("👋🏽")).toBe(2);

    const unicodeBoundary = oneCue();
    unicodeBoundary.validationProfile.maxCharactersPerLine = 2;
    unicodeBoundary.cues[0]!.lines = ["A😀"];
    expect(parses(unicodeBoundary)).toBe(true);

    unicodeBoundary.validationProfile.maxCharactersPerLine = 1;
    expect(issueCodes(unicodeBoundary)).toContain("CAPTION_LINE_LENGTH_EXCEEDED");

    const cpsBoundary = oneCue();
    cpsBoundary.cues[0]!.end.value = 12;
    cpsBoundary.cues[0]!.lines = ["1234567890"];
    expect(parses(cpsBoundary)).toBe(true);

    cpsBoundary.cues[0]!.lines = ["1234567890😀"];
    expect(issueCodes(cpsBoundary)).toContain("CAPTION_CPS_EXCEEDED");
  });

  it("accepts line-length and duration thresholds and rejects the next value", () => {
    const line = oneCue();
    line.cues[0]!.end.value = 72;
    line.cues[0]!.lines = ["x".repeat(42)];
    expect(parses(line)).toBe(true);
    line.cues[0]!.lines = ["x".repeat(42) + "😀"];
    expect(issueCodes(line)).toContain("CAPTION_LINE_LENGTH_EXCEEDED");

    const minimum = oneCue();
    minimum.cues[0]!.end.value = 12;
    minimum.cues[0]!.lines = ["short"];
    expect(parses(minimum)).toBe(true);
    minimum.cues[0]!.end.value = 11;
    expect(issueCodes(minimum)).toContain("CAPTION_CUE_TOO_SHORT");

    const maximum = oneCue();
    maximum.cues[0]!.end.value = 168;
    expect(parses(maximum)).toBe(true);
    maximum.cues[0]!.end.value = 169;
    expect(issueCodes(maximum)).toContain("CAPTION_CUE_TOO_LONG");
  });

  it("preserves source/transcript links and stable orphan issue codes", () => {
    const mismatchedTranscript = oneCue();
    mismatchedTranscript.cues[0]!.sourceLinks[0]!.transcriptArtifactIdentityKey = "0".repeat(64);
    expect(issueCodes(mismatchedTranscript)).toContain("CAPTION_TRANSCRIPT_LINK_MISMATCH");

    const duplicateWord = oneCue();
    duplicateWord.cues[0]!.sourceLinks.push({
      transcriptArtifactIdentityKey: duplicateWord.transcriptArtifactIdentityKey,
      sourceStartUs: 1_000_000,
      sourceEndUs: 1_100_000,
      transcriptWordIds: [duplicateWord.cues[0]!.sourceLinks[0]!.transcriptWordIds[0]!],
    });
    expect(issueCodes(duplicateWord)).toContain("CAPTION_TRANSCRIPT_WORD_REUSED");

    const invalidSourceSpan = oneCue();
    invalidSourceSpan.cues[0]!.sourceLinks[0]!.sourceEndUs = 0;
    expect(issueCodes(invalidSourceSpan)).toContain("CAPTION_SOURCE_SPAN_INVALID");
  });

  it("accepts safe-area edges and emits stable failures outside them", () => {
    const edge = oneCue();
    edge.cues[0]!.anchor = { xPermille: 50, yPermille: 900 };
    expect(parses(edge)).toBe(true);

    const outside = oneCue();
    outside.cues[0]!.anchor.xPermille = 49;
    expect(issueCodes(outside)).toContain("CAPTION_SAFE_AREA_EXCEEDED");

    const collapsed = oneCue();
    collapsed.validationProfile.safeArea.leftPermille = 500;
    collapsed.validationProfile.safeArea.rightPermille = 500;
    expect(issueCodes(collapsed)).toContain("CAPTION_SAFE_AREA_INVALID");
  });
});
