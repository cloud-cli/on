import typescriptEslintParser from "@typescript-eslint/parser";
import eslintTypescriptPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    rules: {
      curly: ["error", "all"],
    },
  },
  {
    files: ["**/*.ts"],
    plugins: {
      "@typescript-eslint": eslintTypescriptPlugin,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      parser: typescriptEslintParser,
      parserOptions: {
        ecmaFeatures: {
          modules: true,
        },
      },
      sourceType: "module",
      ecmaVersion: "latest",
    },
  },
];
