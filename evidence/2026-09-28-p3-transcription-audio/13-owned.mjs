// Copy of 2026-09-14-p2-speed/output-capture/owned-browser.mjs startOwned, pointed at
// OwnedLauncher13.exe = 13-OwnedLauncher.cpp (only change: max lease 120000 -> 1800000 ms,
// for a ~15 min continuous scenario). The launcher puts the app in a kill-on-close job object.
import { spawn } from "node:child_process";

export const launcher = "E:/nemo-runtime/proof/hwhap-436/scenario/launcher/OwnedLauncher13.exe";

const delay = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

export function startOwned(executable, args, { leaseMs = 30000, onEvent = () => {} } = {}) {
  const child = spawn(launcher, [String(leaseMs), executable, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const events = [];
  let buffer = "";
  let exited = false;
  let stderr = "";
  const emit = (event) => {
    events.push(event);
    onEvent(event);
  };
  child.stdin.on("error", () => {});
  child.stdout.on("data", (bytes) => {
    buffer += bytes;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        emit(JSON.parse(line));
      } catch {
        emit({ event: "output", line });
      }
    }
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const exit = new Promise((resolve) => {
    child.on("error", (error) => {
      exited = true;
      emit({ event: "launcher-error", error: String(error) });
      resolve({ error: String(error) });
    });
    child.on("close", (code, signal) => {
      exited = true;
      const result = { event: "launcher-exit", pid: child.pid, code, signal, stderr };
      emit(result);
      resolve(result);
    });
  });
  async function wait(predicate, ms = 5000, start = 0) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const event = events.slice(start).find(predicate);
      if (event) return event;
      if (exited) throw Error("Owned launcher exited before readiness");
      await delay(20);
    }
    throw Error("Owned readiness timeout");
  }
  async function close() {
    if (!exited) child.stdin.end("stop\n");
    return exit;
  }
  async function findWindow(identity) {
    const start = events.length;
    child.stdin.write(`find ${identity.pid} ${identity.creation}\n`);
    const result = await wait((event) => event.event === "window", 2000, start);
    if (!result.valid) throw Error("Owned identity rejected");
    return result;
  }
  return {
    child,
    events,
    exit,
    wait,
    close,
    findWindow,
    get exited() {
      return exited;
    },
  };
}
