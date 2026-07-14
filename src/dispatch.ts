import type { AuthDecision } from "@askrjs/auth";
import type {
  ApiRoute,
  Handler,
  Middleware,
  ProbeHandler,
  ProbeOptions,
  ServerContext,
} from "./contracts";
import { challenge, forbidden, methodNotAllowed, notFound } from "./http/responses";
import type { MatchResult } from "./router/matcher";

async function runMiddleware(
  middleware: readonly Middleware[],
  context: ServerContext,
  terminal: Handler,
): Promise<Response> {
  let index = -1;
  const dispatch = async (nextIndex: number): Promise<Response> => {
    if (nextIndex <= index) throw new Error("next() may only be called once per middleware invocation");
    index = nextIndex;
    const current = middleware[nextIndex];
    return current ? current(context, () => dispatch(nextIndex + 1)) : terminal(context);
  };
  return dispatch(0);
}

function denial(decision: AuthDecision): Response | undefined {
  if (decision.allowed) return undefined;
  return decision.reason === "unauthenticated"
    ? challenge()
    : forbidden(decision.reason === "already_authenticated" ? "Already authenticated" : undefined);
}

async function executeRoute(route: ApiRoute, context: ServerContext): Promise<Response> {
  if (route.auth) {
    const response = denial(await route.auth(context.auth));
    if (response) return response;
  }
  return runMiddleware(route.middleware ?? [], context, async () =>
    route.upgrade ? context.upgrade(route.upgrade) : route.handler(context));
}

function probeFor(pathname: string, probes?: ProbeOptions): ProbeHandler | undefined {
  if (pathname === "/livez") return probes?.livez;
  if (pathname === "/readyz") return probes?.readyz;
  if (pathname === "/startupz") return probes?.startupz;
  if (pathname === "/targetz") return probes?.targetz;
  return undefined;
}

function isProbe(pathname: string): boolean {
  return ["/livez", "/readyz", "/startupz", "/targetz"].includes(pathname);
}

async function runProbe(handler: ProbeHandler | undefined, context: ServerContext): Promise<Response> {
  try {
    const result = handler ? await handler(context) : undefined;
    if (result instanceof Response) return result;
    return new Response(null, {
      status: result === false ? 503 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

function withoutHeadBody(response: Response, request: Request): Response {
  return request.method === "HEAD"
    ? new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    : response;
}

export function createTerminal(
  found: MatchResult,
  options: { probes?: ProbeOptions; fallback?: Handler },
): Handler {
  return async (context) => {
    let response: Response;
    if (found.match) {
      response = await executeRoute(found.match.route, context);
    } else if (found.allowed.length) {
      response = context.request.method === "OPTIONS"
        ? new Response(null, { status: 204, headers: { allow: found.allowed.join(", ") } })
        : methodNotAllowed(found.allowed);
    } else if (
      (context.request.method === "GET" || context.request.method === "HEAD") &&
      isProbe(context.url.pathname)
    ) {
      response = await runProbe(probeFor(context.url.pathname, options.probes), context);
    } else {
      response = options.fallback ? await options.fallback(context) : notFound();
    }
    return withoutHeadBody(response, context.request);
  };
}

export function runGlobalMiddleware(
  middleware: readonly Middleware[],
  context: ServerContext,
  terminal: Handler,
): Promise<Response> {
  return runMiddleware(middleware, context, terminal);
}
