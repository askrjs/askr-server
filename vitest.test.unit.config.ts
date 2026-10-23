import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 87,
        branches: 80,
        functions: 86,
        lines: 89,
        "src/application.ts": { statements: 96, branches: 96, functions: 90, lines: 96 },
        "src/body-limit.ts": { statements: 91, branches: 76, functions: 100, lines: 91 },
        "src/dispatch.ts": { statements: 92, branches: 89, functions: 95, lines: 94 },
        "src/response-body.ts": { statements: 100, functions: 100, lines: 100 },
      },
    },
  },
});
