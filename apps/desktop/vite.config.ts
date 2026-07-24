import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
  .TAURI_DEV_HOST;

export default defineConfig({
  plugins: react(),
  clearScreen: false,
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
