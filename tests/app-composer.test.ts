import { createRouteRegistry, route } from "@askrjs/askr/router";
import { describe, expect, it } from "vitest";
import { createAskrApp } from "../src/askr/index";
import { safeRedirect } from "../src/auth";
import { requireUser } from "@askrjs/auth";

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

  it("should apply application access denial mapping only to API routes", async () => {
    const registry = createRouteRegistry(() => route("/", () => "page", { auth: requireUser() }));
    let mappedDenials = 0;
    const app = createAskrApp({
      name: "Test",
      version: "1",
      dependencies: {},
      pages: registry,
      auth: {
        resolver: {
          resolve: async () => ({
            authenticated: false,
            principal: null,
            session: null,
            tenant: null,
          }),
        },
        pages: { loginPath: "/login" },
      },
      api: {
        define(api) {
          api
            .get("/private", (context) => context.ok())
            .access(requireUser(), [])
            .ok();
        },
      },
      onAccessDenied: (decision, context) => (
        (mappedDenials += 1),
        context.problem(401, "Sign in", {
          extensions: { code: decision.reason, violations: [] },
        })
      ),
    });
    const response = await app.fetch(new Request("http://example.test/api/private"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "unauthenticated",
      violations: [],
    });
    const page = await app.fetch(new Request("http://example.test/"));
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login?next=%2F");
    expect(mappedDenials).toBe(1);
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
