import type { AuthContext } from "@askrjs/auth";
import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/application";
import { PayloadTooLargeError, readRequestBytes } from "../src/body-limit";
import type { ApiRoute, Middleware } from "../src/contracts";
import { anonymousAuthContext, createServerContext } from "../src/context";
import { dispatchRequest } from "../src/dispatch";
import { createEventStream } from "../src/http";
import { createCsrfToken, createMemoryRateLimitStore, csrf } from "../src/middleware";

const route = (handler: ApiRoute["handler"]): ApiRoute => ({
  path: "/work",
  method: "GET",
  handler,
});

describe("server concurrency hardening", () => {
  it("should isolate concurrent memory-rate-limit keys while retaining the current key", async () => {
    let now = 0;
    const store = createMemoryRateLimitStore({ maxEntries: 8, now: () => now });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => store.consume(`expired-${index}`, 1, 10)),
    );
    now = 20;

    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) => store.consume(`current-${index}`, 1, 100)),
    );

    expect(results.every((result) => result.allowed)).toBe(true);
    expect((await store.consume("current-23", 1, 100)).allowed).toBe(false);
  });

  it("should isolate valid and invalid concurrent CSRF sessions", async () => {
    const secret = "concurrent-secret";
    const validToken = await createCsrfToken(secret, "session-1");
    const auth = (request: Request): AuthContext => {
      const session = request.headers.get("x-session");
      return session
        ? {
            authenticated: true,
            principal: { id: "user-1" },
            session: { id: session, subject: "user-1" },
            tenant: null,
          }
        : anonymousAuthContext();
    };
    const app = createServerApp({
      auth: { resolve: async (request) => auth(request) },
      middleware: [csrf({ secret })],
      routes: [{ method: "POST", path: "/action", handler: (context) => context.noContent() }],
    });
    const request = (session: string | null, token: string | null) => {
      const headers = new Headers();
      if (session) headers.set("x-session", session);
      if (token) headers.set("x-askr-csrf-token", token);
      return app.fetch(new Request("https://example.test/action", { method: "POST", headers }));
    };

    const responses = await Promise.all([
      request("session-1", validToken),
      request("session-2", validToken),
      request(null, validToken),
      request("session-1", null),
    ]);
    expect(responses.map((response) => response.status)).toEqual([204, 403, 403, 403]);
  });

  it("should isolate overlapping dispatch when one middleware chain throws", async () => {
    let releaseFailure!: () => void;
    const failureReleased = new Promise<void>((resolve) => (releaseFailure = resolve));
    const middleware: Middleware = async (context, next) => {
      if (new URL(context.request.url).searchParams.has("fail")) {
        await failureReleased;
        throw new Error("failed request");
      }
      return next();
    };
    const dispatch = (url: string) =>
      dispatchRequest(
        [middleware],
        createServerContext(new Request(url), anonymousAuthContext(), {}),
        { match: { route: route(() => new Response("ok")), params: {} }, allowed: [] },
        { errorResponse: () => new Response("failed", { status: 500 }) },
      );

    const failing = dispatch("https://example.test/work?fail=1");
    const succeeding = dispatch("https://example.test/work");
    expect(await (await succeeding).text()).toBe("ok");
    releaseFailure();
    expect((await failing).status).toBe(500);
  });

  it("should keep body-limit promises isolated across simultaneous requests", async () => {
    const [atLimit, overLimit] = await Promise.allSettled([
      readRequestBytes(new Request("https://example.test", { method: "POST", body: "1234" }), 4),
      readRequestBytes(new Request("https://example.test", { method: "POST", body: "12345" }), 4),
    ]);

    expect(atLimit).toMatchObject({ status: "fulfilled", value: new Uint8Array([49, 50, 51, 52]) });
    expect(overLimit).toMatchObject({
      status: "rejected",
      reason: expect.any(PayloadTooLargeError),
    });
  });

  it("should serve an unrelated request while an event stream remains unread", async () => {
    const stream = createEventStream();
    const app = createServerApp({
      routes: [
        { path: "/stream", handler: () => stream.response },
        { path: "/fast", handler: () => new Response("fast") },
      ],
    });

    const streaming = await app.fetch(new Request("https://example.test/stream"));
    const fast = await app.fetch(new Request("https://example.test/fast"));
    expect(await fast.text()).toBe("fast");
    expect(streaming.body).not.toBeNull();
    await stream.close();
  });
});
