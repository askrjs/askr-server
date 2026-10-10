import { createServerApp, type ServerAppOptions, type ServerContext } from "../../dist/index.js";
import { createRouter } from "../../dist/router.js";
import { createApi, type ApiOptions } from "../../dist/openapi.js";
import { schema, type InferSchema } from "@askrjs/schema";
import {
  createAskrApp,
  createAskrPageHandler,
  defineServerActions,
  handleAction,
} from "../../dist/askr.js";
import type { ActionDescriptor } from "@askrjs/askr/actions";
import type { RouteManifest } from "@askrjs/askr/router";
import type { RouteRegistry } from "@askrjs/askr/router";
import { runAdapterConformance, AdapterConformanceError } from "../../dist/testing.js";
import type { CookieOptions } from "../../dist/http.js";
import type { AuthRouteOptions, safeRedirect } from "../../dist/auth.js";
import type { ActionHandler, ActionOutcome } from "../../dist/askr.js";
import type { McpContext } from "../../dist/mcp.js";

type Exercises = Parameters<typeof runAdapterConformance>[0];
type Report = Awaited<ReturnType<typeof runAdapterConformance>>;
declare const adapterExercises: Exercises;
runAdapterConformance(adapterExercises) satisfies Promise<Report>;
declare const conformanceError: AdapterConformanceError;
conformanceError.code satisfies string;
type AccessDeniedHandler = NonNullable<ServerAppOptions["onAccessDenied"]>;
type DerivedLeafContracts = [
  CookieOptions["sameSite"],
  Parameters<ServerContext["challenge"]>[0],
  AuthRouteOptions["issuer"],
  Parameters<AuthRouteOptions["authenticate"]>[1],
  Parameters<typeof safeRedirect>[1],
  ApiOptions["info"],
  Parameters<ActionHandler<undefined>>[0],
  NonNullable<ActionOutcome["cookies"]>[number],
  McpContext["protocolRevision"],
  McpContext["transport"],
  Parameters<McpContext["log"]>[0],
];
declare const derivedLeafContracts: DerivedLeafContracts;
void derivedLeafContracts;
declare const context: ServerContext;
context.badRequest() satisfies Response;
context.internalServerError() satisfies Response;
// @ts-expect-error use badRequest
void context.bad;
// @ts-expect-error use internalServerError
void context.serverError;

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

router.get("/prefix{id}", (ctx) => {
  // @ts-expect-error only whole path segments declare parameters
  void ctx.params.id;
  return ctx.ok();
});

type Dependencies = { store: { read(id: string): string } };
const dependent = createApi<Dependencies>({ info: { title: "Dependent", version: "1" } });
dependent
  .get("/items/{id}", (ctx, dependencies) => {
    void dependencies.store.read(ctx.params.id);
    // @ts-expect-error OpenAPI literal paths expose only declared parameters
    void ctx.params.other;
    return ctx.ok();
  })
  .operationId("getItem")
  .summary("Get item")
  .pathParam("id", schema.string())
  .ok();
// @ts-expect-error declared dependencies are required
dependent.createRouter();
// @ts-expect-error undefined does not satisfy declared dependencies
dependent.createRouter(undefined);
dependent.createRouter({ store: { read: (id) => id } });

dependent
  .post("/items/{id}", {
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
  })
  .operationId("updateItem")
  .summary("Update item")
  .ok();

const canonicalInput = dependent.post("/canonical", {
  input: { query: schema.object({ page: schema.integer() }) },
  handler: (ctx) => ctx.ok(),
});
// @ts-expect-error executable operations cannot declare replacement input schemas
canonicalInput.queryParam("page", schema.string());

const dependencyFree = createApi({ info: { title: "Free", version: "1" } });
dependencyFree.createRouter();
createApi({ info: { title: "Authored", version: "1" }, metadata: "authored" });
const denied: AccessDeniedHandler = (decision, context) => {
  decision.reason satisfies "unauthenticated" | "forbidden" | "already_authenticated";
  // @ts-expect-error denied decisions are narrowed to allowed false
  decision.allowed satisfies true;
  return context.forbidden();
};
createServerApp({ onAccessDenied: denied });

const grouped = createApi({ info: { title: "Grouped", version: "1" } });
grouped
  .group("/tenants/{tenant}")
  .get("/items/{id}", (ctx) => {
    ctx.params.tenant satisfies string;
    ctx.params.id satisfies string;
    return ctx.ok();
  })
  .operationId("groupedItem")
  .summary("Grouped item")
  .pathParam("tenant", schema.string())
  .pathParam("id", schema.string())
  .ok();

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
const DeleteAction = {
  id: "delete-item",
  input: schema.object({ id: schema.integer() }),
  invalidates: ["items:"],
} satisfies ActionDescriptor<{ id: number }>;
const actions = defineServerActions(
  { dependencies: { store: { write: (name: string) => name } }, csrf: false },
  handleAction(SaveAction, (context, input, dependencies) => {
    context.params.id satisfies string;
    input.name satisfies string;
    return { result: dependencies.store.write(input.name) };
  }),
  handleAction(DeleteAction, (_context, input) => {
    input.id satisfies number;
    return { result: input.id > 0 };
  }),
);
actions.entries[0]?.descriptor satisfies ActionDescriptor;
declare const manifest: RouteManifest;
// @ts-expect-error page handling consumes the explicit route registry only
createAskrPageHandler({ manifest, actions });

declare const pages: RouteRegistry;
const composed = createAskrApp({
  name: "Typed",
  version: "1",
  dependencies: { store: { read: () => "value" } },
  pages,
  onAccessDenied: denied,
  api: {
    define(api) {
      api
        .get("/value", (_context, dependencies) => {
          dependencies.store.read() satisfies string;
          return new Response();
        })
        .operationId("getValue")
        .summary("Get value")
        .ok();
    },
  },
  close(dependencies) {
    dependencies.store.read() satisfies string;
  },
});
composed.fetch(new Request("https://example.test")) satisfies Promise<Response>;
composed.close() satisfies Promise<void>;

// Every removed or moved 0.4 import must fail at its former entry point.
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { accepted as Removed0 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { accepts as Removed1 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AccessDeniedHandler as Removed2 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ApiRoute as Removed3 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ApiRouteOptions as Removed4 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AuthCredentials as Removed5 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AuthRouteError as Removed6 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AuthRouteOptions as Removed7 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { bad as Removed8 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { badRequest as Removed9 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { bind as Removed10 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { BindContext as Removed11 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { BindingError as Removed12 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { challenge as Removed13 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ChallengeOptions as Removed14 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { clearCookie as Removed15 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { conflict as Removed16 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { contentType as Removed17 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { CookieOptions as Removed18 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { CookieSameSite as Removed19 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { createCspNonce as Removed20 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { created as Removed21 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { createEventStream as Removed22 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { createRouter as Removed23 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { CspNonceProvider as Removed24 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { DEFAULT_MAX_REQUEST_BYTES as Removed25 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { defineRoutes as Removed26 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { error as Removed27 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { EventStream as Removed28 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { EventStreamOptions as Removed29 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { explicitlyAccepts as Removed30 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { forbidden as Removed31 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { formatServerSentEvent as Removed32 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { internalServerError as Removed33 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { json as Removed34 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { JsonValue as Removed35 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { methodNotAllowed as Removed36 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { noContent as Removed37 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { notFound as Removed38 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { notImplemented as Removed39 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ok as Removed40 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { Params as Removed41 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { PathParams as Removed42 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { PayloadTooLargeError as Removed43 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ProbeHandler as Removed44 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ProbeOptions as Removed45 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ProbeResult as Removed46 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { problem as Removed47 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { Problem as Removed48 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ProblemOptions as Removed49 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { readRequestBytes as Removed50 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { readRequestFormData as Removed51 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { readRequestText as Removed52 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { redirect as Removed53 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { registerAuthRoutes as Removed54 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { RequestState as Removed55 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { RouteBuilder as Removed56 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { Router as Removed57 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { safeRedirect as Removed58 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { SafeRedirectOptions as Removed59 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { serverError as Removed60 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ServerSentEvent as Removed61 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ServerTelemetryFields as Removed62 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ServerTelemetryOperation as Removed63 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { serviceUnavailable as Removed64 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { setCookie as Removed65 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { text as Removed66 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { TokenIssuer as Removed67 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { tooManyRequests as Removed68 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { unauthorized as Removed69 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { unprocessableEntity as Removed70 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { WebSocketCloseEvent as Removed71 } from "../../dist/index.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ApiRoute as Removed72 } from "../../dist/router.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { defineRoutes as Removed73 } from "../../dist/router.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { Handler as Removed74 } from "../../dist/router.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { Middleware as Removed75 } from "../../dist/router.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { RouteBuilder as Removed76 } from "../../dist/router.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { WebSocketHandler as Removed77 } from "../../dist/router.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { accepted as Removed78 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { accepts as Removed79 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { bad as Removed80 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { badRequest as Removed81 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { challenge as Removed82 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { conflict as Removed83 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { contentType as Removed84 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { created as Removed85 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { error as Removed86 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { explicitlyAccepts as Removed87 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { forbidden as Removed88 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { formatServerSentEvent as Removed89 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { internalServerError as Removed90 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { methodNotAllowed as Removed91 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { noContent as Removed92 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { notFound as Removed93 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { notImplemented as Removed94 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ok as Removed95 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { serverError as Removed96 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { serviceUnavailable as Removed97 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { tooManyRequests as Removed98 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { unauthorized as Removed99 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { unprocessableEntity as Removed100 } from "../../dist/http.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ResponseLogger as Removed101 } from "../../dist/middleware.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { verifyCsrfToken as Removed102 } from "../../dist/middleware.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ActionCookieInstruction as Removed103 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ActionEntry as Removed104 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ActionExecution as Removed105 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ActionExecutionOptions as Removed106 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ActionHandlerContext as Removed107 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ActionRegistration as Removed108 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ActionRegistryOptions as Removed109 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AskrAppApiOptions as Removed110 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AskrAppAuthOptions as Removed111 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { translateAskrPageResult as Removed112 } from "../../dist/askr.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AuthCredentials as Removed113 } from "../../dist/auth.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { SafeRedirectOptions as Removed114 } from "../../dist/auth.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { TokenIssuer as Removed115 } from "../../dist/auth.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ApiInfo as Removed116 } from "../../dist/openapi.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { BodyOptions as Removed117 } from "../../dist/openapi.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { InferSchema as Removed118 } from "../../dist/openapi.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ParameterOptions as Removed119 } from "../../dist/openapi.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { ResponseOptions as Removed120 } from "../../dist/openapi.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { schema as Removed121 } from "../../dist/openapi.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { Schema as Removed122 } from "../../dist/openapi.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { McpLogLevel as Removed123 } from "../../dist/mcp.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { McpPrimitiveOptions as Removed124 } from "../../dist/mcp.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { McpProtocolRevision as Removed125 } from "../../dist/mcp.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { McpTransportKind as Removed126 } from "../../dist/mcp.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { protectedResourceMetadata as Removed127 } from "../../dist/mcp.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AdapterConformanceErrorCode as Removed128 } from "../../dist/testing.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AdapterConformanceExercises as Removed129 } from "../../dist/testing.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AdapterConformanceOptions as Removed130 } from "../../dist/testing.js";
// @ts-expect-error removed or moved to its canonical owner in 0.5
import type { AdapterConformanceReport as Removed131 } from "../../dist/testing.js";
