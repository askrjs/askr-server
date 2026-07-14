import type { Router, ServerApp, ServerAppOptions } from "./contracts";
import { BindingError } from "./binding";
import { anonymousAuthContext, createServerContext } from "./context";
import { createTerminal, runGlobalMiddleware } from "./dispatch";
import { problem } from "./http/responses";
import { createMatcher } from "./router/matcher";

function isRouter(value: Router | ServerAppOptions): value is Router {
  return "use" in value && "routes" in value;
}

export function createServerApp(router: Router): ServerApp;
export function createServerApp(options?: ServerAppOptions): ServerApp;
export function createServerApp(input: Router | ServerAppOptions = {}): ServerApp {
  const options: ServerAppOptions = isRouter(input) ? { router: input } : input;
  const routes = options.routes ?? options.router?.routes ?? [];
  const middleware = [...(options.router?.middleware ?? []), ...(options.middleware ?? [])];
  const match = createMatcher(routes);

  return {
    async fetch(request): Promise<Response> {
      const context = createServerContext(request, anonymousAuthContext(), options);
      const found = match(request);
      context.params = found.match?.params ?? {};
      try {
        if (options.auth) {
          context.auth = await options.auth.resolve(request, { signal: request.signal });
        }
        return await runGlobalMiddleware(
          middleware,
          context,
          createTerminal(found, options),
        );
      } catch (error) {
        if (error instanceof BindingError) {
          return problem(error.status, error.message, {
            extensions: error.field ? { field: error.field } : undefined,
          });
        }
        if (options.onError) return options.onError(error, context);
        return problem(500);
      }
    },
  };
}
