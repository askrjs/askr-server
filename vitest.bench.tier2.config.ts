import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["benches/tier2/**/*.bench.ts"],
    benchmark: { include: ["benches/tier2/**/*.bench.ts"] },
  },
});
