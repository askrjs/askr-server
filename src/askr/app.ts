import type { AuthResolver, Principal } from "@askrjs/auth";
import { createProviderSession, type ProviderSessionOptions } from "@askrjs/auth/server";
import type { RouteAuthOptions, RouteRegistry } from "@askrjs/askr/router";
import type { ServerQueryRegistry } from "@askrjs/askr/data";
import { createServerApp } from "../application";
import { registerAuthRoutes, type AuthRouteOptions } from "../auth";
import type {
  Middleware,
  ProbeOptions,
  Router,
  ServerAppOptions,
  ServerTelemetry,
} from "../contracts";
import { createApi } from "../openapi/api";
import type { ApiDefinition, ApiGroup } from "../openapi/public";
import type { OpenApiDocument, SecurityScheme } from "../openapi/types";
import {
  defineServerActions,
  type ActionRegistration,
  type ActionRegistryOptions,
} from "./actions";
import { createAskrPageHandler } from "./page-handler";
import type { CspNonceProvider } from "../csp-nonce";
import { parseRoutePath } from "../router/path";
import { providerSnapshot } from "../auth/provider-snapshot";
import { providerErrorResponse } from "../auth/provider-errors";
import {
  oversizedProviderCallback,
  providerCsrfResponse,
  registerProviderRoutes,
} from "../auth/provider-routes";
import { problem } from "../http/responses";

/** A configured Askr application, as returned by {@link createAskrApp}. */
export interface AskrApp {
  fetch(request: Request): Promise<Response>;
  toOpenApiDocument(): OpenApiDocument;
  close(): Promise<void>;
}

/** The API group passed to {@link AskrAppApiOptions.define}, extended with a `schema` helper. */
export interface AskrAppApi<Dependencies> extends ApiGroup<Dependencies> {
  schema: ApiDefinition<Dependencies>["schema"];
}

/** Options for the OpenAPI-backed API portion of an {@link AskrApp}. */
export interface AskrAppApiOptions<Dependencies> {
  readonly prefix?: string;
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>;
  readonly define?: (api: AskrAppApi<Dependencies>) => void;
  readonly validateResponses?: boolean;
}

interface ManualAuthOptions<P extends Principal> {
  readonly resolver: AuthResolver;
  readonly routes?: AuthRouteOptions<P>;
  readonly pages?: RouteAuthOptions;
  readonly providers?: never;
  readonly session?: never;
  readonly origin?: never;
  readonly onSignIn?: never;
  readonly postLogoutRedirects?: never;
  readonly transactionTtlSeconds?: never;
  readonly fetch?: never;
  readonly clock?: never;
}

/** Choose one provider session or an application-owned manual auth resolver. */
export type AskrAppAuthOptions<P extends Principal> =
  | ManualAuthOptions<P>
  | (ProviderSessionOptions & {
      readonly resolver?: never;
      readonly routes?: never;
      readonly pages?: never;
    });

/** Options for {@link createAskrApp}. */
export interface AskrAppOptions<Dependencies, P extends Principal = Principal> {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Dependencies;
  readonly pages: RouteRegistry;
  readonly queryRegistry?: ServerQueryRegistry;
  readonly api?: AskrAppApiOptions<Dependencies>;
  readonly actions?: ActionRegistryOptions & {
    readonly handlers: readonly ActionRegistration<Dependencies>[];
  };
  readonly auth?: AskrAppAuthOptions<P>;
  readonly middleware?: readonly Middleware[];
  readonly probes?: ProbeOptions;
  readonly telemetry?: ServerTelemetry;
  readonly onError?: ServerAppOptions["onError"];
  readonly onAccessDenied?: ServerAppOptions["onAccessDenied"];
  readonly close?: (dependencies: Dependencies) => void | Promise<void>;
  readonly cspNonce?: CspNonceProvider;
}

function normalizePrefix(value: string | undefined): string {
  const prefix = value ?? "/api";
  if (!prefix.startsWith("/") || prefix === "/" || prefix.endsWith("/")) {
    throw new Error("The API prefix must be an absolute path without a trailing slash.");
  }
  const segments = parseRoutePath(prefix);
  if (segments.some((segment) => segment.kind !== "static")) {
    throw new Error("The API prefix must contain only static path segments.");
  }
  return prefix;
}

/**
 * Assembles a complete Askr application from page routes, an optional OpenAPI-described API,
 * optional server actions, and optional authentication — wiring an API router (mounted at
 * `options.api?.prefix`, default `/api`), auth routes, and a page-rendering fallback handler
 * into a single {@link ServerApp}-like object.
 *
 * @param options - Pages registry, dependencies, API/auth/action configuration, and lifecycle hooks.
 * @returns An {@link AskrApp} exposing `fetch`, `toOpenApiDocument`, and `close`.
 * @throws {Error} If `options.api.prefix` is invalid, or collides with the reserved `/auth` prefix.
 */
export function createAskrApp<Dependencies, P extends Principal = Principal>(
  options: AskrAppOptions<Dependencies, P>,
): AskrApp {
  const prefix = normalizePrefix(options.api?.prefix);
  const auth = options.auth;
  if (auth !== undefined && (!auth || typeof auth !== "object")) {
    throw new Error("Auth configuration must be a provider session or manual resolver object.");
  }
  const providerMode = auth !== undefined && "providers" in auth;
  const providerFields = [
    "providers",
    "session",
    "origin",
    "onSignIn",
    "postLogoutRedirects",
    "transactionTtlSeconds",
    "fetch",
    "clock",
  ];
  if (
    auth &&
    (providerMode
      ? ["resolver", "routes", "pages"].some((name) => name in auth)
      : providerFields.some((name) => name in auth) || typeof auth.resolver?.resolve !== "function")
  ) {
    throw new Error("Choose provider session configuration or manual auth; do not combine them.");
  }
  const manual = !providerMode ? (auth as ManualAuthOptions<P> | undefined) : undefined;
  const providerOptions = providerMode ? (auth as ProviderSessionOptions) : undefined;
  if ((providerMode || manual?.routes) && (prefix === "/auth" || prefix.startsWith("/auth/"))) {
    throw new Error("The API prefix collides with the reserved /auth route prefix.");
  }
  const api = createApi<Dependencies>({
    info: { title: options.name, version: options.version },
    securitySchemes: options.api?.securitySchemes,
    validateResponses: options.api?.validateResponses,
  });
  const applicationApi = Object.assign(api.group(prefix), {
    schema: api.schema,
  }) as AskrAppApi<Dependencies>;
  options.api?.define?.(applicationApi);
  const provider = providerOptions ? createProviderSession(providerOptions) : undefined;
  const providers = providerOptions ? [...providerOptions.providers] : [];
  if (provider && providerOptions)
    registerProviderRoutes(api, provider, { ...providerOptions, providers });
  if (manual?.routes) registerAuthRoutes(api, manual.routes);
  const actions = options.actions
    ? defineServerActions(
        { dependencies: options.dependencies, csrf: options.actions.csrf },
        ...options.actions.handlers,
      )
    : undefined;
  const router = (api.createRouter as (dependencies: Dependencies) => Router)(options.dependencies);
  router.get(`${prefix}/*`, (context) => context.notFound("API route not found"));
  const pages = createAskrPageHandler({
    registry: options.pages,
    auth: provider
      ? { loginPath: "/login", ...options.pages.manifest.auth, dehydrate: providerSnapshot }
      : manual?.pages,
    queryRegistry: options.queryRegistry,
    actions,
    cspNonce: options.cspNonce,
  });
  const server = createServerApp({
    router,
    auth:
      provider ??
      (manual
        ? { resolve: (request, context) => manual.resolver.resolve(request, context) }
        : undefined),
    middleware: options.middleware,
    probes: options.probes,
    telemetry: options.telemetry,
    onError: provider
      ? (error, context) =>
          providerErrorResponse(error, providers) ??
          options.onError?.(error, context) ??
          problem(500)
      : options.onError,
    onAccessDenied: options.onAccessDenied,
    fallback: (context) =>
      provider && (context.url.pathname === "/auth" || context.url.pathname.startsWith("/auth/"))
        ? context.notFound()
        : pages(context),
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    fetch: async (request: Request) => {
      if (!provider || !providerOptions) return server.fetch(request);
      let response: Response;
      try {
        const callback = oversizedProviderCallback(request, providers);
        response =
          providerCsrfResponse(request, providerOptions.origin, providers) ??
          (callback === undefined
            ? await server.fetch(request)
            : await provider.callback(request, { provider: callback }));
      } catch (error) {
        response = providerErrorResponse(error, providers) ?? problem(500);
      }
      try {
        return await provider.finalize(request, response);
      } catch (error) {
        return providerErrorResponse(error, providers) ?? problem(500);
      }
    },
    toOpenApiDocument: () => api.toOpenApiDocument(),
    close: () =>
      (closing ??= Promise.resolve().then(async () => {
        try {
          await options.close?.(options.dependencies);
        } finally {
          await provider?.close();
        }
      })),
  });
}
