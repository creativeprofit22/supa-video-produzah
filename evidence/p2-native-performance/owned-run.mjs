import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";

export async function launchOwned(
  receiptPath,
  executable,
  args,
  { leaseMs = 120000, env = {} } = {},
) {
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 4500000)
    throw new Error("Invalid owned lease");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8").replace(/^\uFEFF/, ""));
  const root = realpathSync(path.dirname(receiptPath));
  if (path.relative(root, realpathSync(receipt.executable)) !== "OwnedRun.exe")
    throw new Error("Launcher receipt escaped root");
  const sha = createHash("sha256").update(readFileSync(receipt.executable)).digest("hex");
  if (sha !== receipt.executableSha256) throw new Error("Launcher identity mismatch");
  const child = spawn(receipt.executable, [String(leaseMs), executable, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const events = [];
  let buffer = "",
    stderr = "",
    byteCount = 0,
    overflow = false,
    identityResolve,
    identityReject;
  const identityPromise = new Promise((resolve, reject) => {
    identityResolve = resolve;
    identityReject = reject;
  });
  child.stdin.on("error", () => {});
  const requestStop = () => {
    if (!child.stdin.destroyed) child.stdin.end("stop\n");
  };
  child.stdout.on("data", (bytes) => {
    byteCount += bytes.length;
    if (byteCount > 262144) {
      overflow = true;
      requestStop();
      return;
    }
    buffer += bytes.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const event = JSON.parse(line);
        if (events.length < 100) events.push(event);
        if (event.event === "identity") identityResolve(event);
      } catch {
        /* Application stdout is not a trusted launcher event. */
      }
    }
  });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-16384);
  });
  const fallback = setTimeout(() => child.kill(), leaseMs + 15000);
  const exit = new Promise((resolve) => {
    child.once("error", (error) => {
      identityReject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(fallback);
      identityReject(new Error("Launcher exited before identity"));
      resolve({ code, signal, overflow, stderr, events });
    });
  });
  const timer = setTimeout(() => {
    identityReject(new Error("Launcher identity timeout"));
    requestStop();
  }, 10000);
  let identity;
  try {
    identity = await identityPromise;
  } catch (error) {
    requestStop();
    await exit;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    identity,
    exit,
    launcherPid: child.pid,
    async close() {
      requestStop();
      const result = await exit;
      if (
        result.code !== 0 ||
        result.overflow ||
        !events.some((e) => e.event === "closed" && e.empty)
      )
        throw new Error(`Owned tree cleanup unconfirmed: ${JSON.stringify(result)}`);
      return result;
    },
  };
}
