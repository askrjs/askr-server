import type { AuthContext, Principal } from "@askrjs/auth";
interface TokenIssuer<P extends Principal> {
  issue(principal: Omit<P, "id"> & { subject: string }): Promise<string>;
}
import type { CookieOptions, ServerContext } from "./contracts";
import type { ApiDefinition } from "./openapi/public";
import type { Schema } from "./openapi/types";

export interface SafeRedirectOptions {
  readonly allowHash?: boolean;
}

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

export class AuthRouteError extends Error {
  constructor(
    readonly status: 401 | 409 | 429,
    message?: string,
  ) {
    super(message);
  }
}

export interface AuthCredentials {
  email: string;
  password: string;
}
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
  redirect?: (
    context: ServerContext,
    operation: "register" | "authenticate",
    principal: P,
  ) => string | undefined;
}

const credentialsSchema: Schema = {
  jsonSchema: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email" },
      password: { type: "string", minLength: 4, maxLength: 128 },
    },
    additionalProperties: false,
  },
  safeParse(value) {
    const body = value as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const issues: Array<{ path: string[]; message: string; code: string }> = [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      issues.push({ path: ["email"], message: "Email is invalid.", code: "invalid_email" });
    if (password.length < 4 || password.length > 128)
      issues.push({
        path: ["password"],
        message: "Password must be between 4 and 128 characters.",
        code: "invalid_length",
      });
    return issues.length
      ? { success: false, issues }
      : { success: true, data: { email, password } };
  },
};
const authSchema: Schema = {
  jsonSchema: { type: "object" },
  safeParse: (data) => ({ success: true, data }),
};

function sameOrigin(context: ServerContext): boolean {
  const origin = context.headers.get("origin");
  return origin !== null && origin === context.url.origin;
}
async function credentials(context: ServerContext): Promise<AuthCredentials | Response> {
  let value: unknown;
  try {
    value = await context.bind();
  } catch {
    return context.unprocessableEntity("Email and password are required.");
  }
  const parsed = credentialsSchema.safeParse(value);
  return parsed.success
    ? (parsed.data as AuthCredentials)
    : context.problem(422, "Email or password is invalid.", {
        extensions: { issues: parsed.issues },
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
  return options.issuer
    .issue({ ...principal, subject: principal.subject ?? principal.id })
    .then((token) => {
      const location = options.redirect?.(context, operation, principal);
      const response =
        location && context.headers.get("accept")?.includes("text/html")
          ? context.redirect(location, 303)
          : context.json(
              { authenticated: true, principal, session: null, tenant: null },
              { status },
            );
      const { name, ...configuredCookie } = options.cookie;
      const cookie = {
        ...configuredCookie,
        secure: configuredCookie.secure ?? context.url.protocol === "https:",
      };
      return context.setCookie(response, name, token, cookie);
    });
}

export function registerAuthRoutes<Dependencies, P extends Principal>(
  api: Pick<ApiDefinition<Dependencies>, "group">,
  options: AuthRouteOptions<P>,
): void {
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
    .created(options.principalSchema)
    .seeOther()
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
    .ok(options.principalSchema)
    .seeOther()
    .unauthorized()
    .forbidden()
    .unprocessableEntity()
    .tooManyRequests();
  group
    .delete("/session", (context) => {
      if (!sameOrigin(context))
        return context.forbidden("A same-origin Origin header is required.");
      const { name, ...configuredCookie } = options.cookie;
      const cookie = {
        ...configuredCookie,
        secure: configuredCookie.secure ?? context.url.protocol === "https:",
      };
      return context.clearCookie(context.noContent(), name, cookie);
    })
    .operationId("deleteAuthSession")
    .summary("Delete the current authenticated session")
    .noContent()
    .forbidden();
}
