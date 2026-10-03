import { describe, expect, it } from "vitest";

import {
  AGENT_GRAPHICS_MAX_ITEMS,
  agentGraphicsDescriptionSchema,
} from "./agent-graphics-description.js";

const title = { kind: "card", id: "title", role: "title", text: "Hello", atUs: 0 } as const;

describe("agentGraphicsDescriptionSchema", () => {
  it.each([
    ["one card", { schemaVersion: 1, items: [title] }],
    [
      "recipe, overrides and a caption",
      {
        schemaVersion: 1,
        recipeId: "retro",
        items: [
          { ...title, durationUs: 2_000_000, preset: "slam", fontKey: "georgia-bold" },
          {
            kind: "caption",
            id: "cap-1",
            text: "Three things",
            atUs: 3_000_000,
            reveal: "word",
            colour: "#FFCC00",
          },
        ],
      },
    ],
  ])("accepts %s", (_name, input) => {
    expect(agentGraphicsDescriptionSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ["wrong version", { schemaVersion: 2, items: [title] }, ["schemaVersion"]],
    ["no items", { schemaVersion: 1, items: [] }, ["items"]],
    [
      "too many items",
      {
        schemaVersion: 1,
        items: Array.from({ length: AGENT_GRAPHICS_MAX_ITEMS + 1 }, (_, index) => ({
          ...title,
          id: `t-${index}`,
        })),
      },
      ["items"],
    ],
    ["unknown field", { schemaVersion: 1, items: [{ ...title, layers: [] }] }, ["items", 0]],
    ["unknown top-level field", { schemaVersion: 1, items: [title], x: 1 }, []],
    [
      "fractional time",
      { schemaVersion: 1, items: [{ ...title, atUs: 1.5 }] },
      ["items", 0, "atUs"],
    ],
    ["negative time", { schemaVersion: 1, items: [{ ...title, atUs: -1 }] }, ["items", 0, "atUs"]],
    [
      "zero duration",
      { schemaVersion: 1, items: [{ ...title, durationUs: 0 }] },
      ["items", 0, "durationUs"],
    ],
    [
      "bad colour",
      { schemaVersion: 1, items: [{ ...title, colour: "red" }] },
      ["items", 0, "colour"],
    ],
    [
      "bad font",
      { schemaVersion: 1, items: [{ ...title, fontKey: "comic" }] },
      ["items", 0, "fontKey"],
    ],
    [
      "bad preset",
      { schemaVersion: 1, items: [{ ...title, preset: "spin" }] },
      ["items", 0, "preset"],
    ],
    ["blank text", { schemaVersion: 1, items: [{ ...title, text: "  " }] }, ["items", 0, "text"]],
    [
      "unknown kind",
      { schemaVersion: 1, items: [{ ...title, kind: "chart" }] },
      ["items", 0, "kind"],
    ],
    ["duplicate ids", { schemaVersion: 1, items: [title, title] }, ["items", 1, "id"]],
  ])("rejects %s", (_name, input, path) => {
    const result = agentGraphicsDescriptionSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path.slice(0, path.length)).toEqual(path);
    }
  });
});
