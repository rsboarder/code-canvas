import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "fixtures/**/*.test.ts",
      "scripts/**/*.test.ts",
      "tests/lint/**/*.test.ts",
      "tests/build/**/*.test.ts",
      "perf/**/*.test.ts",
    ],
    passWithNoTests: false,
  },
});
