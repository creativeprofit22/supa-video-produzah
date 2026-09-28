import projectConfig from "../../eslint.config.js";

export default [
  ...projectConfig,
  // Generated bundles/captures are not authored source; retain all project rules.
  // Patterns here resolve relative to this directory, not the repository root.
  { ignores: ["runs/**"] },
  {
    files: ["*.jsx"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
];
