import { describe, expect, it } from "vitest";
import { createServerApp, text } from "../src/index";
import { cors } from "../src/middleware/index";

function appWith(middleware = cors()) {
  return createServerApp({
    middleware: [middleware],
    routes: [
      { path: "/", handler: () => text("ok", { headers: { vary: "Accept-Encoding" } }) },
      { path: "/", method: "OPTIONS", handler: () => text("explicit") },
    ],
  });
}

describe("CORS middleware", () => {
  it("should skip CORS entirely without Origin", async () => {
    const response = await appWith().fetch(new Request("http://example.test/"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("should decorate actual responses without preflight-only headers", async () => {
    const response = await appWith(cors({
      origin: "https://app.test",
      credentials: true,
      exposedHeaders: ["x-request-id"],
      maxAgeSeconds: 60,
    })).fetch(new Request("http://example.test/", { headers: { origin: "https://app.test" } }));
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-expose-headers")).toBe("x-request-id");
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
    expect(response.headers.get("access-control-max-age")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
  });

  it("should let explicit ordinary OPTIONS handlers run", async () => {
    const response = await appWith().fetch(new Request("http://example.test/", {
      method: "OPTIONS",
      headers: { origin: "https://app.test" },
    }));
    expect(await response.text()).toBe("explicit");
  });

  it("should handle valid preflight and vary on request inputs", async () => {
    const response = await appWith(cors({ origin: "https://app.test", methods: ["GET", "PATCH"], allowedHeaders: ["content-type", "x-token"] }))
      .fetch(new Request("http://example.test/", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.test",
          "access-control-request-method": "patch",
          "access-control-request-headers": "X-Token, Content-Type",
        },
      }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, PATCH");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type, x-token");
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
    expect(response.headers.get("vary")).toBe("Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  });

  it.each([
    ["origin", cors({ origin: "https://allowed.test" }), { origin: "https://denied.test" }],
    ["method", cors({ methods: ["GET"] }), { origin: "https://app.test", "access-control-request-method": "POST" }],
    ["header", cors({ allowedHeaders: ["content-type"] }), { origin: "https://app.test", "access-control-request-method": "GET", "access-control-request-headers": "x-token" }],
  ])("should reject a disallowed %s", async (_name, middleware, headers) => {
    const response = await appWith(middleware).fetch(new Request("http://example.test/", {
      method: _name === "origin" ? "GET" : "OPTIONS",
      headers,
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("should reject static wildcard credentials during construction", () => {
    expect(() => cors({ credentials: true })).toThrow(/wildcard origin/);
    expect(() => cors({ origin: "*", credentials: true })).toThrow(/wildcard origin/);
  });

  it("should route dynamic wildcard credential failures through onError", async () => {
    const app = createServerApp({
      middleware: [cors({ origin: () => "*", credentials: true })],
      routes: [{ path: "/", handler: () => text("no") }],
      onError: (error) => text((error as Error).message, { status: 500 }),
    });
    const response = await app.fetch(new Request("http://example.test/", { headers: { origin: "https://app.test" } }));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("dynamic CORS origin");
  });

  it("should support dynamic origin rejection and case-insensitive Vary deduplication", async () => {
    const app = createServerApp({
      middleware: [cors({ origin: (origin) => origin.endsWith(".test") ? origin : null })],
      routes: [{ path: "/", handler: () => text("ok", { headers: { vary: "origin, ACCEPT-ENCODING" } }) }],
    });
    const allowed = await app.fetch(new Request("http://example.test/", { headers: { origin: "https://app.test" } }));
    expect(allowed.headers.get("vary")).toBe("origin, ACCEPT-ENCODING");
    expect((await app.fetch(new Request("http://example.test/", { headers: { origin: "https://app.invalid" } }))).status).toBe(403);
  });
});
