export const WORKSPACE_PREFERENCES_KEY = "supa-video.workspace-preferences";
export const DEFAULT_WORKSPACE_SPLIT = 68.5;
export type WorkspaceStorage = Pick<Storage, "getItem" | "setItem">;

export function workspaceStorage(): WorkspaceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadWorkspaceSplit(storage: WorkspaceStorage | null): number {
  try {
    const value: unknown = JSON.parse(storage?.getItem(WORKSPACE_PREFERENCES_KEY) ?? "null");
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return DEFAULT_WORKSPACE_SPLIT;
    const record = value as Record<string, unknown>;
    return record.version === 1 &&
      typeof record.split === "number" &&
      Number.isFinite(record.split) &&
      record.split >= 25 &&
      record.split <= 75
      ? record.split
      : DEFAULT_WORKSPACE_SPLIT;
  } catch {
    return DEFAULT_WORKSPACE_SPLIT;
  }
}

export function saveWorkspaceSplit(storage: WorkspaceStorage | null, split: number): boolean {
  if (!storage || !Number.isFinite(split) || split < 25 || split > 75) return false;
  try {
    storage.setItem(WORKSPACE_PREFERENCES_KEY, JSON.stringify({ version: 1, split }));
    return true;
  } catch {
    return false;
  }
}
