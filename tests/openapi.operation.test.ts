import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../src/application";
import { createApi, schema } from "../src/openapi/index";

function finish(route: ReturnType<ReturnType<typeof createApi>["post"]>): void {
  route.operationId("operation").summary("Operation").ok(schema.object({ ok: schema.boolean() }));
}

describe("OpenAPI executable operations", () => {
  it("should read declared sources independently given colliding field names", async () => {
    const api = createApi({ info: { title: "Inputs", version: "1" } });
    const route = api.post("/items/{id}", {
      input: {
        params: schema.object({ id: schema.string() }),
        query: schema.object({ id: schema.string(), tag: schema.array(schema.string()) }),
        headers: schema.object({ "x-mode": schema.literal("test") }, { additionalProperties: true }),
        body: {
          schema: schema.object({ id: schema.string() }),
          mediaTypes: ["application/json"],
        },
      },
      handler: (context, input) => context.ok(input),
    });
    finish(route);
    const operation = api.toOpenApiDocument().paths["/items/{id}"]!.post!;
    expect(operation.parameters?.map(({ name, in: location, schema: projection }) => ({
      name,
      location,
      projection,
    }))).toEqual([
      { name: "id", location: "path", projection: { type: "string" } },
      { name: "id", location: "query", projection: { type: "string" } },
      { name: "tag", location: "query", projection: { type: "array", items: { type: "string" } } },
      { name: "x-mode", location: "header", projection: { const: "test" } },
    ]);
    expect(operation.requestBody?.content["application/json"]?.schema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });

    const response = await createServerApp(api.createRouter()).fetch(new Request(
      "http://example.test/items/path?id=query&tag=one&tag=two",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-mode": "test" },
        body: JSON.stringify({ id: "body" }),
      },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      params: { id: "path" },
      query: { id: "query", tag: ["one", "two"] },
      body: { id: "body" },
    });
  });

  it("should return 400 given malformed declared transport input", async () => {
    const handler = vi.fn((context) => context.ok({ ok: true }));
    const api = createApi({ info: { title: "Inputs", version: "1" } });
    const route = api.post("/items", {
      input: {
        body: {
          schema: schema.object({ name: schema.string() }),
          mediaTypes: ["application/json"],
        },
      },
      handler,
    });
    finish(route);

    const response = await createServerApp(api.createRouter()).fetch(new Request("http://example.test/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail: "Request body contains invalid JSON." });
    expect(handler).not.toHaveBeenCalled();
  });

  it("should return stable source-prefixed issues given schema rejection", async () => {
    const api = createApi({ info: { title: "Inputs", version: "1" } });
    const route = api.post("/items", {
      input: {
        body: {
          schema: schema.object({ profile: schema.object({ name: schema.string({ minLength: 2 }) }) }),
          mediaTypes: ["application/json"],
        },
      },
      handler: (context) => context.ok({ ok: true }),
    });
    finish(route);

    const response = await createServerApp(api.createRouter()).fetch(new Request("http://example.test/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: "x" } }),
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      issues: [{ path: ["body", "profile", "name"], code: "too_small" }],
    });
  });

  it("should not consume an undeclared body before the handler", async () => {
    const api = createApi({ info: { title: "Inputs", version: "1" } });
    const route = api.post("/items", {
      input: { query: schema.object({ mode: schema.string() }) },
      handler: async (context) => context.ok(await context.bind()),
    });
    finish(route);
    const response = await createServerApp(api.createRouter()).fetch(new Request(
      "http://example.test/items?mode=query",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: true }) },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: true, mode: "query" });
  });

  it("should validate responses only when opted in outside production", async () => {
    const api = createApi({
      info: { title: "Responses", version: "1" },
      validateResponses: true,
    });
    const route = api.get("/items", {
      handler: (context) => context.ok({ ok: "not-boolean" }),
    });
    route.operationId("getItems").summary("Get items").ok(schema.object({ ok: schema.boolean() }));
    const response = await createServerApp(api.createRouter()).fetch(new Request("http://example.test/items"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      detail: "Operation response did not match its declared schema.",
      issues: [{ path: ["response", "ok"], code: "invalid_type" }],
    });
  });

  it("should reject a second schema declaration for executable operation input", () => {
    const api = createApi({ info: { title: "Conflicts", version: "1" } });
    const route = api.post("/items", {
      input: { query: schema.object({ page: schema.integer() }) },
      handler: (context) => context.ok({ ok: true }),
    });
    finish(route);
    (route as unknown as { queryParam(name: string, value: unknown): void })
      .queryParam("page", schema.string());
    expect(() => api.toOpenApiDocument()).toThrow(
      "executable operation input conflicts with query parameter page",
    );
  });
});
