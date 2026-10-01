/*
 * Immutable render manifest written beside each export as
 * `<output>.manifest.json`. It records what was rendered and what QC found; it
 * never contains review decisions (those live in the append-only review record).
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "@supa-video/produce";
import {
  QC_STATUS,
  qcFindingSchema,
  qcSha256HexSchema as sha256HexSchema,
  type QcStatus,
} from "@supa-video/contracts";
import { sortFindings } from "./finding.js";
import type { Result } from "./result.js";

export const RENDER_MANIFEST_SCHEMA_VERSION = 1;
export const RENDER_MANIFEST_MAX_FINDINGS = 512;

export const renderManifestInputSchema = z.strictObject({
  assetId: z.uuid().nullable(),
  contentSha256: sha256HexSchema.nullable(),
  rightsReceiptId: z.uuid().nullable(),
});

export const renderManifestSchema = z.strictObject({
  schemaVersion: z.literal(RENDER_MANIFEST_SCHEMA_VERSION),
  kind: z.enum(["review", "delivery"]),
  presetId: z.string().min(1).max(64).nullable(),
  project: z.strictObject({
    revisionId: z.uuid(),
    revisionStateHash: sha256HexSchema,
  }),
  renderPlanSha256: sha256HexSchema,
  toolchainId: z.string().min(1).max(128),
  inputs: z.array(renderManifestInputSchema).max(4096),
  output: z.strictObject({
    fileName: z.string().min(1).max(255),
    sha256: sha256HexSchema,
    sizeBytes: z.number().int().positive(),
    durationMicroseconds: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    videoCodec: z.string().min(1).max(32),
    audioCodec: z.string().min(1).max(32).nullable(),
  }),
  loudness: z.json().nullable(),
  qc: z.strictObject({
    status: z.enum([QC_STATUS.passed, QC_STATUS.warnings, QC_STATUS.blocked]),
    detectorVersion: z.string().min(1).max(64),
    findings: z.array(qcFindingSchema).max(RENDER_MANIFEST_MAX_FINDINGS),
  }),
  editorial: z.strictObject({
    evaluatorVersion: z.string().min(1).max(64),
    evaluationSha256: sha256HexSchema,
  }),
  /** Delivery renders reference the review export they were gated on. */
  source: z
    .strictObject({
      reviewManifestSha256: sha256HexSchema,
      acceptedDecisionIds: z.array(z.string().min(1).max(128)).max(RENDER_MANIFEST_MAX_FINDINGS),
    })
    .nullable(),
  appVersion: z.string().min(1).max(64),
  createdAt: z.iso.datetime({ offset: true }),
});
export type RenderManifest = z.infer<typeof renderManifestSchema>;

export function qcStatusFor(findings: RenderManifest["qc"]["findings"]): QcStatus {
  if (findings.some((finding) => finding.severity === "blocker")) return QC_STATUS.blocked;
  if (findings.some((finding) => finding.severity === "warning")) return QC_STATUS.warnings;
  return QC_STATUS.passed;
}

function inputSortKey(input: RenderManifest["inputs"][number]): string {
  return [input.assetId ?? "", input.contentSha256 ?? "", input.rightsReceiptId ?? ""].join(
    "\u0000",
  );
}

/** Canonical bytes: sorted keys, findings and inputs in deterministic order. */
export function serializeRenderManifest(manifest: RenderManifest): string {
  return canonicalJson({
    ...manifest,
    inputs: [...manifest.inputs].sort((left, right) => {
      const a = inputSortKey(left);
      const b = inputSortKey(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    qc: { ...manifest.qc, findings: sortFindings(manifest.qc.findings) },
    source:
      manifest.source === null
        ? null
        : {
            ...manifest.source,
            acceptedDecisionIds: [...manifest.source.acceptedDecisionIds].sort(),
          },
  });
}

export async function renderManifestSha256(text: string): Promise<string> {
  return sha256Hex(text);
}

export type ManifestParseError =
  | { readonly kind: "invalid_json" }
  | { readonly kind: "invalid_manifest"; readonly issues: readonly string[] };

export function parseRenderManifest(text: string): Result<RenderManifest, ManifestParseError> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "invalid_json" } };
  }
  const parsed = renderManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "invalid_manifest",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/** Comparison view for reproducibility: everything except the timestamp. */
export function reproducibleManifestView(manifest: RenderManifest): string {
  return serializeRenderManifest({ ...manifest, createdAt: "1970-01-01T00:00:00Z" });
}
