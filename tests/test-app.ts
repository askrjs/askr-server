import { createServerApp as createServerAppImpl } from "../src/application";
import { createRouter } from "../src/router/router";
import type { ApiRoute, Router, ServerApp, ServerAppOptions } from "../src/contracts";

type TestServerOptions = ServerAppOptions & {
  routes?: readonly ApiRoute[];
};

/** Keeps legacy route-array fixtures out of the production contract. */
export function createServerApp(input: Router | TestServerOptions = {}): ServerApp {
  if ("use" in input && "routes" in input) return createServerAppImpl(input);
  const { routes, router, ...options } = input as TestServerOptions;
  if (!routes) return createServerAppImpl({ ...options, ...(router ? { router } : {}) });
  const target = router ?? createRouter();
  (target.routes as ApiRoute[]).splice(0, target.routes.length, ...routes);
  return createServerAppImpl({ ...options, router: target });
}
