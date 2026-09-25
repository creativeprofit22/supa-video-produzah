import { createServer } from "node:http";
import { createReadStream, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
export async function browserSession(
  frontend,
  nativeData,
  allowedCacheRoot,
  trace = (_name, operation) => operation(),
  { mediaLoadControl = null } = {},
) {
  if (![null, "idle-normal", "idle-held"].includes(mediaLoadControl))
    throw new Error("Invalid diagnostic media-load control");
  let heldMediaRequests = 0;
  const runs = realpathSync.native(fileURLToPath(new URL("./runs/", import.meta.url)));
  const allowed = [runs, realpathSync.native(allowedCacheRoot)];
  const entries = new Map(),
    hashes = [],
    urls = {};
  function add(route, file) {
    const real = realpathSync.native(file);
    if (
      !allowed.some((root) => {
        const rel = path.relative(root, real);
        return !rel.startsWith("..") && !path.isAbsolute(rel);
      })
    )
      throw new Error("Fixture file outside owned roots");
    const size = statSync(real).size;
    entries.set(route, { file: real, size });
    hashes.push({
      route,
      sha256: createHash("sha256").update(readFileSync(real)).digest("hex"),
      size,
    });
  }
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) visit(file);
      else add(`/${path.relative(frontend, file).replaceAll("\\", "/")}`, file);
    }
  };
  visit(frontend);
  const nativePaths = Object.values(nativeData.prepared).flatMap((p) => [
    p.proxyPath,
    p.thumbnailPath,
  ]);
  if (nativeData.finalOutput) nativePaths.push(nativeData.finalOutput.previewPath);
  for (const file of new Set(nativePaths)) {
    const route = `/media/${randomUUID()}${path.extname(file)}`;
    add(route, file);
    urls[file] = route;
  }
  let port;
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}` || !["GET", "HEAD"].includes(req.method)) {
      res.writeHead(403).end();
      return;
    }
    const entry = entries.get(req.url);
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    let start = 0,
      end = entry.size - 1,
      status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!match) {
        res.writeHead(416).end();
        return;
      }
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        end >= entry.size
      ) {
        res.writeHead(416).end();
        return;
      }
      status = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${entry.size}`);
    }
    // Diagnostic-only control: keep media elements mounted without delivering MP4 bytes.
    // Do not alter app code, sources, DOM, clip counts, or ordinary readiness checks.
    if (
      mediaLoadControl === "idle-held" &&
      req.url.startsWith("/media/") &&
      path.extname(entry.file) === ".mp4" &&
      req.method === "GET"
    ) {
      if (++heldMediaRequests > 2048) {
        res.writeHead(503).end();
        return;
      }
      res.setTimeout(30000, () => res.destroy());
      return;
    }
    const mime =
      {
        ".mp4": "video/mp4",
        ".json": "application/json",
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".jpg": "image/jpeg",
        ".png": "image/png",
      }[path.extname(entry.file)] || "application/octet-stream";
    res.writeHead(status, {
      "Content-Type": mime,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(entry.file, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });
  await trace(
    "server.listen",
    () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      }),
  );
  port = server.address().port;
  for (const file of Object.keys(urls)) urls[file] = `http://127.0.0.1:${port}${urls[file]}`;
  let browser;
  const closeServer = () =>
    new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  try {
    browser = await trace("chromium.launch", () => chromium.launch({ headless: true }));
    const page = await trace("browser.newPage", () =>
      browser.newPage({ viewport: { width: 1280, height: 720 } }),
    );
    page.setDefaultTimeout(15000);
    await trace("page.addInitScript", () =>
      page.addInitScript(
        (data) => {
          globalThis.__p2Fixture = data;
        },
        {
          projection: nativeData.projection,
          prepared: nativeData.prepared,
          finalOutput: nativeData.finalOutput,
          urls,
        },
      ),
    );
    await trace("page.goto", () => page.goto(`http://127.0.0.1:${port}/browser-fixture.html`));
    await trace("fixture.open.click", () =>
      page.getByRole("button", { name: "Open pinned P2 fixture" }).click(),
    );
    if (mediaLoadControl !== null) {
      await trace("fixture.mounted.diagnostic-only", () =>
        page.waitForFunction(
          () =>
            globalThis.__p2SeekTo &&
            globalThis.document.querySelectorAll(".monitor-stage video").length > 0,
          undefined,
          { timeout: 15000 },
        ),
      );
    } else {
      await trace("fixture.ready", () =>
        page.waitForFunction(
          () =>
            globalThis.__p2SeekTo &&
            !globalThis.document.querySelector(".transport-play")?.disabled,
          undefined,
          { timeout: 30000 },
        ),
      );
    }
    return {
      page,
      hashes,
      version: browser.version(),
      get mediaLoadControlEvidence() {
        return { mode: mediaLoadControl, heldMediaRequests };
      },
      async close() {
        try {
          await trace("browser.close", () => browser.close());
        } finally {
          await trace("server.close", closeServer);
        }
      },
    };
  } catch (error) {
    try {
      await trace("browser.close.onError", () => browser?.close());
    } finally {
      await trace("server.close.onError", closeServer);
    }
    throw error;
  }
}
