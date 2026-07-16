import { requireAnonymous, requireUser } from "@askrjs/auth";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../src/application";
import { createApi, schema, security } from "../src/openapi/index";

describe("OpenAPI public contract", () => {
  it("shares route registration between documentation and dependency-injected runtime", async () => {
    const dependencies = { users: { find: vi.fn(async (id: string) => ({ id, name: "Ada" })) } };
    const handler = vi.fn(async (ctx, deps: typeof dependencies) =>
      ctx.ok(await deps.users.find(ctx.params.id)),
    );
    const api = createApi<typeof dependencies>({ info: { title: "Users API", version: "1.0.0" } });
    const User = api.schema(
      "User",
      schema.object({
        id: schema.uuid({ description: "User ID" }),
        name: schema.string({ minLength: 1 }),
        nickname: schema.optional(schema.string()),
      }),
    );

    api
      .group("/api/users")
      .tags("Users")
      .get("/{id}", handler)
      .operationId("getUser")
      .summary("Get a user")
      .pathParam("id", schema.uuid())
      .ok(User)
      .notFound();

    const document = api.toOpenApiDocument();
    expect(handler).not.toHaveBeenCalled();
    const app = createServerApp(api.createRouter(dependencies));
    const response = await app.fetch(new Request("http://example.test/api/users/123"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "123", name: "Ada" });
    expect(handler.mock.calls[0]?.[1]).toBe(dependencies);
    expect(document).toMatchObject({
      openapi: "3.1.2",
      info: { title: "Users API", version: "1.0.0" },
      paths: {
        "/api/users/{id}": {
          get: {
            tags: ["Users"],
            operationId: "getUser",
            parameters: [{ name: "id", in: "path", required: true }],
            responses: {
              "200": {
                content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
              },
              "404": {
                content: {
                  "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
                },
              },
            },
          },
        },
      },
    });
  });

  it("inherits groups and documents parameters, bodies, examples, and operation metadata", () => {
    const middleware = vi.fn(async (ctx, next) => {
      ctx.state.inherited = true;
      return next();
    });
    const api = createApi({ info: { title: "Everything", version: "1" } });
    const Input = schema.object({ title: schema.string({ minLength: 2, maxLength: 50 }) });
    const group = api
      .group("/v1/{tenant}")
      .tags("Items")
      .use(middleware)
      .pathParam("tenant", schema.string())
      .queryParam("locale", schema.string(), { example: "en" });

    group
      .post("/items", (ctx) => ctx.created())
      .operationId("createItem")
      .summary("Create item")
      .description("Creates one item")
      .headerParam("x-trace-id", schema.uuid())
      .cookieParam("sid", schema.string())
      .jsonBody(Input, { required: true, examples: { sample: { value: { title: "Hi" } } } })
      .formBody(Input)
      .multipartBody(Input)
      .created(schema.object({ id: schema.integer({ minimum: 1 }) }), {
        examples: { result: { value: { id: 1 } } },
      })
      .deprecated()
      .externalDocs("https://example.test/docs", "More docs");

    const operation = (api.toOpenApiDocument().paths as Record<string, Record<string, unknown>>)[
      "/v1/{tenant}" + "/items"
    ].post as Record<string, unknown>;
    expect(operation).toMatchObject({
      tags: ["Items"],
      deprecated: true,
      externalDocs: { url: "https://example.test/docs", description: "More docs" },
      requestBody: {
        required: true,
        content: {
          "application/json": {},
          "application/x-www-form-urlencoded": {},
          "multipart/form-data": {},
        },
      },
    });
    expect(operation.parameters).toHaveLength(4);
  });

  it("aligns access with security and adds overridable Problem responses", async () => {
    const api = createApi({
      info: { title: "Secure", version: "1" },
      securitySchemes: { bearer: security.httpBearer({ bearerFormat: "JWT" }) },
    });
    const group = api.group("/secure").access(requireUser(), security.require("bearer"));
    group
      .get("/me", (ctx) => ctx.ok())
      .operationId("getMe")
      .summary("Get me")
      .ok()
      .unauthorized(schema.string(), { mediaType: "text/plain", description: "Custom challenge" });
    api
      .get("/signup", (ctx) => ctx.ok())
      .operationId("signup")
      .summary("Sign up")
      .access(requireAnonymous(), security.none())
      .ok();

    const document = api.toOpenApiDocument() as Record<string, any>;
    expect(document.paths["/secure/me"].get.security).toEqual([{ bearer: [] }]);
    expect(document.paths["/secure/me"].get.responses["401"].description).toBe("Custom challenge");
    expect(document.paths["/secure/me"].get.responses["403"]).toBeDefined();
    expect(document.paths["/signup"].get.security).toEqual([]);
    expect(document.paths["/signup"].get.responses["401"]).toBeUndefined();

    const response = await createServerApp(api.createRouter()).fetch(
      new Request("http://example.test/secure/me"),
    );
    expect(response.status).toBe(401);
  });

  it("supports schema composition, constraints, records, literals, and raw schemas", () => {
    const api = createApi({ info: { title: "Schemas", version: "1" } });
    const Base = api.schema(
      "Base",
      schema.object({ id: schema.uuid(), active: schema.boolean({ default: true }) }),
    );
    const Model = api.schema(
      "Model",
      schema.allOf(
        Base,
        schema.object({
          role: schema.enum(["admin", "user"] as const),
          kind: schema.literal("account"),
          labels: schema.record(schema.string()),
          score: schema.nullable(schema.number({ minimum: 0, maximum: 1 })),
          raw: schema.raw({ type: "string", pattern: "^[a-z]+$" }),
        }),
      ),
    );
    api
      .get("/model", (ctx) => ctx.ok())
      .operationId("getModel")
      .summary("Get model")
      .ok(Model);
    const components = (api.toOpenApiDocument().components as Record<string, any>).schemas;
    expect(components.Model.allOf[0].$ref).toBe("#/components/schemas/Base");
    expect(components.Model.allOf[1].properties.role.enum).toEqual(["admin", "user"]);
    expect(components.Model.allOf[1].properties.score.anyOf).toEqual([
      { maximum: 1, minimum: 0, type: "number" },
      { type: "null" },
    ]);
  });

  it("returns a deeply immutable, deterministic document", () => {
    const api = createApi({
      info: { title: "Stable", version: "1" },
      "x-service": { name: "users" },
    });
    api
      .get("/z", (ctx) => ctx.ok())
      .operationId("z")
      .summary("Z")
      .ok();
    api
      .get("/a", (ctx) => ctx.ok())
      .operationId("a")
      .summary("A")
      .ok();
    const first = api.toOpenApiDocument();
    const second = api.toOpenApiDocument();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.paths)).toBe(true);
    expect(Object.keys(first.paths as object)).toEqual(["/a", "/z"]);
    expect(first["x-service"]).toEqual({ name: "users" });
  });

  it("supports named redirects, remaining server errors, and status ranges", () => {
    const api = createApi({ info: { title: "Responses", version: "1" } });
    api
      .get("/responses", (ctx) => ctx.noContent())
      .operationId("responses")
      .summary("Responses")
      .movedPermanently()
      .found()
      .seeOther()
      .temporaryRedirect()
      .permanentRedirect()
      .methodNotAllowed()
      .notImplemented()
      .response("4XX", undefined, { description: "Other client error" });
    const responses = (api.toOpenApiDocument().paths as Record<string, any>)["/responses"].get
      .responses;
    expect(Object.keys(responses)).toEqual([
      "301",
      "302",
      "303",
      "307",
      "308",
      "405",
      "501",
      "4XX",
    ]);
  });
});
