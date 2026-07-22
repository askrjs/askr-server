import type { AuthContext } from "@askrjs/auth";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../src/application";
import { createApi, schema } from "../src/openapi/index";
import {
  createCsrfToken,
  createMemoryRateLimitStore,
  csrf,
  rateLimit,
} from "../src/middleware/index";

const user: AuthContext = {
  authenticated: true,
  principal: { id: "user-1" },
  session: { id: "session-1", subject: "user-1" },
  tenant: null,
};

describe("request protection", () => {
  const csrfForms = async (token: string) => {
    const urlEncoded = new URLSearchParams({ _csrf: token, name: "Ada" });
    const multipart = new FormData();
    multipart.set("_csrf", token);
    multipart.set("name", "Ada");
    return [urlEncoded, multipart] as const;
  };

  it("should rate limit with a private memory store when no store is supplied", async () => {
    const app = createServerApp({
      middleware: [rateLimit({ limit: 1, windowMs: 1_000 })],
      routes: [{ path: "/", handler: () => new Response("ok") }],
    });
    expect((await app.fetch(new Request("http://example.test/"))).status).toBe(200);
    const rejected = await app.fetch(new Request("http://example.test/"));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("RateLimit-Remaining")).toBe("0");
  });

  it("should reset memory rate limit windows with an injected clock", async () => {
    let now = 10;
    const store = createMemoryRateLimitStore({ now: () => now });
    expect((await store.consume("key", 1, 100)).allowed).toBe(true);
    expect((await store.consume("key", 1, 100)).allowed).toBe(false);
    now = 110;
    expect((await store.consume("key", 1, 100)).allowed).toBe(true);
  });

  it("should accept a session-bound HMAC token from a native form", async () => {
    const secret = "test-secret";
    const token = await createCsrfToken(secret, "session-1");
    const app = createServerApp({
      auth: { resolve: async () => user },
      middleware: [csrf({ secret })],
      routes: [{ method: "POST", path: "/action", handler: (context) => context.noContent() }],
    });
    const response = await app.fetch(
      new Request("http://example.test/action", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: token }),
      }),
    );
    expect(response.status).toBe(204);
  });

  it("should let bind reuse URL-encoded and multipart bytes buffered by csrf", async () => {
    const secret = "test-secret";
    const token = await createCsrfToken(secret, "session-1");
    const app = createServerApp({
      auth: { resolve: async () => user },
      middleware: [csrf({ secret })],
      routes: [
        {
          method: "POST",
          path: "/action",
          handler: async (context) => context.json(await context.bind()),
        },
      ],
    });
    for (const body of await csrfForms(token)) {
      const response = await app.fetch(
        new Request("http://example.test/action", { method: "POST", body }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ _csrf: token, name: "Ada" });
    }
  });

  it("should let declared OpenAPI input reuse form bytes buffered by csrf", async () => {
    const secret = "test-secret";
    const token = await createCsrfToken(secret, "session-1");
    const api = createApi({ info: { title: "CSRF composition", version: "1" } });
    api
      .post("/action", {
        input: {
          body: {
            schema: schema.object({ _csrf: schema.string(), name: schema.string() }),
            mediaTypes: ["application/x-www-form-urlencoded", "multipart/form-data"],
          },
        },
        handler: (context, input) => context.ok(input.body),
      })
      .operationId("csrfAction")
      .summary("CSRF action")
      .ok(schema.object({ _csrf: schema.string(), name: schema.string() }));
    const app = createServerApp({
      auth: { resolve: async () => user },
      middleware: [csrf({ secret })],
      router: api.createRouter(),
    });
    for (const body of await csrfForms(token)) {
      const response = await app.fetch(
        new Request("http://example.test/action", { method: "POST", body }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ _csrf: token, name: "Ada" });
    }
  });

  it("should reject a token signed for another session", async () => {
    const secret = "test-secret";
    const token = await createCsrfToken(secret, "session-2");
    const handler = vi.fn((context) => context.noContent());
    const app = createServerApp({
      auth: { resolve: async () => user },
      middleware: [csrf({ secret })],
      routes: [{ method: "POST", path: "/action", handler }],
    });
    const response = await app.fetch(
      new Request("http://example.test/action", {
        method: "POST",
        headers: { "x-askr-csrf-token": token },
      }),
    );
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("should return standard limit headers and avoid mutating immutable responses", async () => {
    const now = 1_000;
    const app = createServerApp({
      middleware: [
        rateLimit({
          limit: 2,
          windowMs: 10_000,
          now: () => now,
          store: { consume: async () => ({ allowed: true, remaining: 1, reset: 6_000 }) },
        }),
      ],
      routes: [{ path: "/", handler: () => Response.redirect("http://example.test/next") }],
    });
    const response = await app.fetch(new Request("http://example.test/"));
    expect(response.status).toBe(302);
    expect(response.headers.get("ratelimit-limit")).toBe("2");
    expect(response.headers.get("ratelimit-remaining")).toBe("1");
    expect(response.headers.get("ratelimit-reset")).toBe("5");
  });

  it("should return 429 with Retry-After given a rejected store decision", async () => {
    const app = createServerApp({
      middleware: [
        rateLimit({
          limit: 1,
          windowMs: 10_000,
          now: () => 1_000,
          store: { consume: async () => ({ allowed: false, remaining: 0, reset: 3_100 }) },
        }),
      ],
      routes: [{ path: "/", handler: (context) => context.ok() }],
    });
    const response = await app.fetch(new Request("http://example.test/"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
  });
});
