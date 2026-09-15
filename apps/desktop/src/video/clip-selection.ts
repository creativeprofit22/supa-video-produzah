export const MAX_SELECTED_CLIPS = 100;
export interface ClipSelection {
  readonly ids: readonly string[];
  readonly primary: string | null;
}
export function selectClips(
  current: ClipSelection,
  id: string,
  ordered: readonly string[],
  mode: "replace" | "toggle" | "range",
): ClipSelection {
  if (!ordered.includes(id)) return { ids: [id], primary: id };
  let ids: readonly string[];
  if (mode === "range" && current.primary !== null && ordered.includes(current.primary)) {
    const a = ordered.indexOf(current.primary),
      b = ordered.indexOf(id);
    ids = ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
  } else if (mode === "toggle") {
    const mediaIds = current.ids.filter((value) => ordered.includes(value));
    ids = mediaIds.includes(id) ? mediaIds.filter((value) => value !== id) : [...mediaIds, id];
  } else ids = [id];
  if (ids.length > MAX_SELECTED_CLIPS)
    throw new Error("Select at most 100 media clips. Selection was not changed.");
  return {
    ids,
    primary: mode === "range" ? current.primary : ids.includes(id) ? id : (ids[0] ?? null),
  };
}
export function pruneSelection(current: ClipSelection, existing: readonly string[]): ClipSelection {
  const remaining = current.ids.filter((id) => existing.includes(id));
  if (remaining.length === current.ids.length) return current;
  // Preserve the established single-clip fallback after undo/removal, but an
  // explicit empty selection never selects newly added clips by itself.
  const ids = remaining.length === 0 && existing[0] ? [existing[0]] : remaining;
  return {
    ids,
    primary:
      current.primary !== null && ids.includes(current.primary)
        ? current.primary
        : (ids[0] ?? null),
  };
}
