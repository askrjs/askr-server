import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      router: "src/router/index.ts",
      http: "src/http/index.ts",
      middleware: "src/middleware/index.ts",
      askr: "src/askr/index.ts",
    },
    format: ["esm"],
    outDir: "dist",
    platform: "neutral",
    dts: true,
    sourcemap: true,
    unbundle: true,
    deps: { neverBundle: [/^@askrjs\/(?:askr|auth)(?:\/.*)?$/] },
  },
});
