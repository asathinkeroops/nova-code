import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
    environment: "node",
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/index.ts"],
    },
  },
});
