import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["benches/tier4/**/*.bench.ts"],
    benchmark: { include: ["benches/tier4/**/*.bench.ts"] },
  },
});
