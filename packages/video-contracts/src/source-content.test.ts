import { describe, expect, it } from "vitest";

import { mediaContentIdentityV1Schema } from "./source-content.js";

const validIdentity = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "ab".repeat(32),
  byteLength: 42,
} as const;

describe("MediaContentIdentityV1", () => {
  it("accepts the exact lowercase SHA-256 contract", () => {
    expect(mediaContentIdentityV1Schema.parse(validIdentity)).toEqual(validIdentity);
  });

  it.each([
    { ...validIdentity, schemaVersion: 2 },
    { ...validIdentity, algorithm: "SHA-256" },
    { ...validIdentity, digest: "AB".repeat(32) },
    { ...validIdentity, digest: "a".repeat(63) },
    { ...validIdentity, digest: `${"a".repeat(63)}g` },
    { ...validIdentity, byteLength: 0 },
    { ...validIdentity, byteLength: Number.MAX_SAFE_INTEGER + 1 },
    { ...validIdentity, extra: true },
  ])("rejects malformed or non-canonical identity %#", (candidate) => {
    expect(mediaContentIdentityV1Schema.safeParse(candidate).success).toBe(false);
  });
});
