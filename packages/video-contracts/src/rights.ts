import { z } from "zod";

export { assetOriginSchema, type AssetOrigin } from "./asset-origin.js";
import { mediaProbeSchema } from "./project.js";
import { mediaContentIdentityV1Schema, sha256DigestSchema } from "./source-content.js";

/*
 * Rights and acquisition contracts. These mirror the Rust types in
 * `apps/desktop/src-tauri/src/rights/`. Rust is the only authority: it fetches
 * provider records, normalizes licenses, applies policy and writes receipts.
 * These schemas validate IPC payloads and drive UI preview/preflight only.
 */

const boundedText = z.string().min(1).max(2_048);
const optionalText = z.string().max(2_048).nullable();
const httpsUrlSchema = z
  .string()
  .max(2_048)
  .regex(/^https:\/\/[^\s]+$/);
const nonNegativeInteger = z.number().int().safe().nonnegative();

export const providerIdSchema = z.enum([
  "wikimedia-commons",
  "openverse",
  "smithsonian",
  "pexels",
  "pixabay",
  "freesound",
  "internet-archive",
]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const providerItemIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:~ ()'-]+$/)
  .refine((value) => !value.includes("..") && value.trim() === value, {
    message: "Provider item id must not contain traversal or padding",
  });

export const licenseCodeSchema = z.enum([
  "cc0",
  "pdm",
  "by",
  "by-sa",
  "by-nc",
  "by-nc-sa",
  "by-nd",
  "by-nc-nd",
  "custom",
  "unknown",
]);
export type LicenseCode = z.infer<typeof licenseCodeSchema>;

export const licenseIdSchema = z
  .object({
    code: licenseCodeSchema,
    /** CC version such as "4.0"; null when not applicable or not stated. */
    version: z
      .string()
      .regex(/^[0-9](\.[0-9])?$/)
      .nullable(),
    /** Canonical license deed URL, or the provider terms URL for `custom`. */
    url: httpsUrlSchema.nullable(),
  })
  .strict();
export type LicenseId = z.infer<typeof licenseIdSchema>;

export const usePolicyProfileSchema = z.enum([
  "private-preview",
  "noncommercial-public",
  "commercial-online",
  "commercial-client",
  "broadcast",
]);
export type UsePolicyProfile = z.infer<typeof usePolicyProfileSchema>;

export const policyReasonCodeSchema = z.enum([
  "attribution-required",
  "share-alike-obligation",
  "noncommercial-only",
  "no-derivatives",
  "custom-terms-review",
  "license-unknown",
  "license-conflict",
]);
export type PolicyReasonCode = z.infer<typeof policyReasonCodeSchema>;

export const policyDecisionSchema = z
  .object({
    outcome: z.enum(["allow", "warn", "block"]),
    reasons: z.array(policyReasonCodeSchema).max(16).readonly(),
  })
  .strict();
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const mediaKindSchema = z.enum(["video", "image", "audio"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const structuredAttributionSchema = z
  .object({
    title: optionalText,
    creator: optionalText,
    creatorUrl: httpsUrlSchema.nullable(),
    sourceUrl: httpsUrlSchema.nullable(),
    providerName: boundedText,
    licenseName: boundedText,
    licenseUrl: httpsUrlSchema.nullable(),
  })
  .strict();
export type StructuredAttribution = z.infer<typeof structuredAttributionSchema>;

export const rightsCandidateSchema = z
  .object({
    providerId: providerIdSchema,
    providerItemId: providerItemIdSchema,
    mediaKind: mediaKindSchema,
    title: optionalText,
    creator: optionalText,
    landingUrl: httpsUrlSchema.nullable(),
    thumbnailUrl: httpsUrlSchema.nullable(),
    license: licenseIdSchema,
    durationMs: nonNegativeInteger.nullable(),
    width: nonNegativeInteger.nullable(),
    height: nonNegativeInteger.nullable(),
    /** Advisory only: acquisition always re-fetches the record in Rust. */
    advisoryPolicy: policyDecisionSchema,
  })
  .strict();
export type RightsCandidate = z.infer<typeof rightsCandidateSchema>;

export const snapshotKindSchema = z.enum([
  "api-record",
  "landing-page",
  "provider-terms",
  "license-page",
]);
export type SnapshotKind = z.infer<typeof snapshotKindSchema>;

export const licenseSnapshotSchema = z
  .object({
    kind: snapshotKindSchema,
    digest: sha256DigestSchema,
    byteLength: nonNegativeInteger,
    /** Fetched URL with credentials and API keys removed. */
    url: httpsUrlSchema,
    mediaType: z.string().max(256),
    fetchedAtMs: nonNegativeInteger,
  })
  .strict();
export type LicenseSnapshot = z.infer<typeof licenseSnapshotSchema>;

export const refreshStatusSchema = z.enum(["unchanged", "changed", "withdrawn"]);
export type RefreshStatus = z.infer<typeof refreshStatusSchema>;

export const acquisitionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: z.uuid(),
    providerId: providerIdSchema,
    providerItemId: providerItemIdSchema,
    projectId: z.uuid(),
    intendedUse: usePolicyProfileSchema,
    mediaKind: mediaKindSchema,
    mediaType: z.string().max(256),
    content: mediaContentIdentityV1Schema,
    license: licenseIdSchema,
    itemLicense: licenseIdSchema,
    collectionLicense: licenseIdSchema.nullable(),
    policy: policyDecisionSchema,
    attribution: structuredAttributionSchema,
    snapshots: z.array(licenseSnapshotSchema).min(1).max(8).readonly(),
    etag: z.string().max(512).nullable(),
    acquiredAtMs: nonNegativeInteger,
    lastRefreshAtMs: nonNegativeInteger,
    lastRefreshStatus: refreshStatusSchema,
  })
  .strict();
export type AcquisitionReceipt = z.infer<typeof acquisitionReceiptSchema>;

export const releaseGateReasonSchema = z.enum([
  "receipt-missing",
  "receipt-mismatch",
  "snapshot-missing",
  "snapshot-tampered",
  "refresh-stale",
  "upstream-changed",
  "upstream-withdrawn",
  "use-blocked",
  "attribution-incomplete",
]);
export type ReleaseGateReason = z.infer<typeof releaseGateReasonSchema>;

export const releaseGateResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("pass"), creditedReceiptIds: z.array(z.uuid()).readonly() })
    .strict(),
  z
    .object({
      outcome: z.literal("blocked"),
      failures: z
        .array(
          z
            .object({
              digest: sha256DigestSchema,
              receiptId: z.uuid().nullable(),
              reason: releaseGateReasonSchema,
            })
            .strict(),
        )
        .min(1)
        .readonly(),
    })
    .strict(),
]);
export type ReleaseGateResult = z.infer<typeof releaseGateResultSchema>;

export const acquireRequestSchema = z
  .object({
    providerId: providerIdSchema,
    providerItemId: providerItemIdSchema,
    intendedUse: usePolicyProfileSchema,
    projectId: z.uuid(),
  })
  .strict();
export type AcquireRequest = z.infer<typeof acquireRequestSchema>;

/* ---------------------------------------------------------------- IPC payloads */

export const rightsSearchRequestSchema = z
  .object({
    providerId: providerIdSchema,
    query: z.string().trim().min(1).max(200),
    mediaKind: mediaKindSchema,
    intendedUse: usePolicyProfileSchema,
  })
  .strict();
export type RightsSearchRequest = z.infer<typeof rightsSearchRequestSchema>;

export const rightsSearchResponseSchema = z
  .object({
    providerId: providerIdSchema,
    candidates: z.array(rightsCandidateSchema).max(100).readonly(),
  })
  .strict();
export type RightsSearchResponse = z.infer<typeof rightsSearchResponseSchema>;

export const providerStatusSchema = z
  .object({
    providerId: providerIdSchema,
    displayName: boundedText,
    requiresKey: z.boolean(),
    keyConfigured: z.boolean(),
  })
  .strict();
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const acquiredImportSourceSchema = z
  .object({
    absolutePath: z.string().min(1).max(4_096),
    contentIdentity: mediaContentIdentityV1Schema,
    /** Present for video; images and audio are receipted but not yet placeable. */
    probe: mediaProbeSchema.nullable(),
  })
  .strict();
export type AcquiredImportSource = z.infer<typeof acquiredImportSourceSchema>;

export const rightsAcquireResponseSchema = z
  .object({
    receipt: acquisitionReceiptSchema,
    importSource: acquiredImportSourceSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.receipt.content.digest === value.importSource.contentIdentity.digest &&
      value.receipt.content.byteLength === value.importSource.contentIdentity.byteLength,
    { message: "Acquired bytes must match the receipt" },
  );
export type RightsAcquireResponse = z.infer<typeof rightsAcquireResponseSchema>;

export const receiptIdRequestSchema = z.object({ receiptId: z.uuid() }).strict();

export const snapshotIntegritySchema = z.enum(["ok", "missing", "tampered"]);
export type SnapshotIntegrity = z.infer<typeof snapshotIntegritySchema>;

export const receiptInspectionSchema = z
  .object({
    receipt: acquisitionReceiptSchema,
    snapshots: z
      .array(
        z.object({ snapshot: licenseSnapshotSchema, integrity: snapshotIntegritySchema }).strict(),
      )
      .readonly(),
    refreshes: z
      .array(z.object({ atMs: nonNegativeInteger, status: refreshStatusSchema }).strict())
      .readonly(),
    freshnessWindowMs: nonNegativeInteger,
  })
  .strict();
export type ReceiptInspection = z.infer<typeof receiptInspectionSchema>;

export const receiptListSchema = z.array(acquisitionReceiptSchema).readonly();
