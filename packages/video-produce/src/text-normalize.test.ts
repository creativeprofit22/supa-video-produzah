import { describe, expect, it } from "vitest";

import { normalizeText, normalizeTokens } from "./text-normalize.js";

describe("normalizeText", () => {
  it.each([
    ["Cañón", "canon"],
    ["Brücke", "brucke"],
    ["ＲÍＯ", "rio"],
    ["Forêt", "foret"],
  ])("folds %s to %s", (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });
});

describe("normalizeTokens", () => {
  it.each([
    ["es", "El río cruza el cañón", ["canyon", "cruza", "river"]],
    ["de", "Der Fluss unter der Brücke", ["bridge", "river", "unter"]],
    ["fr", "La rivière et la forêt", ["forest", "river"]],
    ["pt", "O rio e a floresta", ["forest", "river"]],
    ["en", "The rivers and canyons", ["canyon", "river"]],
  ])("maps %s text onto shared concepts", (language, text, expected) => {
    expect(normalizeTokens(text, language)).toEqual(expected);
  });

  it("splits file names and drops bare numbers", () => {
    expect(normalizeTokens("Kayak_river-canyon_01.MP4")).toEqual([
      "canyon",
      "kayak",
      "mp4",
      "river",
    ]);
  });

  it("returns sorted unique tokens", () => {
    expect(normalizeTokens("river river Fluss")).toEqual(["river"]);
  });
});
