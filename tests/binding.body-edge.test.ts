import { describe, expect, it } from "vitest";
import { bind, BindingError } from "../src/binding";
import { createServerApp } from "../src/application";
import { text } from "../src/http/responses";

function echoApp(method: string | readonly string[] = "POST") {
  return createServerApp({
    routes: [{ path: "/items/{id}", method, handler: async (ctx) => ctx.json(await ctx.bind()) }],
  });
}

function jsonRequest(body: string, contentType = "application/json", method = "POST"): Request {
  return new Request("http://example.test/items/1", {
    method,
    headers: { "content-type": contentType },
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

describe("model binding body method and media-type edges", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CUSTOM"])(
    "parses JSON on the body-capable %s method",
    async (method) => {
      const response = await echoApp(method).fetch(
        jsonRequest('{"method":"body"}', "application/json", method),
      );
      await expect(response.json()).resolves.toEqual({ method: "body", id: "1" });
    },
  );

  it.each([
    "application/json",
    "APPLICATION/JSON",
    " application/json ; charset=UTF-8 ",
    "application/problem+json",
    "application/vnd.askr.resource+json; profile=full",
  ])("recognizes the JSON media type %s", async (contentType) => {
    const response = await echoApp().fetch(jsonRequest('{"ok":true}', contentType));
    await expect(response.json()).resolves.toEqual({ ok: true, id: "1" });
  });

  it("preserves every JSON value type below the object root", async () => {
    const response = await echoApp().fetch(
      jsonRequest(
        JSON.stringify({
          string: "value",
          empty: "",
          zero: 0,
          negative: -1.5,
          true: true,
          false: false,
          null: null,
          array: [1, null, false],
          object: { nested: "yes" },
        }),
      ),
    );
    await expect(response.json()).resolves.toEqual({
      string: "value",
      empty: "",
      zero: 0,
      negative: -1.5,
      true: true,
      false: false,
      null: null,
      array: [1, null, false],
      object: { nested: "yes" },
      id: "1",
    });
  });

  it("uses normal JSON duplicate-key semantics", async () => {
    const response = await echoApp().fetch(jsonRequest('{"value":"first","value":"last"}'));
    await expect(response.json()).resolves.toEqual({ value: "last", id: "1" });
  });

  it("treats an empty JSON body as contributing no values", async () => {
    const request = jsonRequest("");
    const response = await echoApp().fetch(request);
    await expect(response.json()).resolves.toEqual({ id: "1" });
    expect(request.bodyUsed).toBe(true);
  });

  it("does not consume a null body even when a supported content type is declared", async () => {
    const request = new Request("http://example.test/items/1?q=yes", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const response = await echoApp().fetch(request);
    await expect(response.json()).resolves.toEqual({ q: "yes", id: "1" });
    expect(request.bodyUsed).toBe(false);
  });

  it("leaves a body without Content-Type unread", async () => {
    const request = new Request("http://example.test/items/1?q=yes", {
      method: "POST",
      body: "untyped",
    });
    request.headers.delete("content-type");
    const app = createServerApp({
      routes: [
        {
          path: "/items/{id}",
          method: "POST",
          handler: async (ctx) =>
            ctx.json({ bound: await ctx.bind(), raw: await ctx.request.text() }),
        },
      ],
    });
    await expect((await app.fetch(request)).json()).resolves.toEqual({
      bound: { q: "yes", id: "1" },
      raw: "untyped",
    });
  });

  it.each([
    "text/plain",
    "application/octet-stream",
    "application/json, text/plain",
    "; charset=utf-8",
  ])("leaves the unsupported or ambiguous media type %s unread", async (contentType) => {
    const request = new Request("http://example.test/items/1?q=yes", {
      method: "POST",
      headers: { "content-type": contentType },
      body: "untouched",
    });
    const app = createServerApp({
      routes: [
        {
          path: "/items/{id}",
          method: "POST",
          handler: async (ctx) =>
            ctx.json({ bound: await ctx.bind(), raw: await ctx.request.text() }),
        },
      ],
    });
    await expect((await app.fetch(request)).json()).resolves.toEqual({
      bound: { q: "yes", id: "1" },
      raw: "untouched",
    });
  });

  it("still ignores an unsupported body after another consumer has read it", async () => {
    const app = createServerApp({
      middleware: [
        async (ctx, next) => {
          await ctx.request.text();
          return next();
        },
      ],
      routes: [
        { path: "/items/{id}", method: "POST", handler: async (ctx) => ctx.json(await ctx.bind()) },
      ],
    });
    const response = await app.fetch(
      new Request("http://example.test/items/1?q=yes", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "consumed but unsupported",
      }),
    );
    await expect(response.json()).resolves.toEqual({ q: "yes", id: "1" });
  });
});

describe("model binding URL-encoded form edges", () => {
  it("decodes plus signs, percent encoding, Unicode, bare fields, and empty names", async () => {
    const response = await echoApp().fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "message=hello+world&unicode=%E2%9C%93&bare&empty=&=empty-name",
      }),
    );
    await expect(response.json()).resolves.toEqual({
      message: "hello world",
      unicode: "✓",
      bare: "",
      empty: "",
      "": "empty-name",
      id: "1",
    });
  });

  it("preserves many repeated fields without changing order", async () => {
    const values = Array.from({ length: 64 }, (_, index) => `value-${index}`);
    const body = values.map((value) => `tag=${value}`).join("&");
    const response = await echoApp().fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );
    const result = (await response.json()) as { tag: string[] };
    expect(result.tag).toEqual(values);
  });

  it("safely binds prototype-sensitive form field names", async () => {
    const response = await echoApp().fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "__proto__=safe&constructor=also-safe&toString=text",
      }),
    );
    const result = (await response.json()) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toBe("safe");
    expect(result.constructor).toBe("also-safe");
    expect(result.toString).toBe("text");
  });

  it("treats an empty URL-encoded body as contributing no values", async () => {
    const response = await echoApp().fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }),
    );
    await expect(response.json()).resolves.toEqual({ id: "1" });
  });
});

describe("model binding multipart edges", () => {
  it("binds an empty multipart form", async () => {
    const response = await echoApp().fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        body: new FormData(),
      }),
    );
    await expect(response.json()).resolves.toEqual({ id: "1" });
  });

  it("preserves mixed text and file entries with the same name", async () => {
    const form = new FormData();
    form.append("mixed", "before");
    form.append("mixed", new Blob(["file"], { type: "text/plain" }), "résumé.txt");
    form.append("mixed", "after");
    const app = createServerApp({
      routes: [
        {
          path: "/items/{id}",
          method: "POST",
          handler: async (ctx) => {
            const mixed = (await ctx.bind<Record<string, unknown>>()).mixed as FormDataEntryValue[];
            const file = mixed[1] as File;
            return ctx.json({
              first: mixed[0],
              file: { name: file.name, type: file.type, size: file.size },
              last: mixed[2],
            });
          },
        },
      ],
    });
    await expect(
      (
        await app.fetch(
          new Request("http://example.test/items/1", {
            method: "POST",
            body: form,
          }),
        )
      ).json(),
    ).resolves.toEqual({
      first: "before",
      file: { name: "résumé.txt", type: "text/plain", size: 4 },
      last: "after",
    });
  });

  it("safely binds prototype-sensitive multipart field names", async () => {
    const form = new FormData();
    form.append("__proto__", "safe");
    form.append("constructor", "also-safe");
    const response = await echoApp().fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        body: form,
      }),
    );
    const result = (await response.json()) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toBe("safe");
    expect(result.constructor).toBe("also-safe");
  });

  it("lets query and route values replace multipart fields and files", async () => {
    const form = new FormData();
    form.append("value", new Blob(["file"]), "value.txt");
    form.append("query", "form");
    const response = await echoApp("POST").fetch(
      new Request("http://example.test/items/route?value=query&query=query", {
        method: "POST",
        body: form,
      }),
    );
    await expect(response.json()).resolves.toEqual({ value: "query", query: "query", id: "route" });
  });
});

describe("model binding read and error edges", () => {
  it("turns a failing request stream into a 400 binding problem", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream failed"));
      },
    });
    const request = new Request("http://example.test/items/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await echoApp().fetch(request);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toBe(
      "Request body could not be read.",
    );
  });

  it.each([
    ["application/json", "{}"],
    ["application/x-www-form-urlencoded", "value=yes"],
  ])("rejects an already-consumed %s body", async (contentType, body) => {
    const app = createServerApp({
      middleware: [
        async (ctx, next) => {
          await ctx.request.text();
          return next();
        },
      ],
      routes: [
        { path: "/items/{id}", method: "POST", handler: async (ctx) => ctx.json(await ctx.bind()) },
      ],
    });
    const response = await app.fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toMatch(/already been consumed/);
  });

  it("rejects an already-consumed multipart body", async () => {
    const form = new FormData();
    form.append("value", "yes");
    const app = createServerApp({
      middleware: [
        async (ctx, next) => {
          await ctx.request.formData();
          return next();
        },
      ],
      routes: [
        { path: "/items/{id}", method: "POST", handler: async (ctx) => ctx.json(await ctx.bind()) },
      ],
    });
    const response = await app.fetch(
      new Request("http://example.test/items/1", {
        method: "POST",
        body: form,
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toMatch(/already been consumed/);
  });

  it("exposes a stable BindingError name, status, message, and cause", async () => {
    const request = jsonRequest("{");
    const url = new URL(request.url);
    try {
      await bind({ request, params: { id: "1" }, url, query: url.searchParams });
      throw new Error("expected bind to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(BindingError);
      expect(error).toMatchObject({
        name: "BindingError",
        status: 400,
        message: "Request body contains invalid JSON.",
      });
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("keeps binding errors out of onError", async () => {
    let onErrorCalls = 0;
    const app = createServerApp({
      routes: [
        { path: "/items/{id}", method: "POST", handler: async (ctx) => ctx.json(await ctx.bind()) },
      ],
      onError: () => {
        onErrorCalls += 1;
        return text("unexpected", { status: 500 });
      },
    });
    const response = await app.fetch(jsonRequest("{"));
    expect(response.status).toBe(400);
    expect(onErrorCalls).toBe(0);
  });
});
