import type { AcquisitionReceipt, RightsCandidate } from "@supa-video/contracts";

/* Shared, immutable test fixtures for rights IPC and UI tests. */

export const rightsIds = {
  receipt: "00000000-0000-4000-8000-00000000a001",
  project: "00000000-0000-4000-8000-000000000b01",
} as const;

export const acquiredDigest = "ab".repeat(32);

export function sampleReceipt(overrides: Partial<AcquisitionReceipt> = {}): AcquisitionReceipt {
  return {
    schemaVersion: 1,
    receiptId: rightsIds.receipt,
    providerId: "wikimedia-commons",
    providerItemId: "File:Clip.webm",
    projectId: rightsIds.project,
    intendedUse: "commercial-online",
    mediaKind: "video",
    mediaType: "video/webm",
    content: { schemaVersion: 1, algorithm: "sha256", digest: acquiredDigest, byteLength: 4100 },
    license: { code: "by", version: "4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    itemLicense: {
      code: "by",
      version: "4.0",
      url: "https://creativecommons.org/licenses/by/4.0/",
    },
    collectionLicense: null,
    policy: { outcome: "allow", reasons: ["attribution-required"] },
    attribution: {
      title: "Clip",
      creator: "Jane Doe",
      creatorUrl: null,
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Clip.webm",
      providerName: "Wikimedia Commons",
      licenseName: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
    snapshots: [
      {
        kind: "api-record",
        digest: "cd".repeat(32),
        byteLength: 512,
        url: "https://commons.wikimedia.org/w/api.php?action=query",
        mediaType: "application/json",
        fetchedAtMs: 1_700_000_000_000,
      },
    ],
    etag: '"v1"',
    acquiredAtMs: 1_700_000_000_000,
    lastRefreshAtMs: 1_700_000_000_000,
    lastRefreshStatus: "unchanged",
    ...overrides,
  };
}

export function sampleCandidate(overrides: Partial<RightsCandidate> = {}): RightsCandidate {
  return {
    providerId: "wikimedia-commons",
    providerItemId: "File:Clip.webm",
    mediaKind: "video",
    title: "Clip",
    creator: "Jane Doe",
    landingUrl: "https://commons.wikimedia.org/wiki/File:Clip.webm",
    thumbnailUrl: null,
    license: { code: "by", version: "4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    durationMs: 4_000,
    width: 640,
    height: 360,
    advisoryPolicy: { outcome: "allow", reasons: ["attribution-required"] },
    ...overrides,
  };
}

export const sampleProbe = {
  durationMicroseconds: 4_000_000,
  averageFrameRate: { numerator: 25, denominator: 1 },
  realFrameRate: { numerator: 25, denominator: 1 },
  variableFrameRate: false,
  width: 640,
  height: 360,
  videoCodecName: "vp9",
  audio: null,
  fileSizeBytes: 4100,
} as const;
