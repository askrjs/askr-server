import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      router: "src/router/index.ts",
      http: "src/http/index.ts",
      middleware: "src/middleware/index.ts",
      askr: "src/askr/index.ts",
      openapi: "src/openapi/index.ts",
      mcp: "src/mcp/index.ts",
      auth: "src/auth.ts",
    },
    format: ["esm"],
    outDir: "dist",
    platform: "neutral",
    dts: true,
    sourcemap: "hidden",
    unbundle: true,
    deps: { neverBundle: [/^@askrjs\/(?:askr|auth|schema)(?:\/.*)?$/] },
  },
});
