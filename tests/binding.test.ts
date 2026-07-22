import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/application";
import { text } from "../src/http/responses";

function bindingApp(path = "/items/{id}") {
  return createServerApp({
    routes: [
      { path, method: ["POST", "DELETE"], handler: async (ctx) => ctx.json(await ctx.bind()) },
    ],
  });
}

describe("model binding", () => {
  it("should reject multibyte bodies above the route byte limit", async () => {
    const response = await createServerApp({
      maxRequestBytes: 100,
      routes: [
        {
          path: "/",
          method: "POST",
          maxRequestBytes: 8,
          handler: async (ctx) => ctx.json(await ctx.bind()),
        },
      ],
    }).fetch(
      new Request("http://example.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "é" }),
      }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      status: 413,
      title: "Payload Too Large",
    });
  });

  it("should merge body then query then route parameters and exclude headers", async () => {
    const response = await bindingApp("/items/{shared}").fetch(
      new Request("http://example.test/items/route?shared=query&query-only=yes", {
        method: "POST",
        headers: { "content-type": "application/json", shared: "header", "x-source": "excluded" },
        body: JSON.stringify({ shared: "body", "body-only": true }),
      }),
    );
    const result = (await response.json()) as Record<string, unknown>;
    expect(result).toMatchObject({
      shared: "route",
      "body-only": true,
      "query-only": "yes",
    });
    expect(result["x-source"]).toBeUndefined();
    expect(result["content-type"]).toBeUndefined();
  });

  it("should parse standard and structured-suffix JSON objects", async () => {
    const app = bindingApp();
    for (const contentType of ["application/json; charset=utf-8", "application/merge-patch+json"]) {
      const response = await app.fetch(
        new Request("http://example.test/items/1", {
          method: "POST",
          headers: { "content-type": contentType },
          body: JSON.stringify({ nested: { active: true }, values: [1, 2] }),
        }),
      );
      await expect(response.json()).resolves.toMatchObject({
        nested: { active: true },
        values: [1, 2],
      });
    }
  });

  it("should preserve repeated query and URL-encoded form values as arrays", async () => {
    const response = await bindingApp().fetch(
      new Request("http://example.test/items/1?tag=query-one&tag=query-two", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "color=red&color=blue&single=value",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      color: ["red", "blue"],
      single: "value",
      tag: ["query-one", "query-two"],
    });
  });

  it("should parse multipart text fields and files while preserving repetition", async () => {
    const form = new FormData();
    form.append("label", "one");
    form.append("label", "two");
    form.append("upload", new Blob(["first"], { type: "text/plain" }), "first.txt");
    form.append("upload", new Blob(["second"]), "second.txt");
    const app = createServerApp({
      routes: [
        {
          path: "/upload",
          method: "POST",
          handler: async (ctx) => {
            const bound = await ctx.bind<Record<string, unknown>>();
            const files = bound.upload as File[];
            return ctx.json({
              label: bound.label,
              files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
            });
          },
        },
      ],
    });
    await expect(
      (
        await app.fetch(
          new Request("http://example.test/upload", {
            method: "POST",
            body: form,
          }),
        )
      ).json(),
    ).resolves.toEqual({
      label: ["one", "two"],
      files: [
        { name: "first.txt", size: 5, type: "text/plain" },
        { name: "second.txt", size: 6, type: "application/octet-stream" },
      ],
    });
  });

  it("should bind bodies on DELETE and other body-capable methods", async () => {
    const response = await bindingApp().fetch(
      new Request("http://example.test/items/1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "duplicate" }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ reason: "duplicate", id: "1" });
  });

  it("should ignore unsupported body media types without consuming the body", async () => {
    const app = createServerApp({
      routes: [
        {
          path: "/",
          method: "POST",
          handler: async (ctx) => {
            const bound = await ctx.bind();
            return ctx.json({ bound, remaining: await ctx.request.text() });
          },
        },
      ],
    });
    const result = (await (
      await app.fetch(
        new Request("http://example.test/?query=yes", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "untouched",
        }),
      )
    ).json()) as { bound: Record<string, unknown>; remaining: string };
    expect(result.bound).toEqual({ query: "yes" });
    expect(result.remaining).toBe("untouched");
  });

  it("should return the same bound object and read a supported body once", async () => {
    const app = createServerApp({
      routes: [
        {
          path: "/",
          method: "POST",
          handler: async (ctx) => {
            const first = await ctx.bind();
            const second = await ctx.bind();
            return ctx.json({ identical: first === second, first, bodyUsed: ctx.request.bodyUsed });
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
            body: '{"value":1}',
          }),
        )
      ).json(),
    ).resolves.toMatchObject({ identical: true, first: { value: 1 }, bodyUsed: true });
  });

  it("should safely bind keys inherited by ordinary object prototypes", async () => {
    const response = await bindingApp().fetch(
      new Request("http://example.test/items/1?__proto__=safe&constructor=also-safe", {
        method: "POST",
      }),
    );
    const result = (await response.json()) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toBe("safe");
    expect(result.constructor).toBe("also-safe");
  });

  it.each([
    ["invalid JSON", "{", /invalid JSON/],
    ["JSON array", "[]", /must be a JSON object/],
    ["JSON primitive", "true", /must be a JSON object/],
    ["JSON null", "null", /must be a JSON object/],
  ])("should return a 400 Problem response for %s", async (_name, body, detail) => {
    const response = await bindingApp().fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(((await response.json()) as { detail: string }).detail).toMatch(detail);
  });

  it("should return 400 for malformed multipart data", async () => {
    const response = await bindingApp().fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=missing" },
        body: "not-a-valid-multipart-body",
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toMatch(/invalid multipart/);
  });

  it("should return 400 when supported body content was already consumed", async () => {
    const app = createServerApp({
      middleware: [
        async (ctx, next) => {
          await ctx.request.text();
          return next();
        },
      ],
      routes: [{ path: "/", method: "POST", handler: async (ctx) => ctx.json(await ctx.bind()) }],
      onError: () => text("unexpected", { status: 500 }),
    });
    const response = await app.fetch(
      new Request("http://example.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toMatch(/already been consumed/);
  });
});
