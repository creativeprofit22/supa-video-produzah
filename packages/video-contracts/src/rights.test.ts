import { describe, expect, it } from "vitest";

import { videoAssetSchema } from "./project.js";
import { videoProjectSnapshotV2Schema } from "./project-v2.js";
import {
  acquireRequestSchema,
  acquisitionReceiptSchema,
  assetOriginSchema,
  licenseIdSchema,
  providerItemIdSchema,
  releaseGateResultSchema,
  rightsCandidateSchema,
} from "./rights.js";

const ids = {
  receipt: "00000000-0000-4000-8000-0000000000a1",
  project: "00000000-0000-4000-8000-0000000000a2",
  asset: "00000000-0000-4000-8000-0000000000a3",
  revision: "00000000-0000-4000-8000-0000000000a4",
  generation: "00000000-0000-4000-8000-0000000000a5",
} as const;
const digest = "ab".repeat(32);

function localAsset(): Record<string, unknown> {
  return {
    id: ids.asset,
    displayName: "local.mp4",
    locator: { absolutePath: "C:\\Media\\local.mp4" },
    probe: {
      durationMicroseconds: 1_000_000,
      averageFrameRate: { numerator: 30, denominator: 1 },
      realFrameRate: { numerator: 30, denominator: 1 },
      variableFrameRate: false,
      width: 640,
      height: 360,
      videoCodecName: "h264",
      audio: null,
      fileSizeBytes: 1_000,
    },
    contentIdentity: { schemaVersion: 1, algorithm: "sha256", digest, byteLength: 1_000 },
  };
}

function receipt(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    receiptId: ids.receipt,
    providerId: "wikimedia-commons",
    providerItemId: "File:Example.webm",
    projectId: ids.project,
    intendedUse: "commercial-online",
    mediaKind: "video",
    mediaType: "video/webm",
    content: { schemaVersion: 1, algorithm: "sha256", digest, byteLength: 1_000 },
    license: { code: "by", version: "4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    itemLicense: {
      code: "by",
      version: "4.0",
      url: "https://creativecommons.org/licenses/by/4.0/",
    },
    collectionLicense: null,
    policy: { outcome: "allow", reasons: ["attribution-required"] },
    attribution: {
      title: "Example",
      creator: "Jane Doe",
      creatorUrl: null,
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.webm",
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
        fetchedAtMs: 1,
      },
    ],
    etag: null,
    acquiredAtMs: 1,
    lastRefreshAtMs: 1,
    lastRefreshStatus: "unchanged",
  };
}

describe("asset origin", () => {
  it("keeps local assets without origin parsing unchanged", () => {
    const asset = localAsset();
    const parsed = videoAssetSchema.parse(asset);
    expect(parsed).toEqual(asset);
    expect("origin" in parsed).toBe(false);
  });

  it("parses a legacy project snapshot whose assets have no origin", () => {
    const hash = "0".repeat(64);
    const timestamp = "2026-07-26T12:00:00.000Z";
    const snapshot = {
      schemaVersion: 2,
      id: ids.project,
      name: "Legacy",
      createdAt: timestamp,
      updatedAt: timestamp,
      storageGenerationId: ids.generation,
      revision: {
        number: 0,
        id: ids.revision,
        parentId: null,
        committedAt: timestamp,
        operationId: ids.asset,
        stateHash: hash,
      },
      state: { assets: [localAsset()], sequences: [], activeSequenceId: null },
      history: { undoStack: [], redoStack: [] },
      lastAppliedRecordNumber: 0,
      lastRecordHash: hash,
    };
    expect(videoProjectSnapshotV2Schema.safeParse(snapshot).success).toBe(true);
  });

  it("accepts an acquired origin", () => {
    const asset = {
      ...localAsset(),
      origin: { kind: "acquired", acquisitionReceiptId: ids.receipt },
    };
    expect(videoAssetSchema.parse(asset)).toEqual(asset);
  });

  it.each([
    { kind: "local", acquisitionReceiptId: ids.receipt },
    { kind: "acquired", acquisitionReceiptId: "not-a-uuid" },
    { kind: "acquired", acquisitionReceiptId: ids.receipt, license: "cc0" },
    null,
  ])("rejects malformed origin %#", (origin) => {
    expect(assetOriginSchema.safeParse(origin).success).toBe(false);
    expect(videoAssetSchema.safeParse({ ...localAsset(), origin }).success).toBe(false);
  });
});

describe("acquire request", () => {
  const request = {
    providerId: "pexels",
    providerItemId: "123456",
    intendedUse: "private-preview",
    projectId: ids.project,
  };

  it("accepts only ids and the intended use", () => {
    expect(acquireRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    { ...request, license: "cc0" },
    { ...request, attribution: "me" },
    { ...request, downloadUrl: "https://evil.example/x.mp4" },
    { ...request, providerId: "flickr" },
    { ...request, intendedUse: "anything" },
  ])("rejects UI-supplied rights or URL fields %#", (candidate) => {
    expect(acquireRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it.each(["../etc/passwd", " padded", "a/b", "a\\b", "", "x".repeat(257)])(
    "rejects unsafe provider item id %j",
    (value) => {
      expect(providerItemIdSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("receipt and gate contracts", () => {
  it("accepts a complete receipt", () => {
    expect(acquisitionReceiptSchema.safeParse(receipt()).success).toBe(true);
  });

  it.each([
    { snapshots: [] },
    { license: { code: "gpl", version: null, url: null } },
    { lastRefreshStatus: "maybe" },
    { schemaVersion: 2 },
    { extra: true },
  ])("rejects malformed receipt %#", (patch) => {
    expect(acquisitionReceiptSchema.safeParse({ ...receipt(), ...patch }).success).toBe(false);
  });

  it("rejects non-https license urls", () => {
    expect(
      licenseIdSchema.safeParse({ code: "by", version: "4.0", url: "http://creativecommons.org" })
        .success,
    ).toBe(false);
  });

  it("models pass and blocked gate results", () => {
    expect(
      releaseGateResultSchema.parse({ outcome: "pass", creditedReceiptIds: [ids.receipt] }),
    ).toBeTruthy();
    expect(
      releaseGateResultSchema.safeParse({
        outcome: "blocked",
        failures: [{ digest, receiptId: null, reason: "receipt-missing" }],
      }).success,
    ).toBe(true);
    expect(releaseGateResultSchema.safeParse({ outcome: "blocked", failures: [] }).success).toBe(
      false,
    );
  });

  it("accepts a search candidate with an advisory policy", () => {
    expect(
      rightsCandidateSchema.safeParse({
        providerId: "openverse",
        providerItemId: "4bc43a04-ef46-4544-a0c1-63c63f56e276",
        mediaKind: "image",
        title: "Tree",
        creator: null,
        landingUrl: "https://www.flickr.com/photos/1",
        thumbnailUrl: null,
        license: { code: "cc0", version: "1.0", url: null },
        durationMs: null,
        width: 10,
        height: 10,
        advisoryPolicy: { outcome: "allow", reasons: [] },
      }).success,
    ).toBe(true);
  });
});
