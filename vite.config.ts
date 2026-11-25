import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
  },
  pack: {
    entry: {
      index: "src/index.ts",
      router: "src/router/index.ts",
      http: "src/http/index.ts",
      middleware: "src/middleware/index.ts",
      askr: "src/askr/index.ts",
      openapi: "src/openapi/index.ts",
      mcp: "src/mcp/index.ts",
      auth: "src/auth/index.ts",
      testing: "src/testing/public.ts",
    },
    format: ["esm"],
    outDir: "dist",
    platform: "neutral",
    dts: true,
    sourcemap: "hidden",
    unbundle: true,
    deps: {
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true,
      neverBundle: [/^@askrjs\/(?:askr|auth|schema)(?:\/.*)?$/],
    },
  },
});
