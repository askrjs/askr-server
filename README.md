# @askrjs/server

[![CI](https://github.com/askrjs/askr-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/askrjs/askr-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40askrjs%2Fserver.svg)](https://www.npmjs.com/package/@askrjs/server)

Build HTTP applications with Web `Request` and `Response` objects. `@askrjs/server` owns routing,
middleware, request binding, response helpers, OpenAPI contracts, probes, and server-side Askr
integration without depending on a particular runtime.

Use `@askrjs/node` to run an application on Node.js, or provide another adapter for a different
runtime.

## Install

```sh
npm install @askrjs/server
```

## Create an application

```ts
import { createServerApp, json } from "@askrjs/server";

const app = createServerApp({
  routes: [
    {
      method: "GET",
      path: "/health",
      handler: () => json({ status: "ok" }),
    },
  ],
});

const response = await app.fetch(new Request("https://example.test/health"));
```

An application is a fetch-shaped object, so it can be tested directly and passed to any compatible
runtime adapter.

## Routing

Literal route paths infer their parameters for HTTP, WebSocket, and OpenAPI
handlers. Named wildcards capture the remaining path:

```ts
router.get("/objects/{*key}", (ctx) => {
  return ctx.ok({ key: ctx.params.key });
});
```

## Explicit dependencies

Create application dependencies at the composition root and pass them into
route registration functions. Dependencies do not belong on request context
and there is no runtime service locator.

```ts
type AppDependencies = {
  db: Database;
  audit: AuditLog;
};

function registerUserRoutes(router: Router, deps: Pick<AppDependencies, "db" | "audit">) {
  router.get("/users/{id}", async (ctx) => {
    const user = await deps.db.users.find(ctx.params.id);
    if (!user) return ctx.notFound("User not found");

    await deps.audit.record("user.read", { id: user.id });
    return ctx.ok(user);
  });
}

const deps = createDependencies();
const router = createRouter();
registerUserRoutes(router, deps);
const app = createServerApp(router);
```

This keeps dependency ownership visible, makes route modules easy to test
with fakes, and reserves `ctx` for request-scoped capabilities.

## Model binding

`ctx.bind()` creates one flat model from the request. It reads each supported
body at most once and caches the resulting object for the rest of the request.

Sources are applied in this order; a later source replaces an earlier value
when both contain the exact same key:

| Priority | Source            | Bound values                                           |
| -------- | ----------------- | ------------------------------------------------------ |
| 1        | JSON or form body | JSON values, form strings, and uploaded `File` objects |
| 2        | Query string      | Strings; repeated keys become `string[]`               |
| 3        | Route parameters  | Decoded strings; these are authoritative               |

```ts
interface UpdateUserModel {
  id: string;
  name?: string;
  tag?: string | string[];
}

router.patch("/users/{id}", async (ctx) => {
  const model = await ctx.bind<UpdateUserModel>();
  // /users/42?tag=admin&tag=editor binds:
  // { ...body, tag: ["admin", "editor"], id: "42" }
  return ctx.ok(await users.update(model));
});
```

Supported bodies are:

- `application/json` and media types ending in `+json`; the value must be an
  object. Nested JSON values are preserved.
- `application/x-www-form-urlencoded`; repeated fields become arrays.
- `multipart/form-data`; text fields are strings and file fields are `File`
  objects. Repeated fields become arrays in their original order.

Body binding applies to any body-capable method; `GET` and `HEAD` never read a
body. Empty bodies contribute no values. Unsupported or missing media types
also contribute no body values and are left unread. Invalid JSON, a non-object
JSON root, malformed multipart data, or an already-consumed supported body
produces a `400 application/problem+json` response.

Framework-owned parsing is bounded to 1 MiB by default. Set
`createServerApp({ maxRequestBytes })` for the application or
`{ maxRequestBytes }` on a route; the route value wins. OpenAPI routes expose
the same override as `.maxRequestBytes(bytes)`. Oversized declared or streamed
bodies return an RFC 7807 `413 Payload Too Large`. Direct reads from
`ctx.request` remain application-owned.

Binding is intentionally shallow. It does not parse dotted keys, deep-merge
objects, coerce strings into numbers or booleans, or validate a schema. The
generic argument supplies only a TypeScript view of the result. Use explicit
validation after binding when values cross a trust boundary.

Request headers are deliberately excluded from the model. Read a required
header explicitly through `ctx.headers`, for example
`ctx.headers.get("if-match")`. Body, query, and route keys retain their original
casing, so collision precedence is case-sensitive.

## WebSocket upgrades

WebSocket routes are first-class routes, while the host runtime supplies the
transport-specific upgrade operation:

```ts
const router = createRouter();

router.ws("/rooms/{room}", (socket, ctx) => {
  socket.send(`joined:${ctx.params.room}`);
  const stop = socket.onMessage((message) => socket.send(message));
  socket.onClose(() => stop());
});

const app = createServerApp({
  router,
  websocket: {
    upgrade(request, handler, context) {
      return hostWebSocketUpgrade(request, (socket) => handler(socket, context));
    },
  },
});
```

The router owns path matching, params, middleware, and cancellation. The
`WebSocketAdapter` owns the runtime-specific handshake and socket lifecycle,
so Node, Bun, Deno, and edge adapters can each use their native upgrade API.
Without an adapter, a WebSocket route returns `501 Not Implemented`.

## Authentication and cookies

Resolve one `AuthContext` per request and use shared requirement factories on
routes. Middleware and handlers receive the same context object through
`ctx.auth`:

```ts
import { requirePermission } from "@askrjs/auth";

router.get("/reports", (ctx) => ctx.ok({ subject: ctx.auth.principal?.id }), {
  auth: requirePermission("reports:read"),
});
```

Session establishment and revocation belong to the selected auth runtime. The
server retains low-level response primitives for challenges and cookies:

```ts
router.post("/login", async (ctx) => {
  const credentials = await ctx.bind();
  const token = await sessions.establish(credentials);
  if (!token) return ctx.challenge({ realm: "api" });

  return ctx.setCookie(ctx.noContent(), "sid", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });
});
```

`challenge()` emits `WWW-Authenticate`. `setCookie()` and `clearCookie()` only
modify a response; they do not validate credentials or own session storage.

Applications can map every API access denial into their own complete response
envelope. The custom handler owns all headers, including authentication
challenges, and runs before route middleware and handlers:

```ts
const app = createServerApp({
  router,
  onAccessDenied(decision, ctx) {
    return ctx.problem(decision.reason === "unauthenticated" ? 401 : 403, "Access denied", {
      extensions: { code: decision.reason, violations: [] },
    });
  },
});
```

This produces an RFC 7807-compatible `application/problem+json` response while
retaining the application-owned `code` and `violations` extensions. Without a
custom handler, unauthenticated denials remain `401` with
`WWW-Authenticate: Bearer`; other denials remain `403`.

## Kubernetes-style probes

The server exposes these probe paths automatically:

- `/livez` — process liveness
- `/readyz` — dependency/readiness state
- `/startupz` — startup completion
- `/targetz` — an additional application-target check

Readiness, startup, and target checks can be supplied at boot:

```ts
const app = createServerApp({
  probes: {
    readyz: async () => ((await database.ping()) ? undefined : false),
    startupz: () => dependencies.initialized,
    targetz: () => dependencies.upstream.isHealthy(),
  },
});
```

Returning `false` or throwing produces `503`; returning nothing or `true`
produces `200`. A probe may also return its own `Response`. Explicit API routes
take precedence over the built-in paths.

## OpenAPI route definitions

Import the strict API registry from `@askrjs/server/openapi` when an HTTP route
belongs in the published contract. One fluent definition owns the handler,
dependency injection, and OpenAPI metadata:

```ts
import { requireUser } from "@askrjs/auth";
import { createApi, schema, security } from "@askrjs/server/openapi";

const api = createApi<AppDependencies>({
  info: { title: "Users API", version: "1.0.0" },
  securitySchemes: { bearer: security.httpBearer({ bearerFormat: "JWT" }) },
});

const User = api.schema(
  "User",
  schema.object({
    id: schema.uuid({ description: "User ID" }),
    name: schema.string(),
  }),
);

api
  .group("/api/users")
  .tags("Users")
  .get("/{id}", async (ctx, { users }) => {
    const user = await users.find(ctx.params.id);
    return user ? ctx.ok(user) : ctx.notFound("User not found");
  })
  .operationId("getUser")
  .summary("Get a user")
  .pathParam("id", schema.uuid())
  .access(requireUser(), security.require("bearer"))
  .ok(User)
  .notFound();

const router = api.createRouter(createDependencies());
const document = api.toOpenApiDocument();
```

The default `metadata: "inferred"` mode is a registration and migration
baseline. Missing operation IDs are derived from the method and path (`GET
/users/{id}` becomes `getUsersById`, and `/` becomes `getRoot`), an unauthored
summary is omitted, and a route without an explicit response receives
`default: { description: "Undocumented response" }`. Explicit metadata always
wins, and derived-ID collisions fail with both conflicting routes.

Finished public APIs should continue to author operation IDs, summaries, and
responses explicitly, as above. CI can enforce that contract with authored
mode:

```ts
const api = createApi({
  info: { title: "Users API", version: "1.0.0" },
  metadata: "authored",
});
```

Authored mode requires all three metadata elements; automatic `401` and `403`
access responses do not count as an authored response. Both modes reject blank
summaries, invalid or duplicate operation IDs, invalid responses, mismatched
path parameters, wildcards, and unresolved schema or security references.
Document generation does not execute handlers or construct dependencies. The
returned OpenAPI 3.1.2 object is deterministic and deeply frozen; YAML
serialization belongs to the CLI or another outer adapter.

Keep WebSockets, `CONNECT`, wildcard fallbacks, probes, and intentionally
undocumented routes on the generic router. Executable operations declare each
transport source independently:

```ts
api
  .post("/api/users/{id}", {
    input: {
      params: schema.object({ id: schema.uuid() }),
      query: schema.object({ notify: schema.optional(schema.string()) }),
      headers: schema.object({ "if-match": schema.string() }, { additionalProperties: true }),
      body: {
        schema: schema.object({ name: schema.string({ minLength: 1 }) }),
        mediaTypes: ["application/json"],
      },
    },
    documentation: {
      params: { id: {} },
      query: { notify: {} },
      headers: { "if-match": { description: "Quoted user version" } },
      body: { required: true },
    },
    handler: async (ctx, input, deps) => {
      return ctx.ok(await deps.users.update(input.params.id, input.body));
    },
  })
  .operationId("updateUser")
  .summary("Update a user")
  .ok(User);
```

Malformed declared transport input returns `400`. Executable-schema rejection
returns `422` with paths prefixed by `params`, `query`, `headers`, or `body`.
A declared body is never derived from the flat `ctx.bind()` model. Response
parameters and request bodies are generated directly from these executable
schemas; optional `documentation` may add descriptions, examples, and parameter
metadata but cannot replace a schema. Schema-bearing route-builder methods are
reserved for intentionally unvalidated raw handlers. Response
validation is disabled by default; `validateResponses: true` enables it only
outside production.

## Page actions and request protection

`defineServerActions({ dependencies }, ...entries)` captures server dependencies
once and returns a frozen structural registry. Pair descriptors and handlers
with `handleAction(descriptor, handler)`; registries have no mutation phase. A page
route authorizes its browser-safe descriptors with `actions: [descriptor]`,
and `createAskrPageHandler({ registry, actions })` dispatches only descriptors
authorized by the matched page. Handlers receive route params, auth, policies,
the abort signal, validated input, and the captured dependencies.

Page actions use session-bound HMAC CSRF by default. The page render hydrates a
token which `<ActionForm>` posts as `_csrf` and enhanced `action()` calls send
as `x-askr-csrf-token`. Native success is a `303` to a same-origin matched
route. Native validation failure rerenders at `422` with submitted values and
field errors; enhanced requests receive the versioned JSON envelope and query
prefix invalidations. Successful handlers may return ordered `cookies`
instructions to set or clear cookies. Redirects are validated before cookies
are attached. Enhanced redirects are returned in the envelope so the browser
can perform full-document navigation after updating action state and
invalidations.

`ActionForm` is the native, server-driven primitive. `action().submit()` is the
explicit client-driven primitive; forms are never intercepted automatically.
Both paths use the same descriptor, handler, validation, cookie, and redirect
contract. The default `csrf.sessionId` is `context.auth.session?.id`. Therefore,
an anonymous page receives no CSRF token and any action submission from it is
rejected with `403 A session is required for this action.`

Login, signup, and password-reset pages should establish an opaque, random
pre-authentication session in middleware before rendering, persist it in a
browser cookie, and expose its stable identifier through request state:

```ts
const actions = defineServerActions(
  {
    dependencies,
    csrf: {
      secret: process.env.ACTION_CSRF_SECRET,
      sessionId: (context) =>
        typeof context.state.preAuthSessionId === "string"
          ? context.state.preAuthSessionId
          : context.auth.session?.id,
    },
  },
  handleAction(login, loginHandler),
);
```

The resolver only selects an identity; it does not create or persist the guest
session. Do not use a fixed global value, and do not disable CSRF merely because
a form is pre-authentication. Protocol callbacks such as a SAML ACS remain
protocol routes rather than page actions.

Generic API routes can opt into `csrf({ secret })` and
`rateLimit({ limit, windowMs })` middleware, which creates a private in-memory
fixed-window store. Pass a custom `RateLimitStore` for shared or distributed
state, or create one explicitly with `createMemoryRateLimitStore({ now })`.
Form bodies read by `csrf()` remain available to `ctx.bind()` and declared
OpenAPI body parsing through the bounded framework body cache.
Rate-limit rejection emits
`429`, `Retry-After`, and `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset` headers.

## Optional telemetry

Applications may create one telemetry service with `@askrjs/otel` and pass it
at the composition root. The server does not install a telemetry backend or
import the optional package at runtime:

```ts
import { createTelemetry } from "@askrjs/otel";
import { createServerApp } from "@askrjs/server";

const telemetry = createTelemetry();
const app = createServerApp({ router, fallback: pages, telemetry });
```

The service receives nested request, route-match, API-operation, action,
query-prefetch, loader, and SSR spans. Trace context is extracted from request
headers when the service supports propagation. Structured server fields are
limited to request and trace IDs, route/action/operation identities, status,
and duration; request bodies, cookies, authorization values, CSRF tokens,
submitted fields, and auth principals are never forwarded.
