import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import path from "node:path";

const desktop = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const { default: react } = await import(
  pathToFileURL(require.resolve("@vitejs/plugin-react")).href
);
const targetNames = new Map([
  [path.join(desktop, "src/video/VideoWorkspace.tsx").replaceAll("\\", "/"), "VideoWorkspace"],
  [
    path.join(desktop, "src/video/MultitrackTimeline.tsx").replaceAll("\\", "/"),
    "MultitrackTimeline",
  ],
]);
// Separate config only; ordinary production config and source files remain unchanged.
export default ({ mode }) => ({
  root: desktop,
  clearScreen: false,
  resolve: {
    alias: [{ find: /^react-dom\/client$/, replacement: require.resolve("react-dom/profiling") }],
  },
  build: {
    outDir: fileURLToPath(
      new URL(
        mode === "profile-validation" ? "./runs/profile-validation/" : "./runs/frontend-profile/",
        import.meta.url,
      ),
    ),
    emptyOutDir: false,
    ...(mode === "profile-validation"
      ? { rollupOptions: { input: path.join(desktop, "browser-tests/video-workspace.html") } }
      : {}),
  },
  plugins: [
    {
      name: "p2-opt-in-profiler",
      enforce: "pre",
      transform(code, id) {
        const name = targetNames.get(id.replaceAll("\\", "/").split("?")[0]);
        if (!name) return null;
        const signature = `export function ${name}(`;
        if (code.split(signature).length !== 2)
          throw new Error(`Refusing unexpected ${name} source shape`);
        return {
          code:
            `import { Profiler as P2Profiler } from "react";\n` +
            code.replace(signature, `function P2${name}(`) +
            `
export function ${name}(props: Parameters<typeof P2${name}>[0]) {
  return <P2Profiler id="${name}" onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    const host = globalThis as typeof globalThis & { __p2Commits?: { samples: unknown[]; omitted: number } };
    const buffer = host.__p2Commits ??= { samples: [], omitted: 0 };
    if (buffer.samples.length < 20000) buffer.samples.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
    else buffer.omitted++;
  }}><P2${name} {...props} /></P2Profiler>;
}
`,
          map: null,
        };
      },
    },
    react(),
  ],
});
