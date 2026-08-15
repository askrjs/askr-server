import type { Router, ServerApp, ServerAppOptions, ServerContext } from "./contracts";
import { BindingError } from "./binding";
import { anonymousAuthContext, createServerContext } from "./context";
import { dispatchRequest } from "./dispatch";
import { problem } from "./http/responses";
import {
  configureRequestLimit,
  DEFAULT_MAX_REQUEST_BYTES,
  PayloadTooLargeError,
  rejectOversizedContentLength,
  validateMaxRequestBytes,
} from "./body-limit";
import { createMatcher, MalformedPathParameterError } from "./router/matcher";

const telemetryHeaders = {
  keys: (headers: Headers): string[] => [...headers.keys()],
  get: (headers: Headers, key: string): string | undefined => headers.get(key) ?? undefined,
};

function isRouter(value: Router | ServerAppOptions): value is Router {
  return "use" in value && "routes" in value;
}

/**
 * Creates a transport-neutral server application that dispatches Web `Request`s to a
 * router's routes and middleware, returning Web `Response`s.
 *
 * Accepts either a bare {@link Router} or a full {@link ServerAppOptions} object (which
 * may itself reference a router). Builds a path matcher from the combined routes, validates
 * request-size limits, and wraps dispatch with auth resolution, telemetry, and error handling
 * (payload-too-large, malformed path parameters, binding errors, and a fallback `onError`).
 *
 * @param router - A router whose routes and middleware should back the application.
 * @returns A {@link ServerApp} exposing a `fetch(request, dispatchOptions)` method.
 * @example
 * const app = createServerApp(router);
 * export default { fetch: app.fetch };
 */
export function createServerApp(router: Router): ServerApp;
/**
 * Creates a transport-neutral server application. See the {@link Router} overload for details.
 *
 * @param options - Configuration including router, routes, middleware, auth, telemetry,
 * error handling, and request-size limits.
 * @returns A {@link ServerApp} exposing a `fetch(request, dispatchOptions)` method.
 */
export function createServerApp(options?: ServerAppOptions): ServerApp;
export function createServerApp(input: Router | ServerAppOptions = {}): ServerApp {
  const options: ServerAppOptions = isRouter(input) ? { router: input } : input;
  const routes = options.routes ?? options.router?.routes ?? [];
  const middleware = [...(options.router?.middleware ?? []), ...(options.middleware ?? [])];
  const matcher = createMatcher(routes);
  const applicationMaximum = validateMaxRequestBytes(
    options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
  );
  for (const route of routes)
    if (route.maxRequestBytes !== undefined)
      validateMaxRequestBytes(route.maxRequestBytes, "ApiRouteOptions.maxRequestBytes");

  const errorResponse = (
    error: unknown,
    context: ServerContext,
  ): Response | Promise<Response> => {
    if (error instanceof PayloadTooLargeError) {
      return problem(413, error.message, { title: "Payload Too Large" });
    }
    if (error instanceof MalformedPathParameterError) return problem(400, error.message);
    if (error instanceof BindingError) {
      return problem(error.status, error.message, {
        extensions: error.field ? { field: error.field } : undefined,
      });
    }
    if (options.onError) return options.onError(error, context);
    return problem(500);
  };

  const execute = async (
    request: Request,
    dispatchOptions: Parameters<ServerApp["fetch"]>[1],
    requestId: string | undefined,
  ): Promise<Response> => {
    if (applicationMaximum !== DEFAULT_MAX_REQUEST_BYTES) {
      configureRequestLimit(request, applicationMaximum);
    }
    const context = createServerContext(
      request,
      anonymousAuthContext(),
      options,
      dispatchOptions?.websocket,
    );
    const traceId = options.telemetry?.traceId();
    if (requestId) context.state.requestId = requestId;
    if (traceId) context.state.traceId = traceId;
    try {
      const found = options.telemetry
        ? options.telemetry.routeMatch({ requestId, traceId }, () =>
            matcher.match(context.url.pathname, request.method, context.params),
          )
        : matcher.match(context.url.pathname, request.method, context.params);
      context.params = found.match?.params ?? {};
      const maximum = found.match?.route.maxRequestBytes ?? applicationMaximum;
      if (maximum !== applicationMaximum) configureRequestLimit(request, maximum);
      rejectOversizedContentLength(request, maximum);
      if (options.auth) {
        context.auth = await options.auth.resolve(request, { signal: request.signal });
      }
      return await dispatchRequest(middleware, context, found, {
        ...options,
        errorResponse,
      });
    } catch (error) {
      return errorResponse(error, context);
    }
  };

  return {
    async fetch(request, dispatchOptions): Promise<Response> {
      const requestId = request.headers.get("x-request-id") ?? undefined;
      if (!options.telemetry) return execute(request, dispatchOptions, requestId);
      const instrumented = () =>
        options.telemetry!.request({ requestId }, () =>
          execute(request, dispatchOptions, requestId),
        );
      if (options.telemetry?.extract && options.telemetry.withContext) {
        const extracted = options.telemetry.extract(request.headers, telemetryHeaders);
        return options.telemetry.withContext(extracted, instrumented);
      }
      return instrumented();
    },
  };
}
