import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const host = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
  .TAURI_DEV_HOST;

export default defineConfig({
  plugins: react(),
  clearScreen: false,
  test: {
    // Full-app jsdom/axe scans exceed 5s under parallel DOM load; keep their coverage and budget.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [
            ...configDefaults.exclude,
            "browser-tests/**",
            "src/video/accessibility.test.tsx",
          ],
          fileParallelism: true,
          testTimeout: 5_000,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "accessibility",
          include: ["src/video/accessibility.test.tsx"],
          testTimeout: 5_000,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    ...(host === undefined
      ? {}
      : {
          hmr: {
            protocol: "ws" as const,
            host,
            port: 1421,
          },
        }),
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
