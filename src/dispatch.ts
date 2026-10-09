import type { AuthDecision } from "@askrjs/auth";
import type {
  ApiRoute,
  AccessDeniedHandler,
  Handler,
  Middleware,
  ProbeHandler,
  ProbeOptions,
  ServerContext,
} from "./contracts";
import { challenge, forbidden, methodNotAllowed, notFound } from "./http/responses";
import type { MatchResult } from "./router/matcher";
import { discardResponseBody } from "./response-body";

export class MiddlewareNextError extends Error {
  readonly code = "middleware_next_reused";

  constructor() {
    super("next() may only be called once while its middleware invocation is running");
    this.name = "MiddlewareNextError";
  }
}

export class MiddlewareResponseError extends TypeError {
  readonly code = "middleware_response_invalid";

  constructor() {
    super("Middleware must return a Response or the result of next()");
    this.name = "MiddlewareResponseError";
  }
}

function discardDownstream(pending: Promise<Response> | undefined, returned?: Response): void {
  void pending?.then(
    (response) => {
      if (response instanceof Response && response !== returned && response.body !== returned?.body)
        discardResponseBody(response);
    },
    () => {
      // The middleware/terminal error path owns this rejection.
    },
  );
}

function runMiddleware(
  middleware: readonly Middleware[],
  context: ServerContext,
  terminal: Handler,
  onError?: (error: unknown, context: ServerContext) => Response | Promise<Response>,
): Promise<Response> {
  const dispatch = async (nextIndex: number): Promise<Response> => {
    let active = true;
    let downstream: Promise<Response> | undefined;
    try {
      const current = middleware[nextIndex];
      if (!current) return await terminal(context);
      const result = current(context, () => {
        if (!active || downstream) throw new MiddlewareNextError();
        downstream = dispatch(nextIndex + 1);
        void downstream.catch(() => undefined);
        return downstream;
      });
      // A synchronous short circuit retires next() before queued microtasks can call it.
      if (result instanceof Response) active = false;
      const response = await result;
      if (!(response instanceof Response)) throw new MiddlewareResponseError();
      discardDownstream(downstream, response);
      return response;
    } catch (error) {
      discardDownstream(downstream);
      if (onError) return onError(error, context);
      throw error;
    } finally {
      active = false;
    }
  };
  return dispatch(0);
}

async function denial(
  decision: AuthDecision,
  context: ServerContext,
  onAccessDenied?: AccessDeniedHandler,
): Promise<Response | undefined> {
  if (decision.allowed) return undefined;
  if (onAccessDenied) {
    const response = await onAccessDenied(decision, context);
    if (!(response instanceof Response))
      throw new TypeError("The access denial handler must return a Response");
    return response;
  }
  return decision.reason === "unauthenticated"
    ? challenge()
    : forbidden(decision.reason === "already_authenticated" ? "Already authenticated" : undefined);
}

function invokeRoute(route: ApiRoute, context: ServerContext): Response | Promise<Response> {
  return route.upgrade ? context.upgrade(route.upgrade) : route.handler(context);
}

async function executeAuthorizedRoute(
  route: ApiRoute,
  context: ServerContext,
  onAccessDenied?: AccessDeniedHandler,
): Promise<Response> {
  const response = await denial(await route.auth!(context.auth), context, onAccessDenied);
  if (response) return response;
  const middleware = route.middleware;
  return middleware?.length
    ? runMiddleware(middleware, context, () => invokeRoute(route, context))
    : invokeRoute(route, context);
}

function executeRoute(
  route: ApiRoute,
  context: ServerContext,
  onAccessDenied?: AccessDeniedHandler,
): Response | Promise<Response> {
  if (route.auth) return executeAuthorizedRoute(route, context, onAccessDenied);
  const middleware = route.middleware;
  return middleware?.length
    ? runMiddleware(middleware, context, () => invokeRoute(route, context))
    : invokeRoute(route, context);
}

function probeFor(pathname: string, probes?: ProbeOptions): ProbeHandler | undefined {
  if (pathname === "/livez") return probes?.livez;
  if (pathname === "/readyz") return probes?.readyz;
  if (pathname === "/startupz") return probes?.startupz;
  if (pathname === "/targetz") return probes?.targetz;
  return undefined;
}

async function runProbe(
  handler: ProbeHandler | undefined,
  context: ServerContext,
): Promise<Response> {
  try {
    const result = handler ? await handler(context) : undefined;
    if (result instanceof Response) return result;
    if (result !== undefined && typeof result !== "boolean")
      throw new TypeError("A probe must return a boolean, Response, or undefined");
    return new Response(null, {
      status: result === false ? 503 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

function withoutHeadBody(response: Response, request: Request): Response {
  if (request.method === "HEAD") discardResponseBody(response);
  return request.method === "HEAD"
    ? new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    : response;
}

function executeTerminal(
  found: MatchResult,
  options: { probes?: ProbeOptions; fallback?: Handler; onAccessDenied?: AccessDeniedHandler },
  context: ServerContext,
): Response | Promise<Response> {
  if (found.match) return executeRoute(found.match.route, context, options.onAccessDenied);
  if (found.allowed.length) {
    return context.request.method === "OPTIONS"
      ? new Response(null, { status: 204, headers: { allow: found.allowed.join(", ") } })
      : methodNotAllowed(found.allowed);
  }
  if (
    (context.request.method === "GET" || context.request.method === "HEAD") &&
    (context.url.pathname === "/livez" ||
      context.url.pathname === "/readyz" ||
      context.url.pathname === "/startupz" ||
      context.url.pathname === "/targetz")
  ) {
    return runProbe(probeFor(context.url.pathname, options.probes), context);
  }
  return options.fallback ? options.fallback(context) : notFound();
}

export async function dispatchRequest(
  middleware: readonly Middleware[],
  context: ServerContext,
  found: MatchResult,
  options: {
    probes?: ProbeOptions;
    fallback?: Handler;
    onAccessDenied?: AccessDeniedHandler;
    errorResponse: (error: unknown, context: ServerContext) => Response | Promise<Response>;
  },
): Promise<Response> {
  const terminal = async (): Promise<Response> => {
    try {
      const response = await executeTerminal(found, options, context);
      if (!(response instanceof Response))
        throw new TypeError("A route or fallback handler must return a Response");
      return response;
    } catch (error) {
      return options.errorResponse(error, context);
    }
  };
  const response = await (middleware.length
    ? runMiddleware(middleware, context, terminal, options.errorResponse)
    : terminal());
  return withoutHeadBody(response, context.request);
}
