import type { ApiDefinition } from "../openapi/public";
import type { ServerContext } from "../contracts";
import { readRequestText } from "../body-limit";
import { contentType } from "../http/media-types";
import { forbidden } from "../http/responses";
import { providerSnapshot } from "./provider-snapshot";
import { safeRedirect } from "./routes";

interface ProviderRouteDefinition {
  readonly id: string;
  readonly responseMode: "query" | "form_post";
}
interface LogoutOptions {
  readonly provider?: string;
  readonly providerLogout?: boolean;
  readonly returnTo?: string;
  readonly revoke?: boolean;
}
interface ProviderRouteEngine {
  login(
    request: Request,
    options: {
      readonly provider: string;
      readonly returnTo: string;
      readonly resource?: string;
      readonly scopes?: readonly string[];
    },
  ): Promise<Response>;
  callback(request: Request, options: { readonly provider: string }): Promise<Response>;
  logout(request: Request, options?: LogoutOptions): Promise<Response>;
}

const returnTo = safeRedirect("/", { allowHash: true });
const logoutFields = new Set(["provider", "providerLogout", "returnTo", "revoke"]);

async function logoutOptions(context: ServerContext): Promise<LogoutOptions | Response> {
  if (context.request.body === null) return {};
  if (contentType(context.headers.get("content-type")) !== "application/json") {
    return context.badRequest("Provider logout requires a JSON object.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readRequestText(context.request));
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 413)
      throw error;
    return context.badRequest("The provider logout request is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return context.badRequest("The provider logout request is invalid.");
  }
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).some((name) => !logoutFields.has(name)) ||
    (fields.provider !== undefined &&
      (typeof fields.provider !== "string" || fields.provider.length > 128)) ||
    (fields.returnTo !== undefined &&
      (typeof fields.returnTo !== "string" || fields.returnTo.length > 4096)) ||
    (fields.providerLogout !== undefined && typeof fields.providerLogout !== "boolean") ||
    (fields.revoke !== undefined && typeof fields.revoke !== "boolean")
  ) {
    return context.badRequest("The provider logout request is invalid.");
  }
  return fields as LogoutOptions;
}

/** Protect cookie-authenticated mutations before auth resolution or application dispatch. */
export function providerCsrfResponse(
  request: Request,
  origin: string,
  providers: readonly ProviderRouteDefinition[],
): Response | undefined {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const path = new URL(request.url).pathname;
  if (
    request.method === "POST" &&
    providers.some(
      (provider) =>
        provider.responseMode === "form_post" && path === `/auth/callback/${provider.id}`,
    )
  )
    return;
  if (!/(?:^|;)\s*__Host-askr-session=/.test(request.headers.get("cookie") ?? "")) return;
  if (request.headers.get("origin") !== origin)
    return forbidden("A same-origin Origin header is required.");
}

/** Let the transaction owner consume rejected ingress before the generic header preflight. */
export function oversizedProviderCallback(
  request: Request,
  providers: readonly ProviderRouteDefinition[],
): string | undefined {
  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 32768) return;
  const path = new URL(request.url).pathname;
  return providers.find(
    (provider) =>
      path === `/auth/callback/${provider.id}` &&
      request.method === (provider.responseMode === "form_post" ? "POST" : "GET"),
  )?.id;
}

/** Internal provider routes; credential/password routes retain their existing owner. */
export function registerProviderRoutes<Dependencies>(
  api: Pick<ApiDefinition<Dependencies>, "group">,
  engine: ProviderRouteEngine,
  options: { readonly origin: string; readonly providers: readonly ProviderRouteDefinition[] },
): void {
  const group = api.group("/auth").tags("Authentication");
  for (const provider of options.providers) {
    group
      .get(`/login/${provider.id}`, (context) => {
        if (context.request.method !== "GET") return context.methodNotAllowed(["GET"]);
        const query = context.query;
        const scopes = query.getAll("scope");
        if (
          [...query.keys()].some((name) => !["returnTo", "resource", "scope"].includes(name)) ||
          query.getAll("returnTo").length > 1 ||
          query.getAll("resource").length > 1 ||
          (query.get("returnTo")?.length ?? 0) > 4096 ||
          (query.get("resource")?.length ?? 0) > 2048 ||
          scopes.length > 128 ||
          scopes.some((scope) => scope.length === 0 || scope.length > 512)
        ) {
          return context.badRequest("The provider login request is invalid.");
        }
        return engine.login(context.request, {
          provider: provider.id,
          returnTo: returnTo(query.get("returnTo")),
          ...(query.has("resource") ? { resource: query.get("resource")! } : {}),
          ...(scopes.length ? { scopes } : {}),
        });
      })
      .operationId(`${provider.id}ProviderLogin`)
      .summary("Start provider sign-in")
      .seeOther()
      .badRequest();
    const method = provider.responseMode === "form_post" ? "POST" : "GET";
    const callback = (context: ServerContext) =>
      context.request.method === method
        ? engine.callback(context.request, { provider: provider.id })
        : context.methodNotAllowed([method]);
    (method === "POST"
      ? group.post(`/callback/${provider.id}`, callback)
      : group.get(`/callback/${provider.id}`, callback)
    )
      .maxRequestBytes(32768)
      .operationId(`${provider.id}ProviderCallback`)
      .summary("Complete provider sign-in")
      .seeOther()
      .badRequest();
  }
  group
    .get("/session", (context) =>
      context.ok(providerSnapshot(context.auth), {
        headers: { "cache-control": "no-store" },
      }),
    )
    .operationId("getProviderSession")
    .summary("Get the current provider identity")
    .ok();
  group
    .post("/logout", async (context) => {
      if (context.headers.get("origin") !== options.origin)
        return context.forbidden("A same-origin Origin header is required.");
      const input = await logoutOptions(context);
      return input instanceof Response ? input : engine.logout(context.request, input);
    })
    .maxRequestBytes(32768)
    .operationId("deleteProviderSession")
    .summary("End the provider session")
    .noContent()
    .seeOther()
    .badRequest()
    .forbidden();
}
