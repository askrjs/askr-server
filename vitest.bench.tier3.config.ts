import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["benches/tier3/**/*.bench.ts"],
    benchmark: { include: ["benches/tier3/**/*.bench.ts"] },
  },
});
