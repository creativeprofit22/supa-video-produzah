import { describe, expect, it } from "vitest";

import {
  clearLegacyMediaCacheRequestSchema,
  clearLegacyMediaCacheResponseSchema,
  getMediaCacheStatusRequestSchema,
  mediaCacheStatusSchema,
} from "./cache.js";

const status = {
  schemaVersion: 1,
  budgetBytes: 20 * 1024 * 1024 * 1024,
  managedBytes: 8_000,
  leasedBytes: 3_000,
  reclaimableBytes: 5_000,
  artifactCount: 4,
  leasedArtifactCount: 2,
  pressure: "normal",
  legacyBytes: 1_000,
  legacyEntryCount: 2,
  legacyUnsafeEntryCount: 0,
  legacyClearAvailable: true,
  recoveryWarning: null,
  refreshedAt: "2026-07-27T12:00:00.000Z",
} as const;

describe("media cache contracts", () => {
  it("accepts strict status and explicit confirmed cleanup", () => {
    expect(mediaCacheStatusSchema.parse(status)).toEqual(status);
    expect(getMediaCacheStatusRequestSchema.parse({})).toEqual({});
    expect(clearLegacyMediaCacheRequestSchema.parse({ confirmed: true })).toEqual({
      confirmed: true,
    });
    expect(
      clearLegacyMediaCacheResponseSchema.parse({
        schemaVersion: 1,
        clearedBytes: 1_000,
        clearedEntryCount: 2,
        skippedUnsafeEntryCount: 0,
        status: { ...status, legacyBytes: 0, legacyEntryCount: 0, legacyClearAvailable: false },
      }).clearedBytes,
    ).toBe(1_000);
  });

  it("rejects impossible accounting and hidden cleanup bypasses", () => {
    expect(() => mediaCacheStatusSchema.parse({ ...status, leasedBytes: 8_001 })).toThrow();
    expect(() => mediaCacheStatusSchema.parse({ ...status, reclaimableBytes: 5_001 })).toThrow();
    expect(() => mediaCacheStatusSchema.parse({ ...status, leasedArtifactCount: 5 })).toThrow();
    expect(() =>
      mediaCacheStatusSchema.parse({
        ...status,
        budgetBytes: 7_999,
        managedBytes: 8_000,
        pressure: "normal",
      }),
    ).toThrow("pressure");
    expect(() =>
      mediaCacheStatusSchema.parse({ ...status, legacyClearAvailable: false }),
    ).toThrow();
    expect(() => clearLegacyMediaCacheRequestSchema.parse({ confirmed: false })).toThrow();
    expect(() =>
      clearLegacyMediaCacheRequestSchema.parse({ confirmed: true, root: "C:\\private" }),
    ).toThrow();
  });

  it("rejects unsafe integer overflow and unknown native details", () => {
    expect(() =>
      mediaCacheStatusSchema.parse({ ...status, managedBytes: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() =>
      mediaCacheStatusSchema.parse({ ...status, databasePath: "private.sqlite3" }),
    ).toThrow();
    expect(() => getMediaCacheStatusRequestSchema.parse({ includePaths: true })).toThrow();
  });
});
