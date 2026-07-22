# Feature request: let action responses set/clear cookies

Status: implemented in `@askrjs/server@0.0.6`.

## Summary

`ActionOutcome` (`src/askr/actions.d.ts`) has no way to attach a `Set-Cookie` (or clear a cookie)
to the response an action produces:

```ts
interface ActionOutcome<Result = unknown> {
  readonly redirect?: string;
  readonly result?: Result;
}
```

Add an optional `cookies` field so an `ActionHandler` can set and/or clear cookies as part of its
outcome, with the framework applying them (via the same `setCookie`/`clearCookie`/`CookieOptions`
already exported from `src/http/responses.ts`) to whichever response — a redirect or a JSON
result — the action ultimately produces.

## Motivation

`puma-auth` (an event-sourced identity provider built on this framework) needs every
session-establishing flow — password login, two-step TOTP login, logout, WebAuthn passkey
authentication, SAML SSO — to set or clear its session cookie as part of handling a form
submission. Every one of those forms is exactly what `defineAction`/`ActionForm`/`handleAction`
are for: a native form bound to a declared action, with built-in CSRF and validation. But because
`ActionOutcome` can only redirect or return a result, **none of them can be built as real Askr
actions** — they all had to become plain `@askrjs/server` `ApiRoute` handlers instead, hand-rolling
their own HTML forms and losing the action framework's CSRF protection, input validation, and the
client-side `action()`/`ActionForm` ergonomics entirely.

This is the single largest reason a consumer's entire auth-flow surface can end up outside the
action framework rather than a small, contained exception. Any app with a login form hits this
immediately — it isn't a puma-auth-specific edge case.

## Proposed shape

```ts
import type { CookieOptions } from "../http/responses.js"; // already exported today

type ActionCookieInstruction =
  | {
      readonly name: string;
      readonly value: string;
      readonly clear?: false;
      readonly options?: CookieOptions;
    }
  | {
      readonly name: string;
      readonly clear: true;
      readonly value?: never;
      readonly options?: CookieOptions;
    };

interface ActionOutcome<Result = unknown> {
  readonly redirect?: string;
  readonly result?: Result;
  readonly cookies?: readonly ActionCookieInstruction[];
}
```

The framework validates and normalizes any redirect to a same-origin registered route before it
applies cookie instructions in order through `setCookie`/`clearCookie`. An empty cookie value is a
set operation, not a clear operation. CSRF, validation, thrown-handler, and invalid-redirect
responses never receive outcome cookies.

Native `ActionForm` success keeps POST/redirect/get semantics with a `303`. Enhanced success is
`{version:1, ok:true, result, invalidates, redirect?}`; the client processes the result and
invalidations before using full-document navigation for a redirect.

Usage this unblocks, concretely:

```ts
export const loginAction = defineAction({
  id: "auth.login",
  input: schema.object({ email: schema.email(), password: schema.string() }),
});

handleAction<AppDependencies, InferSchema<typeof loginAction.input>>(
  loginAction,
  async (ctx, input, deps) => {
    const result = await deps.userService.authenticate(input);
    if (!result.authenticated) {
      return { result: { error: "invalid_credentials" } };
    }
    const token = await deps.sessionJwtIssuer.issue({ subject: result.user.userId });
    return {
      redirect: safeReturnTo(input.returnTo),
      cookies: [
        {
          name: SESSION_COOKIE_NAME,
          value: token,
          options: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
        },
      ],
    };
  },
);
```

## Non-goals

- Giving action handlers arbitrary response-header control. Cookies are the concrete, recurring
  need (auth is the canonical action use case that needs them); a general escape hatch for
  arbitrary headers is a separate, much larger surface and isn't what's blocking anyone today.
- Changing anything about `ActionExecution`'s `{kind: "invalid"}` branch (validation failures) —
  cookies are only relevant to a successful outcome.

## Consumer impact once available

`puma-auth`'s `apps/app/src/routes/{login,logout,webauthn-authenticate,saml}.ts` — currently plain
`ApiRoute` handlers with hand-rolled HTML forms specifically because they need to set the session
cookie — could migrate to real `defineAction`/`ActionForm` pages, gaining CSRF protection and
client-side progressive enhancement for free, and bringing puma-auth's entire browser-facing
surface onto one consistent mechanism instead of two.
