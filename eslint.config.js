import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/target/**", "**/src-tauri/gen/**", ".gg/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
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
