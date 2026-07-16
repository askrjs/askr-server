import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createMatcher } from "../src/router/matcher";

const root = resolve(import.meta.dirname, "..");

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("server architecture", () => {
  it("should import server core given Askr is not installed", () => {
    const core = files(resolve(root, "src")).filter(
      (file) => !file.includes(`${join("src", "askr")}`),
    );
    for (const file of core) {
      expect(readFileSync(file, "utf8"), relative(root, file)).not.toMatch(
        /@askrjs\/askr(?:\/|["'])/,
      );
    }
  });

  it("should reject implementation inside a package index barrel", () => {
    for (const file of [
      "src/index.ts",
      "src/http/index.ts",
      "src/router/index.ts",
      "src/middleware/index.ts",
      "src/openapi/index.ts",
    ]) {
      const source = readFileSync(resolve(root, file), "utf8");
      const lines = source.split("\n").filter(Boolean);
      expect(
        source
          .replace(/export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+["'][^"']+["'];?/g, "")
          .split("\n")
          .filter((line) => line.trim())
          .every((line) => line.startsWith("export ")),
        file,
      ).toBe(true);
      expect(lines.length, file).toBeLessThanOrEqual(80);
    }
  });

  it("should keep OpenAPI isolated from the root and binding implementation", () => {
    const rootEntry = readFileSync(resolve(root, "src/index.ts"), "utf8");
    expect(rootEntry).not.toMatch(/openapi/i);
    for (const file of files(resolve(root, "src/openapi"))) {
      expect(readFileSync(file, "utf8"), relative(root, file)).not.toMatch(
        /(?:\.\.\/binding|from ["']@askrjs\/server["'])/,
      );
    }
  });

  it("should reject imports from an outer adapter into an inner module", () => {
    for (const file of files(resolve(root, "src/http"))) {
      expect(readFileSync(file, "utf8"), relative(root, file)).not.toMatch(
        /from ["']\.\.\/(?:application|dispatch|router)/,
      );
    }
  });

  it("should keep new production modules within 300 lines", () => {
    for (const file of files(resolve(root, "src"))) {
      expect(
        readFileSync(file, "utf8").split("\n").length,
        relative(root, file),
      ).toBeLessThanOrEqual(300);
    }
  });

  it("should compile the source route collection once and retain an application snapshot", () => {
    let iterations = 0;
    const source = new Proxy(
      [
        {
          path: "/items/{id}",
          method: "GET",
          handler: (ctx: import("../src/contracts").ServerContext) => ctx.ok(),
        },
      ],
      {
        get(target, property, receiver) {
          if (property === Symbol.iterator) iterations += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const matcher = createMatcher(source);
    expect(iterations).toBe(1);
    matcher.match("/items/one", "GET");
    matcher.match("/items/two", "GET");
    expect(iterations).toBe(1);
  });

  it("should keep URL parsing outside compiled path traversal", () => {
    const matcher = readFileSync(resolve(root, "src/router/matcher.ts"), "utf8");
    const application = readFileSync(resolve(root, "src/application.ts"), "utf8");
    expect(matcher).not.toMatch(/new URL\(/);
    expect(application).toContain("matcher.match(context.url.pathname, request.method)");
  });

  it("should keep public exports free of React-shaped vocabulary", () => {
    const publicEntries = [
      "src/index.ts",
      "src/http/index.ts",
      "src/router/index.ts",
      "src/middleware/index.ts",
      "src/openapi/index.ts",
      "src/askr/index.ts",
    ]
      .map((file) => readFileSync(resolve(root, file), "utf8"))
      .join("\n");
    expect(publicEntries).not.toMatch(/\b(?:defineContext|readContext)\b/);
    expect(publicEntries).not.toMatch(/export[^\n]*\buse[A-Z][A-Za-z]+\b/);
    expect(publicEntries).not.toMatch(/export[^\n]*\b[A-Z][A-Za-z]+Provider\b/);
  });

  it("should keep telemetry composition-owned without a runtime package import", () => {
    for (const file of files(resolve(root, "src"))) {
      expect(readFileSync(file, "utf8"), relative(root, file)).not.toMatch(
        /(?:from|import\()[ (]*["']@askrjs\/otel["']/,
      );
    }
  });
});
