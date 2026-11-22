import { defineConfig } from "vitest/config";

// Extension tests live in test/extensions/<name>/{unit,integration,golden}/ and are picked up by
// the same projects, so deleting an extension folder (src + test) keeps the suite consistent.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts", "test/extensions/*/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts", "test/extensions/*/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 20_000,
          // Postgres-backed tests may pull/start a container in beforeAll.
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          name: "golden",
          include: ["test/golden/**/*.test.ts", "test/extensions/*/golden/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
    ],
  },
});
