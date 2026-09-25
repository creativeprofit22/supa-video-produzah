import profileConfig from "./vite.profile.config.mjs";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
export default ({ mode }) => {
  if (
    ![
      "browser-profile",
      "browser-uninstrumented",
      "native-profile",
      "native-uninstrumented",
    ].includes(mode)
  )
    throw new Error("Explicit evidence mode required");
  const config = profileConfig({ mode: "production" });
  const base = fileURLToPath(new URL("./", import.meta.url));
  const browser = mode.startsWith("browser-");
  if (browser) config.root = base;
  const outDir = process.env.P2_FRONTEND_OUTPUT || path.join(base, "runs", mode);
  const relative = path.relative(path.join(base, "runs"), path.resolve(outDir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Frontend output must be isolated");
  config.build = {
    ...config.build,
    outDir,
    ...(browser ? { rollupOptions: { input: path.join(base, "browser-fixture.html") } } : {}),
  };
  config.resolve.alias = [
    {
      find: /^react-dom\/client$/,
      replacement: require.resolve(
        mode.endsWith("uninstrumented") ? "react-dom/client" : "react-dom/profiling",
      ),
    },
    { find: /^react$/, replacement: require.resolve("react") },
    { find: /^react\/jsx-runtime$/, replacement: require.resolve("react/jsx-runtime") },
  ];
  if (mode.endsWith("uninstrumented"))
    config.plugins = config.plugins.filter((p) => p.name !== "p2-opt-in-profiler");
  config.plugins.unshift({
    name: "p2-real-seek-entry",
    enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/src/video/ProgramMonitor.tsx")) return null;
      const anchor = "  const seekRelative = useCallback(";
      if (code.split(anchor).length !== 2) throw new Error("Refusing unexpected seek entry source");
      const hook = `  useEffect(() => {\n    const host = globalThis as typeof globalThis & { __p2SeekTo?: (frame: number) => void };\n    host.__p2SeekTo = seekTo;\n    return () => { if (host.__p2SeekTo === seekTo) delete host.__p2SeekTo; };\n  }, [seekTo]);\n`;
      return { code: code.replace(anchor, hook + anchor), map: null };
    },
  });
  return config;
};
