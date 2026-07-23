import type { AuthResolver, Principal } from "@askrjs/auth";
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
import { defineServerActions, type ActionEntry, type ActionRegistryOptions } from "./actions";
import { createAskrPageHandler } from "./page-handler";
import type { CspNonceProvider } from "../csp-nonce";

export interface AskrApp {
  fetch(request: Request): Promise<Response>;
  toOpenApiDocument(): OpenApiDocument;
  close(): Promise<void>;
}

export interface AskrAppApi<Dependencies> extends ApiGroup<Dependencies> {
  schema: ApiDefinition<Dependencies>["schema"];
}

export interface AskrAppApiOptions<Dependencies> {
  readonly prefix?: string;
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>;
  readonly define?: (api: AskrAppApi<Dependencies>) => void;
  readonly validateResponses?: boolean;
}

export interface AskrAppAuthOptions<P extends Principal> {
  readonly resolver: AuthResolver;
  readonly routes?: AuthRouteOptions<P>;
  readonly pages?: RouteAuthOptions;
}

export interface AskrAppOptions<Dependencies, P extends Principal = Principal> {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Dependencies;
  readonly pages: RouteRegistry;
  readonly queryRegistry?: ServerQueryRegistry;
  readonly api?: AskrAppApiOptions<Dependencies>;
  readonly actions?: ActionRegistryOptions & {
    readonly handlers: readonly ActionEntry<Dependencies, any, any>[];
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
  return prefix;
}

export function createAskrApp<Dependencies, P extends Principal = Principal>(
  options: AskrAppOptions<Dependencies, P>,
): AskrApp {
  const prefix = normalizePrefix(options.api?.prefix);
  if (options.auth?.routes && (prefix === "/auth" || prefix.startsWith("/auth/"))) {
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
  if (options.auth?.routes) registerAuthRoutes(api, options.auth.routes);
  const actions = options.actions
    ? defineServerActions(
        { dependencies: options.dependencies, csrf: options.actions.csrf },
        ...options.actions.handlers,
      )
    : undefined;
  const router = (api.createRouter as (dependencies: Dependencies) => Router)(options.dependencies);
  router.get(`${prefix}/*`, (context) => context.notFound("API route not found"));
  const server = createServerApp({
    router,
    auth: options.auth?.resolver,
    middleware: options.middleware,
    probes: options.probes,
    telemetry: options.telemetry,
    onError: options.onError,
    onAccessDenied: options.onAccessDenied,
    fallback: createAskrPageHandler({
      registry: options.pages,
      auth: options.auth?.pages,
      queryRegistry: options.queryRegistry,
      actions,
      cspNonce: options.cspNonce,
    }),
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    fetch: (request: Request) => server.fetch(request),
    toOpenApiDocument: () => api.toOpenApiDocument(),
    close: () => (closing ??= Promise.resolve(options.close?.(options.dependencies))),
  });
}
