import { describe, expect, it } from "vitest";
import { bind } from "../src/binding";
import { createServerApp } from "../src/application";

function echoApp(method: string | readonly string[] = "POST", path = "/items/{id}") {
  return createServerApp({
    routes: [{ path, method, handler: async (ctx) => ctx.json(await ctx.bind()) }],
  });
}

describe("model binding source edges", () => {
  it("preserves empty, bare, encoded, null-byte, and case-sensitive query keys", async () => {
    const response = await echoApp("GET").fetch(
      new Request(
        "http://example.test/items/1?empty=&bare&plus=hello+world&unicode=%E2%9C%93&nul=%00&case=lower&Case=upper",
      ),
    );
    await expect(response.json()).resolves.toEqual({
      empty: "",
      bare: "",
      plus: "hello world",
      unicode: "✓",
      nul: "\0",
      case: "lower",
      Case: "upper",
      id: "1",
    });
  });

  it("preserves three or more repeated query values in insertion order", async () => {
    const response = await echoApp("GET").fetch(
      new Request("http://example.test/items/1?tag=first&tag=&tag=third&tag=fourth"),
    );
    await expect(response.json()).resolves.toMatchObject({ tag: ["first", "", "third", "fourth"] });
  });

  it("replaces an entire body value at each later source boundary", async () => {
    const response = await echoApp("POST", "/items/{value}").fetch(
      new Request("http://example.test/items/route?value=query-one&value=query-two&body-only=yes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: ["body-one", "body-two"], "body-only": false }),
      }),
    );
    await expect(response.json()).resolves.toEqual({
      value: "route",
      "body-only": "yes",
    });
  });

  it("excludes every request header while leaving explicit access available", async () => {
    const app = createServerApp({
      routes: [
        {
          path: "/",
          method: "GET",
          handler: async (ctx) =>
            ctx.json({
              bound: await ctx.bind(),
              authorization: ctx.headers.get("authorization"),
              cookie: ctx.headers.get("cookie"),
              custom: ctx.headers.get("x-custom"),
            }),
        },
      ],
    });
    const result = await (
      await app.fetch(
        new Request("http://example.test/?authorization=query", {
          headers: {
            authorization: "Bearer secret",
            cookie: "sid=secret",
            "x-custom": "explicit",
          },
        }),
      )
    ).json();
    expect(result).toEqual({
      bound: { authorization: "query" },
      authorization: "Bearer secret",
      cookie: "sid=secret",
      custom: "explicit",
    });
  });

  it("safely binds prototype-sensitive keys from JSON, query, and route sources", async () => {
    const app = echoApp("POST", "/items/{__proto__}/{constructor}");
    const response = await app.fetch(
      new Request(
        "http://example.test/items/route-proto/route-constructor?prototype=query-prototype",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"__proto__":"body-proto","constructor":"body-constructor","toString":"body-string"}',
        },
      ),
    );
    const result = (await response.json()) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toBe("route-proto");
    expect(result.constructor).toBe("route-constructor");
    expect(result.prototype).toBe("query-prototype");
    expect(result.toString).toBe("body-string");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("returns an ordinary plain object even though collection dictionaries are prototype-free", async () => {
    const app = createServerApp({
      routes: [
        {
          path: "/{id}",
          method: "GET",
          handler: async (ctx) => {
            const value = await ctx.bind();
            return ctx.json({
              ordinaryPrototype: Object.getPrototypeOf(value) === Object.prototype,
              ownsId: Object.hasOwn(value, "id"),
            });
          },
        },
      ],
    });
    await expect(
      (await app.fetch(new Request("http://example.test/1?q=yes"))).json(),
    ).resolves.toEqual({
      ordinaryPrototype: true,
      ownsId: true,
    });
  });

  it("binds query and route values on GET without attempting body parsing", async () => {
    const request = new Request("http://example.test/items/1?q=yes", {
      headers: { "content-type": "application/json" },
    });
    const url = new URL(request.url);
    await expect(
      bind({ request, params: { id: "1" }, url, query: url.searchParams }),
    ).resolves.toEqual({ q: "yes", id: "1" });
    expect(request.bodyUsed).toBe(false);
  });

  it("binds query and route values on HEAD without attempting body parsing", async () => {
    const request = new Request("http://example.test/items/1?q=yes", {
      method: "HEAD",
      headers: { "content-type": "application/json" },
    });
    const url = new URL(request.url);
    await expect(
      bind({ request, params: { id: "1" }, url, query: url.searchParams }),
    ).resolves.toEqual({ q: "yes", id: "1" });
    expect(request.bodyUsed).toBe(false);
  });
});

describe("model binding cache edges", () => {
  it("shares one promise and object across concurrent calls", async () => {
    const app = createServerApp({
      routes: [
        {
          path: "/",
          method: "POST",
          handler: async (ctx) => {
            const firstPromise = ctx.bind();
            const secondPromise = ctx.bind();
            const [first, second] = await Promise.all([firstPromise, secondPromise]);
            return ctx.json({
              samePromise: firstPromise === secondPromise,
              sameObject: first === second,
            });
          },
        },
      ],
    });
    await expect(
      (
        await app.fetch(
          new Request("http://example.test/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).json(),
    ).resolves.toEqual({ samePromise: true, sameObject: true });
  });

  it("shares the cached object between route middleware and the handler", async () => {
    const app = createServerApp({
      routes: [
        {
          path: "/",
          method: "POST",
          middleware: [
            async (ctx, next) => {
              ctx.state.bound = await ctx.bind();
              return next();
            },
          ],
          handler: async (ctx) => {
            const bound = await ctx.bind();
            return ctx.json({ identical: ctx.state.bound === bound, value: bound });
          },
        },
      ],
    });
    await expect(
      (
        await app.fetch(
          new Request("http://example.test/?q=yes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"body":true}',
          }),
        )
      ).json(),
    ).resolves.toEqual({ identical: true, value: { body: true, q: "yes" } });
  });

  it("preserves mutations because repeated calls return the same model object", async () => {
    const app = createServerApp({
      routes: [
        {
          path: "/",
          method: "GET",
          handler: async (ctx) => {
            const first = await ctx.bind<Record<string, unknown>>();
            first.added = "later";
            return ctx.json(await ctx.bind());
          },
        },
      ],
    });
    await expect(
      (await app.fetch(new Request("http://example.test/?q=yes"))).json(),
    ).resolves.toEqual({ q: "yes", added: "later" });
  });

  it("caches a failed binding promise and rejection object", async () => {
    const app = createServerApp({
      routes: [
        {
          path: "/",
          method: "POST",
          handler: async (ctx) => {
            const first = ctx.bind();
            const second = ctx.bind();
            const [left, right] = await Promise.allSettled([first, second]);
            return ctx.json({
              samePromise: first === second,
              sameReason:
                left.status === "rejected" &&
                right.status === "rejected" &&
                left.reason === right.reason,
            });
          },
        },
      ],
    });
    await expect(
      (
        await app.fetch(
          new Request("http://example.test/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          }),
        )
      ).json(),
    ).resolves.toEqual({ samePromise: true, sameReason: true });
  });
});
