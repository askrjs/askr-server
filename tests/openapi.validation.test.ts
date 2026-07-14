import { describe, expect, it } from "vitest";
import { createApi, schema, security } from "../src/openapi/index";

function validRoute(api: ReturnType<typeof createApi>, path = "/items", id = "listItems") {
  return api.get(path, (ctx) => ctx.ok()).operationId(id).summary("List items").ok();
}

describe("OpenAPI strict validation", () => {
  it.each([
    ["missing operationId", (api: ReturnType<typeof createApi>) => api.get("/x", (ctx) => ctx.ok()).summary("X").ok(), /operationId is required/],
    ["invalid operationId", (api: ReturnType<typeof createApi>) => api.get("/x", (ctx) => ctx.ok()).operationId("not valid").summary("X").ok(), /invalid operationId/],
    ["missing summary", (api: ReturnType<typeof createApi>) => api.get("/x", (ctx) => ctx.ok()).operationId("x").ok(), /summary is required/],
    ["missing response", (api: ReturnType<typeof createApi>) => api.get("/x", (ctx) => ctx.ok()).operationId("x").summary("X"), /at least one response/],
    ["wildcard", (api: ReturnType<typeof createApi>) => validRoute(api, "/x/*", "x"), /wildcard paths/],
    ["path mismatch", (api: ReturnType<typeof createApi>) => validRoute(api, "/x/{id}", "x"), /path parameters must exactly match/],
    ["extra path parameter", (api: ReturnType<typeof createApi>) => validRoute(api, "/x", "x").pathParam("id", schema.string()), /path parameters must exactly match/],
    ["invalid status", (api: ReturnType<typeof createApi>) => validRoute(api).response(99), /invalid response status/],
    ["unresolved reference", (api: ReturnType<typeof createApi>) => validRoute(api).ok(schema.ref("Missing")), /unresolved schema reference/],
    ["unresolved security", (api: ReturnType<typeof createApi>) => validRoute(api).access(() => ({ allowed: true }), security.require("missing")), /unresolved security scheme/],
    ["invalid component", (api: ReturnType<typeof createApi>) => { api.schema("bad name", schema.string()); validRoute(api); }, /invalid component name/],
    ["duplicate response", (api: ReturnType<typeof createApi>) => validRoute(api).ok(), /duplicate explicit response/],
  ])("rejects %s", (_name, define, expected) => {
    const api = createApi({ info: { title: "Invalid", version: "1" } });
    define(api);
    expect(() => api.toOpenApiDocument()).toThrow(expected);
    expect(() => api.createRouter(undefined)).toThrow(expected);
  });

  it("rejects duplicate operation IDs and method/path pairs", () => {
    const ids = createApi({ info: { title: "Invalid", version: "1" } });
    validRoute(ids, "/a", "same");
    validRoute(ids, "/b", "same");
    expect(() => ids.toOpenApiDocument()).toThrow(/duplicate operationId/);

    const paths = createApi({ info: { title: "Invalid", version: "1" } });
    validRoute(paths, "/a", "one");
    validRoute(paths, "/a", "two");
    expect(() => paths.toOpenApiDocument()).toThrow(/duplicate method\/path pair/);
  });

  it("rejects duplicate definitions and parameters at finalization", () => {
    const api = createApi({ info: { title: "Invalid", version: "1" } });
    api.schema("Thing", schema.string());
    api.schema("Thing", schema.number());
    validRoute(api).queryParam("q", schema.string()).queryParam("q", schema.string());
    expect(() => api.toOpenApiDocument()).toThrow(/duplicate schema component Thing/);
  });
});
