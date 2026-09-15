import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/src-tauri/gen/**",
      ".gg/**",
      // Immutable, deliberately disabled capture snapshots, not runnable tools.
      // Keep their unconditional safety stops and recorded source bytes intact.
      "evidence/2026-09-14-p2-speed/owned-source/bounded-calibration.mjs",
      "evidence/2026-09-14-p2-speed/guardian-source/bounded-calibration.mjs",
      "evidence/2026-09-14-p2-speed/protocol-partial/bounded-calibration.mjs",
      "evidence/2026-09-14-p2-speed/protocol-review/bounded-calibration.mjs",
      // Historical ownership prototype paired with the disabled capture above.
      // Its cleanup implementation is superseded, not a maintained launcher.
      "evidence/2026-09-14-p2-speed/owned-source/owned-browser.mjs",
      // Local generated capture output is also excluded from Git.
      "evidence/2026-09-14-p2-speed/output-capture/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["evidence/2026-09-14-p2-speed/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        // Playwright callbacks execute in the browser, not the Node host.
        document: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        document: "readonly",
        window: "readonly",
        HTMLElement: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
