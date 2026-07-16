import { createRouteRegistry, route } from "@askrjs/askr/router";
import { describe, expect, it } from "vitest";
import { createAskrApp } from "../src/askr/index";
import { safeRedirect } from "../src/auth";

describe("Askr application composer", () => {
  it("should compose APIs pages documents dependencies and idempotent close", async () => {
    const dependencies = { value: "dependency" };
    const registry = createRouteRegistry(() => route("/", () => "page"));
    let closes = 0;
    const app = createAskrApp({
      name: "Test",
      version: "1.2.3",
      dependencies,
      pages: registry,
      api: {
        define(api) {
          api
            .get("/value", (_context, deps) => new Response(deps.value))
            .operationId("getValue")
            .summary("Get the value")
            .ok();
        },
      },
      close: async (deps) => {
        expect(deps).toBe(dependencies);
        closes += 1;
      },
    });

    expect(Object.isFrozen(app)).toBe(true);
    expect(await (await app.fetch(new Request("http://example.test/api/value"))).text()).toBe(
      "dependency",
    );
    expect((await app.fetch(new Request("http://example.test/api/missing"))).status).toBe(404);
    expect(await (await app.fetch(new Request("http://example.test/"))).text()).toBe("page");
    expect(app.toOpenApiDocument().info).toMatchObject({ title: "Test", version: "1.2.3" });
    await Promise.all([app.close(), app.close(), app.close()]);
    expect(closes).toBe(1);
  });
});

describe("safeRedirect", () => {
  it("should preserve safe same-origin paths", () => {
    const redirect = safeRedirect("/fallback");
    expect(redirect("/settings?tab=profile")).toBe("/settings?tab=profile");
  });

  it.each([
    "https://evil.test/",
    "//evil.test/",
    "/\\evil.test/",
    "/%5cevil.test/",
    "/%2f%2fevil.test/",
    "/../admin",
    "/%2e%2e/admin",
    "/bad%encoding",
    "/settings#secret",
  ])("should reject hostile redirect %s", (value) => {
    expect(safeRedirect("/fallback")(value)).toBe("/fallback");
  });
});
