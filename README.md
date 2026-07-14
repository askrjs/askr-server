# @askrjs/server

`@askrjs/server` is a transport-neutral HTTP application layer built around
Web `Request` and `Response`.

This `0.0.x` package is pre-release and is not currently published to npm.
Install it from a local checkout or packed artifact while its public contract
is being finalized.

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

| Priority | Source | Bound values |
| --- | --- | --- |
| 1 | JSON or form body | JSON values, form strings, and uploaded `File` objects |
| 2 | Query string | Strings; repeated keys become `string[]` |
| 3 | Request headers | Strings using the Fetch API's lowercase header names |
| 4 | Route parameters | Decoded strings; these are authoritative |

```ts
interface UpdateUserModel {
  id: string;
  name?: string;
  tag?: string | string[];
  "if-match"?: string;
}

router.patch("/users/{id}", async (ctx) => {
  const model = await ctx.bind<UpdateUserModel>();
  // /users/42?tag=admin&tag=editor binds:
  // { ...body, tag: ["admin", "editor"], "if-match": "...", id: "42" }
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

Binding is intentionally shallow. It does not parse dotted keys, deep-merge
objects, coerce strings into numbers or booleans, or validate a schema. The
generic argument supplies only a TypeScript view of the result. Use explicit
validation after binding when values cross a trust boundary.

All request headers—including authorization and cookie headers—participate in
the flat model. Avoid logging or returning the complete bound object when it
may contain credentials. Header names are lowercase; body, query, and route
keys retain their original casing, so collision precedence is case-sensitive.

## WebSocket upgrades

WebSocket routes are first-class routes, while the host runtime supplies the
transport-specific upgrade operation:

```ts
const router = createRouter();

router.ws("/rooms/{room}", (socket, ctx) => {
  socket.send(`joined:${ctx.params.room}`);
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

router.get(
  "/reports",
  (ctx) => ctx.ok({ subject: ctx.auth.principal?.id }),
  { auth: requirePermission("reports:read") },
);
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

const User = api.schema("User", schema.object({
  id: schema.uuid({ description: "User ID" }),
  name: schema.string(),
}));

api.group("/api/users").tags("Users")
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

Finalization rejects incomplete or ambiguous contracts, including missing or
duplicate operation IDs, undocumented responses, mismatched path parameters,
wildcards, and unresolved schema or security references. Document generation
does not execute handlers or construct dependencies. The returned OpenAPI 3.1.2
object is deterministic and deeply frozen; YAML serialization belongs to the
CLI or another outer adapter.

Keep WebSockets, `CONNECT`, wildcard fallbacks, probes, and intentionally
undocumented routes on the generic router. OpenAPI schemas describe the
contract only: request and response validation is not performed. `ctx.bind()`
uses the flat model-binding rules documented above; it does not validate against
OpenAPI request schemas.
