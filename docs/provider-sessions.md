# Provider sessions

`createAskrApp` accepts either an application-owned `auth.resolver` with the
existing credential routes, or one provider-session configuration. Mixing these
configurations is rejected. Provider sessions use `@askrjs/auth/server` for the
transaction, identity, grant, cookie and authority lifecycle.

```ts
import { createOidcProvider } from "@askrjs/auth/server";
import { createAskrApp } from "@askrjs/server/askr";

const provider = createOidcProvider({
  id: "company",
  issuer: "https://identity.example.com",
  clientId: "application-client",
  clientAuthentication: {
    method: "client_secret_post",
    secret: process.env.PROVIDER_CLIENT_SECRET!,
  },
  identityScopes: ["openid", "profile"],
});

const app = createAskrApp({
  name: "Application",
  version: "1",
  dependencies: {},
  pages: registry,
  auth: {
    origin: "https://application.example.com",
    providers: [provider],
    session: { secrets: [process.env.SESSION_KEY!] },
  },
});
```

`origin` is an explicit canonical HTTPS origin. Register exactly
`https://application.example.com/auth/callback/company` at this provider. Host
and forwarded headers do not select the application origin. `SESSION_KEY` is a
base64url-encoded 32-byte key. The default bounded authority is process-local;
shared encryption keys alone do not create a multi-node session store.

The application owns its login page and provider buttons. The reserved routes
are `GET /auth/login/:provider`, the provider's configured query GET or form-post
POST callback, `GET /auth/session`, and `POST /auth/logout`. Login accepts one
`returnTo`, one optional `resource`, and repeated `scope` parameters. Redirect
targets must be safe local paths; fragments are retained. Unrecognized `/auth`
paths do not fall through to page rendering.

Provider mutations carrying the application session cookie require an `Origin`
header equal to the configured origin. The exact form-post callback has its own
single-use encrypted transaction and is exempt from that check. Logout always
requires the same-origin header, even without a session cookie. Its optional
JSON object supports `provider`, `providerLogout`, `revoke`, and an allowlisted
`returnTo`; local logout is the default.

`context.auth.token(provider, { resource, scopes, signal })` obtains a bearer
token for server work. It is bound to that request and is non-enumerable. The
server creates a request-specific auth context without mutating the resolver's
object; SSR policy, preload and rendering share that request context. Manual
auth has the same method with a safe `configuration` failure.

The `/auth/session` response and SSR hydration use the same minimal identity:
`authenticated`, `principal` containing `id` and optional `subject`, `tenant`,
and `scopes`. They omit session records, provider claims, access tokens, refresh
tokens and client secrets. Resource consent failures become HTTP 401 RFC 9457
problems with the safe top-level `interaction-required` code, reason, provider,
resource and scopes. The Core session binding consumes these decoded problems.

The composer finalizes provider responses and errors after dispatch, retaining
unrelated cookies while applying the engine's current authority checks. Closing
the application closes the provider engine, including when the application
cleanup hook fails. Repeated close calls share the same completion.

Signed simulated-provider tests cover implementation behavior. Compatibility
with a provider's live deployment requires its separate live qualification.
