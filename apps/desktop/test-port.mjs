import process from "node:process";

// Shared by configuration and evidence drivers; no Playwright or fixture side effects.
export function parseTestPort(value) {
  if (value === undefined) return 4173;
  if (typeof value !== "string" || value.length === 0 || /[^0-9]/.test(value))
    throw new Error("SUPA_VIDEO_TEST_PORT must be a decimal integer from 1024 to 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("SUPA_VIDEO_TEST_PORT must be a decimal integer from 1024 to 65535");
  return port;
}

export const testPort = parseTestPort(process.env.SUPA_VIDEO_TEST_PORT);
export const testBaseUrl = `http://127.0.0.1:${testPort}`;
export const nativeTestRoot = `http://localhost:${testPort}/`;
