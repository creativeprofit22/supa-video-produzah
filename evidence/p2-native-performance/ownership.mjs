import path from "node:path";

// Caller must obtain observations from the OS, not from CDP/page content.
export function assertOwnedTarget(expected, observed) {
  const normalize = (p) => path.win32.normalize(p).toLowerCase();
  const relative = path.win32.relative(
    normalize(expected.isolatedRoot),
    normalize(observed.executable),
  );
  if (!relative || relative.startsWith("..") || path.win32.isAbsolute(relative))
    throw new Error("Executable outside isolated root");
  if (
    normalize(expected.executable) !== normalize(observed.executable) ||
    expected.pid !== observed.pid ||
    expected.creationUtc !== observed.creationUtc
  )
    throw new Error("Process identity mismatch");
  if (
    !Number.isInteger(expected.port) ||
    expected.port < 1024 ||
    expected.port > 65535 ||
    observed.port !== expected.port ||
    observed.address !== "127.0.0.1"
  )
    throw new Error("Non-owned loopback endpoint");
  const owner = observed.descendants.find((p) => p.pid === observed.portOwnerPid);
  if (
    !owner ||
    !owner.creationUtc ||
    owner.creationUtc < expected.creationUtc ||
    !owner.commandLineArguments.includes(`--remote-debugging-port=${expected.port}`)
  )
    throw new Error("Port owner is not the owned diagnostic WebView");
  if (
    observed.pageUrl !== "http://tauri.localhost/" &&
    observed.pageUrl !== "https://tauri.localhost/"
  )
    throw new Error("Unexpected native page target");
  return true;
}
