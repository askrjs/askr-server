import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("server architecture", () => {
  it("should import server core given Askr is not installed", () => {
    const core = files(resolve(root, "src"))
      .filter((file) => !file.includes(`${join("src", "askr")}`));
    for (const file of core) {
      expect(readFileSync(file, "utf8"), relative(root, file)).not.toMatch(/@askrjs\/askr(?:\/|["'])/);
    }
  });

  it("should reject implementation inside a package index barrel", () => {
    for (const file of ["src/index.ts", "src/http/index.ts", "src/router/index.ts", "src/middleware/index.ts"]) {
      const lines = readFileSync(resolve(root, file), "utf8").split("\n").filter(Boolean);
      expect(lines.every((line) => line.startsWith("export ")), file).toBe(true);
      expect(lines.length, file).toBeLessThanOrEqual(80);
    }
  });

  it("should reject imports from an outer adapter into an inner module", () => {
    for (const file of files(resolve(root, "src/http"))) {
      expect(readFileSync(file, "utf8"), relative(root, file)).not.toMatch(/from ["']\.\.\/(?:application|dispatch|router)/);
    }
  });

  it("should keep new production modules within 300 lines", () => {
    for (const file of files(resolve(root, "src"))) {
      expect(readFileSync(file, "utf8").split("\n").length, relative(root, file)).toBeLessThanOrEqual(300);
    }
  });
});
