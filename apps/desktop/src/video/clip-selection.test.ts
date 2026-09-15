import { describe, expect, it } from "vitest";
import { pruneSelection, selectClips } from "./clip-selection";
describe("ephemeral bounded selection", () => {
  const order = ["a", "b", "c"];
  it("replaces, toggles, and selects an ordered range with a stable primary", () => {
    const first = selectClips({ ids: [], primary: null }, "a", order, "replace");
    expect(selectClips(first, "c", order, "range")).toEqual({ ids: order, primary: "a" });
    expect(selectClips(first, "b", order, "toggle").ids).toEqual(["a", "b"]);
    expect(selectClips(first, "a", order, "toggle")).toEqual({ ids: [], primary: null });
  });
  it("rejects oversized ranges without changing the previous selection", () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i));
    const current = { ids: ["0"], primary: "0" };
    expect(() => selectClips(current, "100", ids, "range")).toThrow("at most 100");
    expect(current.ids).toEqual(["0"]);
    expect(selectClips(current, "99", ids, "range").ids).toHaveLength(100);
  });
  it("only prunes missing IDs and never selects new clips after deselection", () => {
    const current = { ids: ["a", "b"], primary: "a" };
    expect(pruneSelection(current, order)).toBe(current);
    expect(pruneSelection(current, ["b", "c"])).toEqual({ ids: ["b"], primary: "b" });
    expect(pruneSelection({ ids: [], primary: null }, order).ids).toEqual([]);
    expect(pruneSelection({ ids: ["removed"], primary: "removed" }, order)).toEqual({
      ids: ["a"],
      primary: "a",
    });
    expect(pruneSelection(current, [])).toEqual({ ids: [], primary: null });
  });
});
