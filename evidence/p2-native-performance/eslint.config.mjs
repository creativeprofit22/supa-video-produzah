import projectConfig from "../../eslint.config.js";

export default [
  ...projectConfig,
  // Generated bundles/captures are not authored source; retain all project rules.
  { ignores: ["evidence/p2-native-performance/runs/**"] },
  {
    files: ["evidence/p2-native-performance/*.jsx"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
];
