import type {
  ApiRoute,
  ApiRouteOptions,
  Handler,
  Middleware,
  RouteBuilder,
  Router,
  WebSocketHandler,
} from "../contracts";

function httpRoute(
  method: string | readonly string[],
  path: string,
  handler: Handler,
  options: ApiRouteOptions = {},
): ApiRoute {
  return { method, path, handler, ...options };
}

function websocketRoute(
  path: string,
  upgrade: WebSocketHandler,
  options: ApiRouteOptions = {},
): ApiRoute {
  return {
    method: "GET",
    path,
    handler: () => new Response(null, { status: 426 }),
    upgrade,
    ...options,
  };
}

function createBuilder(add: (route: ApiRoute) => void): RouteBuilder {
  const route = (method: string | readonly string[], path: string, handler: Handler, options?: ApiRouteOptions) => {
    const value = httpRoute(method, path, handler, options);
    add(value);
    return value;
  };
  return {
    route,
    get: (path, handler, options) => route("GET", path, handler, options),
    post: (path, handler, options) => route("POST", path, handler, options),
    put: (path, handler, options) => route("PUT", path, handler, options),
    patch: (path, handler, options) => route("PATCH", path, handler, options),
    delete: (path, handler, options) => route("DELETE", path, handler, options),
    options: (path, handler, options) => route("OPTIONS", path, handler, options),
    head: (path, handler, options) => route("HEAD", path, handler, options),
    trace: (path, handler, options) => route("TRACE", path, handler, options),
    connect: (path, handler, options) => route("CONNECT", path, handler, options),
    ws: (path, handler, options) => {
      const value = websocketRoute(path, handler, options);
      add(value);
      return value;
    },
  };
}

export function defineRoutes(definition: (route: RouteBuilder) => void): ApiRoute[] {
  const routes: ApiRoute[] = [];
  definition(createBuilder((route) => routes.push(route)));
  return routes;
}

export function createRouter(): Router {
  const routes: ApiRoute[] = [];
  const middleware: Middleware[] = [];
  const builder = createBuilder((route) => routes.push(route));
  let router: Router;
  router = {
    routes,
    middleware,
    use: (...next) => {
      middleware.push(...next);
      return router;
    },
    route: (...args) => {
      builder.route(...args);
      return router;
    },
    get: (...args) => {
      builder.get(...args);
      return router;
    },
    post: (...args) => {
      builder.post(...args);
      return router;
    },
    put: (...args) => {
      builder.put(...args);
      return router;
    },
    patch: (...args) => {
      builder.patch(...args);
      return router;
    },
    delete: (...args) => {
      builder.delete(...args);
      return router;
    },
    options: (...args) => {
      builder.options(...args);
      return router;
    },
    head: (...args) => {
      builder.head(...args);
      return router;
    },
    trace: (...args) => {
      builder.trace(...args);
      return router;
    },
    connect: (...args) => {
      builder.connect(...args);
      return router;
    },
    ws: (...args) => {
      builder.ws(...args);
      return router;
    },
  };
  return router;
}
