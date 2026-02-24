import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  // ...tseslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    ignores: ["eslint.config.js", "jest.config.js", "**/dist/", "**/node_modules/"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-console": ["warn"],
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/no-deprecated": "error",
      "no-duplicate-imports": "error",
    },
  },
  {
    files: ["src/cli.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
