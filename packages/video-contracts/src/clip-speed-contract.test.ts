import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseClipSpeedPercent } from "./clip-timing.js";
import { projectCommandSchemaV2 } from "./project-commands-v2.js";
import { renderClipTimingV2Schema } from "./render-plan.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
}
const command = projectCommandSchemaV2.parse(fixture("clip-speed-command"));
const invalid = fixture("clip-speed-invalid") as { name: string; speed: unknown }[];
const timings = fixture("clip-speed-timing") as {
  name: string;
  sourceIn: unknown;
  sourceOut: unknown;
  sequenceRate: { numerator: number; denominator: number };
  speed?: unknown;
  expected: number | null;
}[];

describe("SetClipSpeed wire contract", () => {
  it("round trips the shared normal-speed command", () => {
    expect(command).toEqual(fixture("clip-speed-command"));
    expect(projectCommandSchemaV2.parse(JSON.parse(JSON.stringify(command)))).toEqual(command);
  });
  it("accepts every supported whole percentage without a float", () => {
    for (let percent = 50; percent <= 200; percent++) {
      const value = { ...command, speed: parseClipSpeedPercent(String(percent)) };
      expect(projectCommandSchemaV2.parse(value)).toEqual(value);
    }
  });
  it.each(invalid)("rejects shared invalid command speed: $name", ({ speed }) => {
    expect(projectCommandSchemaV2.safeParse({ ...command, speed }).success).toBe(false);
  });
  it("requires speed and rejects whole-clip or extra-field replacement", () => {
    const withoutSpeed: Record<string, unknown> = { ...command };
    delete withoutSpeed.speed;
    expect(projectCommandSchemaV2.safeParse(withoutSpeed).success).toBe(false);
    expect(
      projectCommandSchemaV2.safeParse({
        ...command,
        sourceIn: { value: 0, rateNumerator: 30, rateDenominator: 1 },
      }).success,
    ).toBe(false);
    expect(projectCommandSchemaV2.safeParse({ ...command, clipId: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});

describe("exact V2 render timing metadata", () => {
  it.each(timings)("shared duration fixture: $name", (row) => {
    const value = {
      sourceIn: row.sourceIn,
      sourceOut: row.sourceOut,
      speed: row.speed ?? { numerator: 1, denominator: 1 },
      outputDuration: {
        value: row.expected ?? 1,
        rateNumerator: row.sequenceRate.numerator,
        rateDenominator: row.sequenceRate.denominator,
      },
    };
    const result = renderClipTimingV2Schema.safeParse(value);
    expect(result.success).toBe(row.expected !== null);
    if (result.success) {
      expect(result.data).toEqual(value);
      expect(renderClipTimingV2Schema.parse(JSON.parse(JSON.stringify(result.data)))).toEqual(
        value,
      );
      expect(
        renderClipTimingV2Schema.safeParse({
          ...value,
          outputDuration: { ...value.outputDuration, value: value.outputDuration.value + 1 },
        }).success,
      ).toBe(false);
    }
  });
  it("requires an atomic metadata bundle and rejects extra fields", () => {
    const value = {
      sourceIn: { value: 0, rateNumerator: 30, rateDenominator: 1 },
      sourceOut: { value: 30, rateNumerator: 30, rateDenominator: 1 },
      speed: { numerator: 1, denominator: 1 },
      outputDuration: { value: 30, rateNumerator: 30, rateDenominator: 1 },
    };
    for (const field of Object.keys(value)) {
      const partial: Record<string, unknown> = { ...value };
      delete partial[field];
      expect(renderClipTimingV2Schema.safeParse(partial).success).toBe(false);
    }
    expect(renderClipTimingV2Schema.safeParse({ ...value, preservePitch: false }).success).toBe(
      false,
    );
    expect(renderClipTimingV2Schema.safeParse({ ...value, speed: null }).success).toBe(false);
  });
});
