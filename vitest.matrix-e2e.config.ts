import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const baseExcludes = (baseTest.exclude ?? []).filter((pattern) => pattern !== "**/*.e2e.test.ts");
const includeMatrixE2E = process.env.MATRIX_E2E === "true";

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ["extensions/matrix/tests/e2e/**/*.e2e.test.ts"],
    exclude: [
      ...baseExcludes,
      ...(includeMatrixE2E ? [] : ["extensions/matrix/tests/e2e/**/*.e2e.test.ts"]),
    ],
    setupFiles: [
      ...((baseTest as { setupFiles?: string[] }).setupFiles ?? []),
      "extensions/matrix/tests/e2e/setup/vitest.matrix-e2e.setup.ts",
    ],
  },
});
