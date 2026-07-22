import { describe, expect, it } from "vitest";
import {
  createRouter,
  createServerApp,
  defineRoutes,
  json,
  setCookie,
  text,
  type Middleware,
} from "../src/index";
import { requireAnonymous, requireRole, requireUser, type AuthContext } from "@askrjs/auth";
import { requestId, securityHeaders } from "../src/middleware/index";

const authenticated: AuthContext = {
  authenticated: true,
  principal: { id: "user-1", roles: ["admin"] },
  session: { id: "session-1", subject: "user-1" },
  tenant: null,
};

describe("HTTP responses", () => {
  it.each([
    { headers: { "x-value": "object" } },
    { headers: [["x-value", "tuple"]] as [string, string][] },
    { headers: new Headers({ "x-value": "headers" }) },
  ])("should preserve object tuple and Headers inputs given response headers", (init) => {
    const response = json({ ok: true }, init);
    expect(response.headers.get("x-value")).toBeTruthy();
  });

  it("should preserve a caller supplied content type", () => {
    expect(
      json({}, { headers: { "content-type": "application/vnd.api+json" } }).headers.get(
        "content-type",
      ),
    ).toBe("application/vnd.api+json");
    expect(
      text("ok", { headers: new Headers({ "content-type": "text/custom" }) }).headers.get(
        "content-type",
      ),
    ).toBe("text/custom");
  });

  it("should preserve headers when middleware receives an immutable response", async () => {
    const app = createServerApp({
      middleware: [requestId({ generate: () => "request-1" }), securityHeaders()],
      routes: [{ path: "/redirect", handler: () => Response.redirect("http://example.test/next") }],
    });
    const response = await app.fetch(new Request("http://example.test/redirect"));
    expect(response.headers.get("location")).toBe("http://example.test/next");
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("should preserve multiple Set-Cookie values", () => {
    const first = setCookie(new Response(null), "one", "1");
    const second = setCookie(first, "two", "2");
    expect(second.headers.getSetCookie()).toEqual(["one=1", "two=2"]);
  });

  it("should expose matching standalone and context response helpers", async () => {
    const standalone = json({ ok: true }, { status: 201, headers: { "x-value": "yes" } });
    const app = createServerApp({
      routes: [
        {
          path: "/",
          handler: (context) =>
            context.json({ ok: true }, { status: 201, headers: { "x-value": "yes" } }),
        },
      ],
    });
    const contextual = await app.fetch(new Request("http://example.test/"));
    expect(contextual.status).toBe(standalone.status);
    expect([...contextual.headers]).toEqual([...standalone.headers]);
    expect(await contextual.text()).toBe(await standalone.text());
  });
});

describe("router", () => {
  it("should prefer static then parameter then wildcard routes", async () => {
    const router = createRouter();
    router.get("/objects/{*key}", ({ params }) => text(`wildcard:${params.key}`));
    router.get("/objects/{id}", ({ params }) => text(`parameter:${params.id}`));
    router.get("/objects/current", () => text("static"));
    const app = createServerApp(router);
    expect(await (await app.fetch(new Request("http://example.test/objects/current"))).text()).toBe(
      "static",
    );
    expect(await (await app.fetch(new Request("http://example.test/objects/42"))).text()).toBe(
      "parameter:42",
    );
    expect(await (await app.fetch(new Request("http://example.test/objects/a/b"))).text()).toBe(
      "wildcard:a/b",
    );
  });

  it("should use registration order only for equal-specificity routes", async () => {
    const router = createRouter();
    router.get("/{first}", () => text("first"));
    router.get("/{second}", () => text("second"));
    expect(
      await (await createServerApp(router).fetch(new Request("http://example.test/value"))).text(),
    ).toBe("first");
  });

  it("should choose the most specific route supporting the requested method", async () => {
    const router = createRouter();
    router.get("/items/fixed", () => text("static-get"));
    router.post("/items/{id}", ({ params }) => text(`parameter-post:${params.id}`));
    const response = await createServerApp(router).fetch(
      new Request("http://example.test/items/fixed", { method: "POST" }),
    );
    expect(await response.text()).toBe("parameter-post:fixed");
  });

  it("should aggregate deterministic Allow values across every matching path shape", async () => {
    const router = createRouter();
    router.get("/items/fixed", () => text("get"));
    router.route("PURGE", "/items/{id}", () => text("purge"));
    router.post("/items/{*path}", () => text("post"));
    const response = await createServerApp(router).fetch(
      new Request("http://example.test/items/fixed", { method: "DELETE" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, PURGE, POST");
    expect(
      await (
        await createServerApp(router).fetch(
          new Request("http://example.test/items/one", { method: "PURGE" }),
        )
      ).text(),
    ).toBe("purge");
  });

  it("should preserve named and unnamed wildcard semantics", async () => {
    const named = createServerApp({
      routes: [{ path: "/files/{*key}", handler: ({ params }) => text(params.key) }],
    });
    expect(await (await named.fetch(new Request("http://example.test/files"))).text()).toBe("");
    const unnamed = createServerApp({
      routes: [{ path: "/files/*", handler: () => text("matched") }],
    });
    expect((await unnamed.fetch(new Request("http://example.test/files"))).status).toBe(404);
    expect(await (await unnamed.fetch(new Request("http://example.test/files/a"))).text()).toBe(
      "matched",
    );
  });

  it("should return a 400 Problem response for malformed captured encoding", async () => {
    const app = createServerApp({ routes: [{ path: "/items/{id}", handler: () => text("no") }] });
    const response = await app.fetch(new Request("http://example.test/items/%E0%A4%A"));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("should snapshot compiled routes at application construction", async () => {
    const router = createRouter();
    router.get("/before", () => text("before"));
    const app = createServerApp(router);
    router.get("/after", () => text("after"));
    expect((await app.fetch(new Request("http://example.test/after"))).status).toBe(404);
  });

  it("should register route options after the handler", async () => {
    const router = createRouter();
    router.get("/admin/{id}", ({ params }) => json(params), { auth: requireRole("admin") });
    const app = createServerApp({
      router,
      auth: { resolve: async () => authenticated },
    });
    await expect(
      (await app.fetch(new Request("http://example.test/admin/42"))).json(),
    ).resolves.toEqual({ id: "42" });
  });

  it("should support method helpers without implementation classes", async () => {
    const routes = defineRoutes((route) => {
      route.post("/items", () => text("created"));
      route.ws("/socket", () => undefined);
    });
    expect(routes.map((route) => route.method)).toEqual(["POST", "GET"]);
  });

  it("should preserve explicit API route precedence over fallback", async () => {
    const app = createServerApp({
      routes: [{ path: "/api", handler: () => text("api") }],
      fallback: () => text("page"),
    });
    expect(await (await app.fetch(new Request("http://example.test/api"))).text()).toBe("api");
    expect(await (await app.fetch(new Request("http://example.test/page"))).text()).toBe("page");
  });

  it("should preserve explicit HEAD and OPTIONS behavior", async () => {
    const app = createServerApp({
      routes: [
        { path: "/items", method: "GET", handler: () => text("get") },
        { path: "/items", method: "POST", handler: () => text("post") },
        {
          path: "/items",
          method: "HEAD",
          handler: () => text("head", { headers: { "x-route": "head" } }),
        },
      ],
    });
    const head = await app.fetch(new Request("http://example.test/items", { method: "HEAD" }));
    expect(head.headers.get("x-route")).toBe("head");
    expect(await head.text()).toBe("");
    const options = await app.fetch(
      new Request("http://example.test/items", { method: "OPTIONS" }),
    );
    expect(options.headers.get("allow")).toBe("GET, HEAD, POST");
  });
});

describe("middleware composition", () => {
  it("should support nested synchronous and asynchronous middleware", async () => {
    const order: string[] = [];
    const app = createServerApp({
      middleware: [
        async (_ctx, next) => {
          order.push("outer-before");
          const value = await next();
          order.push("outer-after");
          return value;
        },
        (_ctx, next) => {
          order.push("inner");
          return next();
        },
      ],
      routes: [
        {
          path: "/",
          handler: () => {
            order.push("handler");
            return text("ok");
          },
        },
      ],
    });
    await app.fetch(new Request("http://example.test/"));
    expect(order).toEqual(["outer-before", "inner", "handler", "outer-after"]);
  });

  it("should reject double next without invoking the handler twice", async () => {
    let calls = 0;
    const app = createServerApp({
      middleware: [
        async (_ctx, next) => {
          await next();
          return next();
        },
      ],
      routes: [
        {
          path: "/",
          handler: () => {
            calls += 1;
            return text("ok");
          },
        },
      ],
      onError: (error) => text((error as Error).message, { status: 500 }),
    });
    const response = await app.fetch(new Request("http://example.test/"));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("next() may only be called once");
    expect(calls).toBe(1);
  });

  it("should apply the double-next guard to route middleware", async () => {
    let calls = 0;
    const app = createServerApp({
      routes: [
        {
          path: "/",
          middleware: [
            async (_ctx, next) => {
              await next();
              return next();
            },
          ],
          handler: () => {
            calls += 1;
            return text("ok");
          },
        },
      ],
      onError: () => text("handled", { status: 500 }),
    });
    expect((await app.fetch(new Request("http://example.test/"))).status).toBe(500);
    expect(calls).toBe(1);
  });
});

describe("one auth context dispatch", () => {
  it("should resolve auth once given an API request", async () => {
    let resolutions = 0;
    const app = createServerApp({
      auth: { resolve: async () => ((resolutions += 1), authenticated) },
      routes: [{ path: "/", handler: ({ auth }) => json(auth), auth: requireUser() }],
    });
    expect((await app.fetch(new Request("http://example.test/"))).status).toBe(200);
    expect(resolutions).toBe(1);
  });

  it("should expose anonymous AuthContext when no resolver exists", async () => {
    const app = createServerApp({ routes: [{ path: "/", handler: ({ auth }) => json(auth) }] });
    await expect((await app.fetch(new Request("http://example.test/"))).json()).resolves.toEqual({
      authenticated: false,
      principal: null,
      session: null,
      tenant: null,
    });
  });

  it("should invoke onError given an auth resolver failure", async () => {
    const app = createServerApp({
      auth: {
        resolve: async () => {
          throw new Error("resolver failed");
        },
      },
      onError: (error) => text((error as Error).message, { status: 503 }),
    });
    const response = await app.fetch(new Request("http://example.test/"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("resolver failed");
  });

  it("should isolate auth params and state across concurrent requests", async () => {
    const app = createServerApp({
      auth: {
        resolve: async (request) => ({
          authenticated: true,
          principal: { id: new URL(request.url).pathname.slice(1) },
          session: null,
          tenant: null,
        }),
      },
      middleware: [
        async (context, next) => {
          context.state.id = context.auth.principal?.id;
          return next();
        },
      ],
      routes: [
        { path: "/{id}", handler: ({ auth, params, state }) => json({ auth, params, state }) },
      ],
    });
    const [one, two] = await Promise.all([
      app.fetch(new Request("http://example.test/one")),
      app.fetch(new Request("http://example.test/two")),
    ]);
    expect(await one.json()).toMatchObject({
      params: { id: "one" },
      state: { id: "one" },
      auth: { principal: { id: "one" } },
    });
    expect(await two.json()).toMatchObject({
      params: { id: "two" },
      state: { id: "two" },
      auth: { principal: { id: "two" } },
    });
  });

  it("should return a Bearer 401 given unauthenticated route denial", async () => {
    const app = createServerApp({
      routes: [{ path: "/", handler: () => text("secret"), auth: requireUser() }],
    });
    const response = await app.fetch(new Request("http://example.test/"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("should return 403 given forbidden route denial", async () => {
    const app = createServerApp({
      auth: { resolve: async () => ({ ...authenticated, principal: { id: "user-1" } }) },
      routes: [{ path: "/", handler: () => text("secret"), auth: requireRole("admin") }],
    });
    expect((await app.fetch(new Request("http://example.test/"))).status).toBe(403);
  });

  it("should reject an authenticated user from an anonymous-only route", async () => {
    const app = createServerApp({
      auth: { resolve: async () => authenticated },
      routes: [{ path: "/login", handler: () => text("login"), auth: requireAnonymous() }],
    });
    expect((await app.fetch(new Request("http://example.test/login"))).status).toBe(403);
  });

  it.each(["unauthenticated", "forbidden", "already_authenticated"] as const)(
    "should let applications own the %s access denial response before route execution",
    async (reason) => {
      const calls: string[] = [];
      const app = createServerApp({
        middleware: [async (_context, next) => (calls.push("global"), next())],
        routes: [
          {
            path: "/",
            auth: () => ({ allowed: false, reason }),
            middleware: [async (_context, next) => (calls.push("route"), next())],
            handler: () => (calls.push("handler"), text("secret")),
          },
        ],
        onAccessDenied: (decision, context) => {
          calls.push(`denied:${decision.reason}`);
          return context.problem(reason === "unauthenticated" ? 401 : 403, "Access denied", {
            extensions: { code: decision.reason, violations: [] },
          });
        },
        onError: () => (calls.push("error"), text("error", { status: 500 })),
      });
      const response = await app.fetch(new Request("http://example.test/"));
      expect(response.status).toBe(reason === "unauthenticated" ? 401 : 403);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(await response.json()).toMatchObject({ code: reason, violations: [] });
      expect(calls).toEqual(["global", `denied:${reason}`]);
    },
  );

  it("should send access denial handler exceptions to onError", async () => {
    const app = createServerApp({
      routes: [{ path: "/", auth: requireUser(), handler: () => text("secret") }],
      onAccessDenied: () => {
        throw new Error("denial mapping failed");
      },
      onError: (error) => text((error as Error).message, { status: 503 }),
    });
    const response = await app.fetch(new Request("http://example.test/"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("denial mapping failed");
  });

  it("should run global middleware before route authorization", async () => {
    const order: string[] = [];
    const auth = () => (
      order.push("auth"),
      { allowed: false as const, reason: "forbidden" as const }
    );
    const app = createServerApp({
      middleware: [
        async (_context, next) => {
          order.push("global-before");
          const response = await next();
          order.push("global-after");
          return response;
        },
      ],
      routes: [{ path: "/", handler: () => text("no"), auth }],
    });
    await app.fetch(new Request("http://example.test/"));
    expect(order).toEqual(["global-before", "auth", "global-after"]);
  });

  it("should deny before route middleware and handler execution", async () => {
    const calls: string[] = [];
    const routeMiddleware: Middleware = async (_context, next) => {
      calls.push("middleware");
      return next();
    };
    const app = createServerApp({
      routes: [
        {
          path: "/",
          auth: requireUser(),
          middleware: [routeMiddleware],
          handler: () => (calls.push("handler"), text("secret")),
        },
      ],
    });
    await app.fetch(new Request("http://example.test/"));
    expect(calls).toEqual([]);
  });

  it("should deny a WebSocket route before upgrade", async () => {
    let upgraded = false;
    const app = createServerApp({
      websocket: { upgrade: async () => ((upgraded = true), new Response(null, { status: 101 })) },
      routes: defineRoutes((route) =>
        route.ws("/socket", () => undefined, { auth: requireUser() }),
      ),
    });
    expect((await app.fetch(new Request("http://example.test/socket"))).status).toBe(401);
    expect(upgraded).toBe(false);
  });

  it("should prefer a dispatch WebSocket adapter over the application adapter", async () => {
    const app = createServerApp({
      websocket: { upgrade: async () => new Response("application") },
      routes: defineRoutes((route) => route.ws("/socket", () => undefined)),
    });
    const response = await app.fetch(new Request("http://example.test/socket"), {
      websocket: { upgrade: async () => new Response("dispatch") },
    });
    expect(await response.text()).toBe("dispatch");
  });

  it("should expose the identical AuthContext object to middleware and handlers", async () => {
    let observed: AuthContext | undefined;
    const app = createServerApp({
      auth: { resolve: async () => authenticated },
      middleware: [
        async (context, next) => {
          observed = context.auth;
          return next();
        },
      ],
      routes: [{ path: "/", handler: (context) => json({ identical: context.auth === observed }) }],
    });
    await expect((await app.fetch(new Request("http://example.test/"))).json()).resolves.toEqual({
      identical: true,
    });
  });
});

describe("bind integration", () => {
  it("should preserve bind behavior until its standalone redesign", async () => {
    const app = createServerApp({
      routes: [
        {
          path: "/items/{id}",
          method: "POST",
          handler: async (context) => context.json(await context.bind()),
        },
      ],
    });
    const response = await app.fetch(
      new Request("http://example.test/items/42?view=full", {
        method: "POST",
        headers: { "content-type": "application/json", "x-source": "test" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    );
    const result = (await response.json()) as Record<string, unknown>;
    expect(result).toMatchObject({
      name: "Ada",
      view: "full",
      id: "42",
    });
    expect(result["x-source"]).toBeUndefined();
  });
});
