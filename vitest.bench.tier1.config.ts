import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["benches/tier1/**/*.bench.ts"],
    benchmark: { include: ["benches/tier1/**/*.bench.ts"] },
  },
});
