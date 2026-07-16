import { createRouter, type PathParams } from "../../dist/index.js";
import { createApi, schema, type InferSchema } from "../../dist/openapi.js";
import { defineServerActions, handleAction, createAskrPageHandler } from "../../dist/askr.js";
import type { ActionDescriptor } from "@askrjs/askr/actions";
import type { RouteManifest } from "@askrjs/askr/router";

const router = createRouter();
router.get("/users/{id}", (ctx) => {
  void (ctx.params.id satisfies string);
  // @ts-expect-error literal paths expose only declared parameters
  void ctx.params.missing;
  return ctx.ok();
});
router.post("/teams/{team}/users/{user}", (ctx) => {
  ctx.params.team satisfies string;
  ctx.params.user satisfies string;
  return ctx.ok();
});
router.get("/objects/{*key}", (ctx) => {
  ctx.params.key satisfies string;
  return ctx.ok();
});
router.ws("/rooms/{room}", (_socket, ctx) => {
  void (ctx.params.room satisfies string);
  // @ts-expect-error WebSocket parameters are inferred too
  void ctx.params.id;
});

declare const dynamicPath: string;
router.get(dynamicPath, (ctx) => {
  ctx.params.anyRuntimeName satisfies string;
  return ctx.ok();
});

interface BoundModel {
  name: string;
  tag?: string | string[];
}
router.post("/bind", async (ctx) => {
  const model = await ctx.bind<BoundModel>();
  void (model.name satisfies string);
  return ctx.ok();
});

type DirectParams = PathParams<"/a/{first}/b/{*rest}">;
const directParams: DirectParams = { first: "one", rest: "two/three" };
void directParams;

type Dependencies = { store: { read(id: string): string } };
const dependent = createApi<Dependencies>({ info: { title: "Dependent", version: "1" } });
dependent.get("/items/{id}", (ctx, dependencies) => {
  void dependencies.store.read(ctx.params.id);
  // @ts-expect-error OpenAPI literal paths expose only declared parameters
  void ctx.params.other;
  return ctx.ok();
}).operationId("getItem").summary("Get item").pathParam("id", schema.string()).ok();
// @ts-expect-error declared dependencies are required
dependent.createRouter();
// @ts-expect-error undefined does not satisfy declared dependencies
dependent.createRouter(undefined);
dependent.createRouter({ store: { read: (id) => id } });

dependent.post("/items/{id}", {
  input: {
    params: schema.object({ id: schema.string() }),
    body: {
      schema: schema.object({ name: schema.string() }),
      mediaTypes: ["application/json"],
    },
  },
  handler: (ctx, input, dependencies) => {
    input.params.id satisfies string;
    input.body.name satisfies string;
    dependencies.store.read(ctx.params.id) satisfies string;
    return ctx.ok();
  },
}).operationId("updateItem").summary("Update item").ok();

const canonicalInput = dependent.post("/canonical", {
  input: { query: schema.object({ page: schema.integer() }) },
  handler: (ctx) => ctx.ok(),
});
// @ts-expect-error executable operations cannot declare replacement input schemas
canonicalInput.queryParam("page", schema.string());

const dependencyFree = createApi({ info: { title: "Free", version: "1" } });
dependencyFree.createRouter();

const grouped = createApi({ info: { title: "Grouped", version: "1" } });
grouped.group("/tenants/{tenant}").get("/items/{id}", (ctx) => {
  ctx.params.tenant satisfies string;
  ctx.params.id satisfies string;
  return ctx.ok();
}).operationId("groupedItem").summary("Grouped item")
  .pathParam("tenant", schema.string()).pathParam("id", schema.string()).ok();

const ObjectSchema = schema.object({
  required: schema.string(),
  optional: schema.optional(schema.number()),
});
type ObjectValue = InferSchema<typeof ObjectSchema>;
const objectWithoutOptional: ObjectValue = { required: "yes" };
const objectWithOptional: ObjectValue = { required: "yes", optional: 1 };
// @ts-expect-error required properties remain required
const objectWithoutRequired: ObjectValue = {};
void [objectWithoutOptional, objectWithOptional, objectWithoutRequired];

const UnionSchema = schema.oneOf(schema.literal("one"), schema.number());
type UnionValue = InferSchema<typeof UnionSchema>;
const unionString: UnionValue = "one";
const unionNumber: UnionValue = 1;
// @ts-expect-error heterogeneous union excludes booleans
const unionBoolean: UnionValue = true;
void [unionString, unionNumber, unionBoolean];

const IntersectionSchema = schema.allOf(
  schema.object({ id: schema.string() }),
  schema.object({ active: schema.boolean() }),
);
type IntersectionValue = InferSchema<typeof IntersectionSchema>;
const intersection: IntersectionValue = { id: "one", active: true };
// @ts-expect-error intersections require every member
const partialIntersection: IntersectionValue = { id: "one" };
void [intersection, partialIntersection];

const Named = grouped.schema("Named", schema.object({ id: schema.string() }));
type NamedValue = InferSchema<typeof Named>;
const named: NamedValue = { id: "one" };
void named;

const document = grouped.toOpenApiDocument();
document.openapi satisfies "3.1.2";
const typedOperation = document.paths["/tenants/{tenant}/items/{id}"].get;
if (typedOperation) typedOperation.responses["200"].description satisfies string;
document.components.schemas.Named satisfies Readonly<Record<string, unknown>>;
// @ts-expect-error generated documents are readonly
document.openapi = "3.0.0";

const SaveAction = {
  id: "save-item",
  input: schema.object({ name: schema.string() }),
  invalidates: ["items:"],
} satisfies ActionDescriptor<{ name: string }>;
const actions = defineServerActions({ dependencies: { store: { write: (name: string) => name } }, csrf: false }, handleAction(SaveAction, (context, input, dependencies) => {
  context.params.id satisfies string;
  input.name satisfies string;
  return { result: dependencies.store.write(input.name) };
}));
declare const manifest: RouteManifest;
createAskrPageHandler({ manifest, actions });
