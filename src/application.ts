import type { Router, ServerApp, ServerAppOptions } from "./contracts";
import { BindingError } from "./binding";
import { anonymousAuthContext, createServerContext } from "./context";
import { createTerminal, runGlobalMiddleware } from "./dispatch";
import { problem } from "./http/responses";
import {
  configureRequestLimit,
  DEFAULT_MAX_REQUEST_BYTES,
  PayloadTooLargeError,
  rejectOversizedContentLength,
  validateMaxRequestBytes,
} from "./body-limit";
import { createMatcher, MalformedPathParameterError } from "./router/matcher";

function isRouter(value: Router | ServerAppOptions): value is Router {
  return "use" in value && "routes" in value;
}

export function createServerApp(router: Router): ServerApp;
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

  return {
    async fetch(request, dispatchOptions): Promise<Response> {
      const requestId = request.headers.get("x-request-id") ?? undefined;
      const execute = async (): Promise<Response> => {
        configureRequestLimit(request, applicationMaximum);
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
          const match = () => matcher.match(context.url.pathname, request.method);
          const found = options.telemetry
            ? options.telemetry.routeMatch(
                { requestId, traceId, route: context.url.pathname },
                match,
              )
            : match();
          context.params = found.match?.params ?? {};
          const maximum = found.match?.route.maxRequestBytes ?? applicationMaximum;
          configureRequestLimit(request, maximum);
          rejectOversizedContentLength(request, maximum);
          if (options.auth) {
            context.auth = await options.auth.resolve(request, { signal: request.signal });
          }
          const response = await runGlobalMiddleware(
            middleware,
            context,
            createTerminal(found, options),
          );
          return response;
        } catch (error) {
          let response: Response;
          if (error instanceof PayloadTooLargeError) {
            response = problem(413, error.message, { title: "Payload Too Large" });
          } else if (error instanceof MalformedPathParameterError) {
            response = problem(400, error.message);
          } else if (error instanceof BindingError) {
            response = problem(error.status, error.message, {
              extensions: error.field ? { field: error.field } : undefined,
            });
          } else if (options.onError) {
            response = await options.onError(error, context);
          } else {
            response = problem(500);
          }
          return response;
        }
      };
      const instrumented = () =>
        options.telemetry ? options.telemetry.request({ requestId }, execute) : execute();
      if (options.telemetry?.extract && options.telemetry.withContext) {
        const extracted = options.telemetry.extract(request.headers, {
          keys: (headers) => [...headers.keys()],
          get: (headers, key) => headers.get(key) ?? undefined,
        });
        return options.telemetry.withContext(extracted, instrumented);
      }
      return instrumented();
    },
  };
}
