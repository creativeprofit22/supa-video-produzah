import {
  type AcquisitionReceipt,
  type LicenseCode,
  type VideoAsset,
  acquisitionReceiptSchema,
  videoAssetSchema,
} from "@supa-video/contracts";

/* Test-only factories. Every call returns fresh, schema-validated values. */

export const TEST_NOW_MS = 1_790_000_000_000;
export const TEST_DAY_MS = 86_400_000;
export const TEST_PROJECT_ID = "00000000-0000-4000-8000-00000000b001";

export function testUuid(group: number, index: number): string {
  return `${group.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export interface TestAssetOptions {
  readonly id: string;
  readonly name: string;
  readonly durationUs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly digest?: string;
  readonly receiptId?: string;
  readonly variableFrameRate?: boolean;
}

export function testAsset(options: TestAssetOptions): VideoAsset {
  return videoAssetSchema.parse({
    id: options.id,
    displayName: options.name,
    locator: { relativePath: `media/${options.name}` },
    probe: {
      durationMicroseconds: options.durationUs ?? 20_000_000,
      averageFrameRate: { numerator: 30, denominator: 1 },
      realFrameRate: { numerator: 30, denominator: 1 },
      variableFrameRate: options.variableFrameRate ?? false,
      width: options.width ?? 1920,
      height: options.height ?? 1080,
      videoCodecName: "h264",
      audio: null,
      fileSizeBytes: 1000,
    },
    ...(options.digest === undefined
      ? {}
      : {
          contentIdentity: {
            schemaVersion: 1,
            algorithm: "sha256",
            digest: options.digest,
            byteLength: 1000,
          },
        }),
    ...(options.receiptId === undefined
      ? {}
      : { origin: { kind: "acquired", acquisitionReceiptId: options.receiptId } }),
  });
}

export interface TestReceiptOptions {
  readonly receiptId: string;
  readonly digest: string;
  readonly license?: LicenseCode;
  readonly providerId?: AcquisitionReceipt["providerId"];
  readonly title?: string;
  readonly refreshedAgoMs?: number;
  readonly status?: AcquisitionReceipt["lastRefreshStatus"];
}

export function testReceipt(options: TestReceiptOptions): AcquisitionReceipt {
  const code = options.license ?? "cc0";
  const refreshed = TEST_NOW_MS - (options.refreshedAgoMs ?? TEST_DAY_MS);
  const license = {
    code,
    version:
      code === "cc0" || code === "pdm" || code === "unknown" || code === "custom" ? null : "4.0",
    url: null,
  };
  return acquisitionReceiptSchema.parse({
    schemaVersion: 1,
    receiptId: options.receiptId,
    providerId: options.providerId ?? "wikimedia-commons",
    providerItemId: `File:${options.receiptId}.webm`,
    projectId: TEST_PROJECT_ID,
    intendedUse: "commercial-online",
    mediaKind: "video",
    mediaType: "video/webm",
    content: { schemaVersion: 1, algorithm: "sha256", digest: options.digest, byteLength: 1000 },
    license,
    itemLicense: license,
    collectionLicense: null,
    policy: { outcome: "allow", reasons: [] },
    attribution: {
      title: options.title ?? "Clip",
      creator: "Jane Example",
      creatorUrl: null,
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Clip.webm",
      providerName: "Wikimedia Commons",
      licenseName: code.toUpperCase(),
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
    snapshots: [
      {
        kind: "api-record",
        digest: "cd".repeat(32),
        byteLength: 1,
        url: "https://commons.wikimedia.org/w/api.php",
        mediaType: "application/json",
        fetchedAtMs: refreshed,
      },
    ],
    etag: null,
    acquiredAtMs: refreshed,
    lastRefreshAtMs: refreshed,
    lastRefreshStatus: options.status ?? "unchanged",
  });
}
