// Diagnostic only: the raw observer still adds a Web Audio graph.
// Neither variant qualifies common-clock physical output timing.
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import baseline from "../../apps/desktop/playwright.config.ts";

const mode = process.env.SUPA_RAW_OBSERVER_MODE;
if (mode !== "default" && mode !== "unmuted")
  throw Error("Explicit default or unmuted mode required");
const desktop = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
export default {
  ...baseline,
  testDir: path.join(desktop, "browser-tests"),
  testMatch: "RawMediaParity.spec.ts",
  outputDir: path.join(desktop, "../../test-results/raw-observer-" + mode),
  use: {
    ...baseline.use,
    ...(mode === "unmuted" ? { launchOptions: { ignoreDefaultArgs: ["--mute-audio"] } } : {}),
  },
  webServer: { ...baseline.webServer, cwd: desktop },
};
