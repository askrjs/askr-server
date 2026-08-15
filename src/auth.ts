import type { AuthContext, Principal } from "@askrjs/auth";
import { authSchema, credentialsSchema, successfulAuthSchema } from "./auth-schemas";
import type { CookieOptions, ServerContext } from "./contracts";
import { accepts } from "./http/media-types";
import type { ApiDefinition } from "./openapi/public";
import { readOperationInput } from "./openapi/request-input";
import type { Schema } from "./openapi/types";

/** Issues auth tokens for a principal, used by {@link registerAuthRoutes} to mint session tokens. */
export interface TokenIssuer<P extends Principal> {
  issue(principal: Omit<P, "id"> & { subject: string }): Promise<string>;
}

/** Options for {@link safeRedirect}. */
export interface SafeRedirectOptions {
  /** Allow redirect targets that include a URL fragment (`#...`). Defaults to disallowed. */
  readonly allowHash?: boolean;
}

/**
 * Creates a validator that resolves an untrusted redirect target to a safe, same-origin,
 * relative path — or to `fallback` if the value is unsafe (absolute, protocol-relative,
 * contains a scheme, control characters, `..` traversal, backslashes, or an unwanted hash).
 *
 * @param fallback - The safe path to use when the requested value is not itself safe. Must
 * itself pass the safety check, or this function throws.
 * @param options - Redirect validation options.
 * @returns A function `(value) => path` that returns `value` if safe, otherwise `fallback`.
 * @throws {Error} If `fallback` is not itself a safe path.
 */
export function safeRedirect(fallback: string, options: SafeRedirectOptions = {}) {
  const isSafe = (value: unknown): value is string => {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
    if (value.includes("\\")) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return false;
    }
    if (
      decoded.includes("\\") ||
      [...decoded].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      }) ||
      decoded.startsWith("//") ||
      /^(?:\/)*(?:[a-z][a-z\d+.-]*:)/i.test(decoded) ||
      /(?:^|\/)\.\.(?:\/|$)/.test(decoded)
    ) {
      return false;
    }
    try {
      const parsed = new URL(value, "https://askr.invalid");
      if (parsed.origin !== "https://askr.invalid" || (!options.allowHash && parsed.hash)) {
        return false;
      }
    } catch {
      return false;
    }
    return true;
  };
  if (!isSafe(fallback)) throw new Error("safeRedirect requires a safe fallback.");
  return (value: unknown): string => (isSafe(value) ? value : fallback);
}

/** Error thrown from `register`/`authenticate`/etc. callbacks to short-circuit an auth route with a specific status. */
export class AuthRouteError extends Error {
  constructor(
    readonly status: 401 | 409 | 429,
    message?: string,
  ) {
    super(message);
    this.name = "AuthRouteError";
  }
}

/** Email/password credentials submitted to the register or authenticate endpoints. */
export interface AuthCredentials {
  email: string;
  password: string;
}
/** Configuration for {@link registerAuthRoutes}. */
export interface AuthRouteOptions<P extends Principal = Principal> {
  issuer: TokenIssuer<P>;
  cookie: CookieOptions & { name: string };
  principalSchema: Schema;
  register(context: ServerContext, credentials: AuthCredentials): P | Promise<P>;
  authenticate(context: ServerContext, credentials: AuthCredentials): P | null | Promise<P | null>;
  allowAttempt(
    context: ServerContext,
    operation: "register" | "authenticate",
    normalizedEmail: string,
  ): boolean | Promise<boolean>;
  revoke?(context: ServerContext): void | Promise<void>;
  redirect?: (
    context: ServerContext,
    operation: "register" | "authenticate",
    principal: P,
  ) => string | undefined;
}

function sameOrigin(context: ServerContext): boolean {
  const origin = context.headers.get("origin");
  return origin !== null && origin === context.url.origin;
}
async function credentials(context: ServerContext): Promise<AuthCredentials | Response> {
  const result = await readOperationInput(
    context,
    { body: { schema: credentialsSchema, mediaTypes: ["application/json"] } },
    true,
  );
  if (result.success) return result.data.body as AuthCredentials;
  return result.status === 400
    ? context.badRequest(result.detail)
    : context.problem(422, "Email or password is invalid.", {
        extensions: { issues: result.issues },
      });
}
function publicAuth(context: AuthContext): AuthContext {
  return {
    authenticated: context.authenticated,
    principal: context.principal,
    session: context.session,
    tenant: context.tenant,
    ...(context.scopes ? { scopes: context.scopes } : {}),
  };
}
function success<P extends Principal>(
  context: ServerContext,
  options: AuthRouteOptions<P>,
  operation: "register" | "authenticate",
  principal: P,
  status: 200 | 201,
): Promise<Response> {
  const { id, ...claims } = principal;
  return options.issuer.issue({ ...claims, subject: principal.subject ?? id }).then((token) => {
    const location = options.redirect?.(context, operation, principal);
    const accept = context.headers.get("accept");
    const response =
      location && accept && accepts(accept, "text/html")
        ? context.redirect(location, 303)
        : context.json({ authenticated: true, principal, session: null, tenant: null }, { status });
    const { name, ...configuredCookie } = options.cookie;
    const cookie = {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      ...configuredCookie,
      secure: configuredCookie.secure ?? true,
    };
    return context.setCookie(response, name, token, cookie);
  });
}

/**
 * Registers a standard set of authentication routes (`POST /auth/v1/accounts`,
 * `GET/POST /auth/v1/session`, `DELETE /auth/v1/session`) on an OpenAPI-style API/group,
 * handling registration, login, session lookup, and logout with CSRF protection via a
 * same-origin `Origin` header check, per-attempt rate limiting, and cookie-based token storage.
 *
 * @param api - The API or group to register routes on (only its `group` method is used).
 * @param options - Issuer, cookie configuration, principal schema, and register/authenticate/
 * allowAttempt/revoke/redirect callbacks.
 */
export function registerAuthRoutes<Dependencies, P extends Principal>(
  api: Pick<ApiDefinition<Dependencies>, "group">,
  options: AuthRouteOptions<P>,
): void {
  const successfulAuth = successfulAuthSchema(options.principalSchema);
  const group = api.group("/auth/v1").tags("Authentication");
  const mutation =
    (operation: "register" | "authenticate", status: 200 | 201) =>
    async (context: ServerContext) => {
      if (!sameOrigin(context))
        return context.forbidden("A same-origin Origin header is required.");
      const input = await credentials(context);
      if (input instanceof Response) return input;
      if (!(await options.allowAttempt(context, operation, input.email)))
        return context.tooManyRequests("Too many authentication attempts.");
      try {
        const principal =
          operation === "register"
            ? await options.register(context, input)
            : await options.authenticate(context, input);
        if (!principal) return context.unauthorized("Email or password is incorrect.");
        return success(context, options, operation, principal, status);
      } catch (error) {
        if (error instanceof AuthRouteError) return context.problem(error.status, error.message);
        throw error;
      }
    };
  group
    .post("/accounts", mutation("register", 201))
    .operationId("registerAccount")
    .summary("Register an account")
    .jsonBody(credentialsSchema, { required: true })
    .created(successfulAuth)
    .seeOther()
    .badRequest()
    .forbidden()
    .conflict()
    .unprocessableEntity()
    .tooManyRequests();
  group
    .get("/session", (context) => context.ok(publicAuth(context.auth)))
    .operationId("getAuthSession")
    .summary("Get the current authentication context")
    .ok(authSchema);
  group
    .post("/session", mutation("authenticate", 200))
    .operationId("createAuthSession")
    .summary("Create an authenticated session")
    .jsonBody(credentialsSchema, { required: true })
    .ok(successfulAuth)
    .seeOther()
    .badRequest()
    .unauthorized()
    .forbidden()
    .unprocessableEntity()
    .tooManyRequests();
  group
    .delete("/session", async (context) => {
      if (!sameOrigin(context))
        return context.forbidden("A same-origin Origin header is required.");
      await options.revoke?.(context);
      const { name, ...configuredCookie } = options.cookie;
      const cookie = {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        ...configuredCookie,
        secure: configuredCookie.secure ?? true,
      };
      return context.clearCookie(context.noContent(), name, cookie);
    })
    .operationId("deleteAuthSession")
    .summary("Delete the current authenticated session")
    .noContent()
    .forbidden();
}
