import type {
  ApiRoute,
  ApiRouteOptions,
  Handler,
  Middleware,
  PathParams,
  WebSocketHandler,
} from "../contracts";

export interface RouteBuilder {
  route<const Path extends string>(
    method: string | readonly string[],
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  get<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  post<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  put<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  patch<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  delete<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  options<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  head<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  trace<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  connect<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
  ws<const Path extends string>(
    path: Path,
    handler: WebSocketHandler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): ApiRoute<PathParams<Path>>;
}

export interface Router extends Omit<RouteBuilder, keyof RouteBuilder> {
  readonly routes: readonly ApiRoute[];
  readonly middleware: readonly Middleware[];
  use(...middleware: Middleware[]): Router;
  route<const Path extends string>(
    method: string | readonly string[],
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  get<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  post<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  put<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  patch<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  delete<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  options<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  head<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  trace<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  connect<const Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
  ws<const Path extends string>(
    path: Path,
    handler: WebSocketHandler<PathParams<Path>>,
    options?: ApiRouteOptions<PathParams<Path>>,
  ): Router;
}
