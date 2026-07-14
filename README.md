# @askrjs/server

`@askrjs/server` is a transport-neutral HTTP application layer built around
Web `Request` and `Response`.

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
contract only: request and response validation is not performed, and `ctx.bind()`
keeps its existing behavior.
