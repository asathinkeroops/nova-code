/* eslint-env node */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
  ],
  ignorePatterns: [
    "node_modules",
    "dist",
    "coverage",
    "*.html",
    "examples",
    "eval",
    "e2e",
    "docs",
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/no-explicit-any": "warn",
  },
  overrides: [
    {
      // `@nova/core` is the agent kernel: message/hook/port contracts plus the
      // loop. It is a LEAF — no workspace package, no model SDK. Every
      // mechanism reaches it through a port (see packages/core/src/ports.ts),
      // so an import here is always the wrong fix. Enforced rather than
      // documented, because the boundary erodes one convenient import at a time.
      files: ["packages/core/src/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@nova/*"],
                message:
                  "@nova/core is a leaf: declare a port in ports.ts and let the owning package implement it.",
              },
              {
                group: ["@anthropic-ai/*"],
                message:
                  "@nova/core is model-agnostic: the SDK adapter lives in @nova/model.",
              },
            ],
          },
        ],
      },
    },
  ],
};
