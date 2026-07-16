import type { AuthContext } from "@askrjs/auth";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../src/application";
import { createCsrfToken, csrf, rateLimit } from "../src/middleware/index";

const user: AuthContext = {
  authenticated: true,
  principal: { id: "user-1" },
  session: { id: "session-1", subject: "user-1" },
  tenant: null,
};

describe("request protection", () => {
  it("should accept a session-bound HMAC token from a native form", async () => {
    const secret = "test-secret";
    const token = await createCsrfToken(secret, "session-1");
    const app = createServerApp({
      auth: { resolve: async () => user },
      middleware: [csrf({ secret })],
      routes: [{ method: "POST", path: "/action", handler: (context) => context.noContent() }],
    });
    const response = await app.fetch(new Request("http://example.test/action", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token }),
    }));
    expect(response.status).toBe(204);
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
    const response = await app.fetch(new Request("http://example.test/action", {
      method: "POST",
      headers: { "x-askr-csrf-token": token },
    }));
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("should return standard limit headers and avoid mutating immutable responses", async () => {
    const now = 1_000;
    const app = createServerApp({
      middleware: [rateLimit({
        limit: 2,
        windowMs: 10_000,
        now: () => now,
        store: { consume: async () => ({ allowed: true, remaining: 1, reset: 6_000 }) },
      })],
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
      middleware: [rateLimit({
        limit: 1,
        windowMs: 10_000,
        now: () => 1_000,
        store: { consume: async () => ({ allowed: false, remaining: 0, reset: 3_100 }) },
      })],
      routes: [{ path: "/", handler: (context) => context.ok() }],
    });
    const response = await app.fetch(new Request("http://example.test/"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
  });
});
