import { nativeReady } from "../2026-09-14-p2-speed/output-capture/native-readiness.mjs";

// Re-establish native title readiness after navigation, without authorizing a new window.
export async function prepareTargetForCapture(target, page, owner, authorizedWindow, options) {
  const identity = { ...owner.identity };
  const requireOwner = () => {
    if (owner.identity.pid !== identity.pid || owner.identity.creation !== identity.creation)
      throw Error("Target owner identity changed");
  };
  if (!authorizedWindow.valid || authorizedWindow.handle === "0")
    throw Error("No authorized target HWND");
  await target.prepare(page);
  requireOwner();
  const pinnedOwner = {
    identity,
    async findWindow() {
      requireOwner();
      const current = await owner.findWindow();
      requireOwner();
      if (!current.valid || current.handle !== authorizedWindow.handle)
        throw Error("Target HWND identity changed");
      return current;
    },
  };
  // Keep nativeReady's existing deadline and polling behavior, including all native predicates.
  const ready = await nativeReady(pinnedOwner, page, options);
  requireOwner();
  return ready;
}
