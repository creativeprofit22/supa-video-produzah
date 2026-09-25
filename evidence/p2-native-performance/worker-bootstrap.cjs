// Evaluated with node -e by the owned launcher: no project imports before the first marker.
const process = globalThis.process;
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const { pathToFileURL } = process.getBuiltinModule("node:url");
const [script, mode, directory] = process.argv.slice(1);
if (
  mode !== "--worker" ||
  !path.isAbsolute(directory) ||
  !path.basename(directory).startsWith("browser-watchdog-")
)
  throw new Error("Invalid bootstrap arguments");
const log = path.join(directory, "bootstrap.jsonl");
const mark = (event, operation, detail = {}) =>
  fs.appendFileSync(
    log,
    `${JSON.stringify({ utc: new Date().toISOString(), event, operation, ...detail })}\n`,
  );
mark("after", "bootstrap.enter", { pid: process.pid, argv: process.argv, cwd: process.cwd() });
try {
  mark("before", "bootstrap.read-worker");
  const bytes = fs.readFileSync(script);
  mark("after", "bootstrap.read-worker", { bytes: bytes.length });
  // Observe the real loader without replacing resolution, sources, or errors.
  let loaderEvents = 0;
  const observe = (event, operation, detail) => {
    if (loaderEvents++ < 2000) mark(event, operation, detail);
  };
  const hooks = process.getBuiltinModule("node:module").registerHooks({
    resolve(specifier, context, nextResolve) {
      observe("before", "loader.resolve", { specifier });
      const result = nextResolve(specifier, context);
      observe("after", "loader.resolve", { specifier, url: result.url });
      return result;
    },
    load(url, context, nextLoad) {
      observe("before", "loader.load", { url });
      const result = nextLoad(url, context);
      observe("after", "loader.load", { url });
      return result;
    },
  });
  globalThis.__p2BootstrapMark = mark;
  mark("before", "bootstrap.import-worker");
  import(pathToFileURL(script).href).then(
    () => {
      hooks.deregister();
      mark("after", "bootstrap.import-worker");
    },
    (error) => {
      hooks.deregister();
      mark("error", "bootstrap.import-worker", { error: String(error), stack: error.stack });
      process.exitCode = 1;
    },
  );
} catch (error) {
  mark("error", "bootstrap", { error: String(error), stack: error.stack });
  process.exitCode = 1;
}
