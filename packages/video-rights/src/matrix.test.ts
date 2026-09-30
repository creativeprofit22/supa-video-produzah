import { readFileSync } from "node:fs";

import {
  licenseIdSchema,
  policyDecisionSchema,
  providerIdSchema,
  structuredAttributionSchema,
  usePolicyProfileSchema,
  licenseCodeSchema,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { missingAttributionFields, renderCreditsText } from "./attribution.js";
import { licenseDisplayName, normalizeLicense, resolveLicenseConflict } from "./license.js";
import { evaluatePolicy } from "./policy.js";

const matrixSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.array(usePolicyProfileSchema),
  normalization: z.array(
    z.object({
      name: z.string(),
      input: z.object({
        providerId: providerIdSchema,
        url: z.string().nullable(),
        name: z.string().nullable(),
        version: z.string().nullable(),
      }),
      expected: licenseIdSchema,
      displayName: z.string(),
    }),
  ),
  policy: z.array(
    z.object({
      code: licenseCodeSchema,
      conflict: z.boolean(),
      expected: z.record(usePolicyProfileSchema, policyDecisionSchema),
    }),
  ),
  conflicts: z.array(
    z.object({
      name: z.string(),
      item: licenseIdSchema,
      collection: licenseIdSchema.nullable(),
      expected: z.object({ license: licenseIdSchema, conflict: z.boolean() }),
    }),
  ),
  attribution: z.array(
    z.object({
      name: z.string(),
      code: licenseCodeSchema,
      attribution: structuredAttributionSchema,
      expectedMissing: z.array(z.string()),
    }),
  ),
  credits: z.array(
    z.object({
      name: z.string(),
      entries: z.array(
        z.object({ receiptId: z.string(), attribution: structuredAttributionSchema }),
      ),
      expectedText: z.string(),
    }),
  ),
});

const matrix = matrixSchema.parse(
  JSON.parse(
    readFileSync(new URL("../fixtures/license-matrix-v1.json", import.meta.url), "utf8"),
  ) as unknown,
);

describe("shared license matrix (TypeScript mirror)", () => {
  it.each(matrix.normalization)("normalizes: $name", ({ input, expected, displayName }) => {
    const license = normalizeLicense(input);
    expect(license).toEqual(expected);
    expect(licenseDisplayName(license, input.providerId)).toBe(displayName);
  });

  it("covers every license code in the policy table across all profiles", () => {
    const codes = new Set(matrix.policy.map((row) => row.code));
    expect([...codes].sort()).toEqual([...licenseCodeSchema.options].sort());
    expect(matrix.profiles).toEqual([...usePolicyProfileSchema.options]);
  });

  for (const row of matrix.policy) {
    for (const profile of matrix.profiles) {
      it(`policy ${row.code}${row.conflict ? " (conflict)" : ""} for ${profile}`, () => {
        expect(evaluatePolicy(row.code, profile, row.conflict)).toEqual(row.expected[profile]);
      });
    }
  }

  it.each(matrix.conflicts)("resolves item/collection: $name", ({ item, collection, expected }) => {
    expect(resolveLicenseConflict(item, collection)).toEqual(expected);
  });

  it.each(matrix.attribution)("attribution completeness: $name", (row) => {
    expect(missingAttributionFields(row.code, row.attribution)).toEqual(row.expectedMissing);
  });

  it.each(matrix.credits)("credits text: $name", ({ entries, expectedText }) => {
    expect(renderCreditsText(entries)).toBe(expectedText);
  });
});
