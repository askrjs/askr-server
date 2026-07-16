import type { AuthContext, AuthRequirement, AuthResolver } from "@askrjs/auth";

export type RequestState = Record<string, unknown>;
export type Params = Record<string, string>;
type Whitespace = " " | "\n" | "\r" | "\t";
type TrimLeft<Value extends string> = Value extends `${Whitespace}${infer Rest}` ? TrimLeft<Rest> : Value;
type TrimRight<Value extends string> = Value extends `${infer Rest}${Whitespace}` ? TrimRight<Rest> : Value;
type Trim<Value extends string> = TrimLeft<TrimRight<Value>>;
type StripWildcard<Name extends string> = Trim<Name> extends `*${infer Value}` ? Trim<Value> : Trim<Name>;
type PathParameterNames<Path extends string> =
  Path extends `${string}{${infer Name}}${infer Rest}`
    ? StripWildcard<Name> | PathParameterNames<Rest>
    : never;
export type PathParams<Path extends string> = string extends Path
  ? Params
  : { [Name in PathParameterNames<Path>]: string };
export type JsonValue = unknown;

export type ServerTelemetryOperation =
  | "askr.request"
  | "askr.route.match"
  | "askr.loader"
  | "askr.action"
  | "askr.api.operation"
  | "askr.query.prefetch"
  | "askr.ssr.render"
  | "askr.vite.document";

export interface ServerTelemetryFields {
  requestId?: string;
  traceId?: string;
  route?: string;
  action?: string;
  operation?: string;
  status?: number;
  durationMs?: number;
}

export interface ServerTelemetry {
  request<T>(fields: ServerTelemetryFields, work: () => T): T;
  routeMatch<T>(fields: ServerTelemetryFields, work: () => T): T;
  loader?<T>(fields: ServerTelemetryFields, work: () => T): T;
  action<T>(fields: ServerTelemetryFields, work: () => T): T;
  apiOperation<T>(fields: ServerTelemetryFields, work: () => T): T;
  queryPrefetch?<T>(fields: ServerTelemetryFields, work: () => T): T;
  ssrRender?<T>(fields: ServerTelemetryFields, work: () => T): T;
  log(
    level: "debug" | "info" | "warn" | "error",
    event: ServerTelemetryOperation,
    fields?: ServerTelemetryFields,
  ): void;
  traceId(): string | undefined;
  extract?<Carrier>(carrier: Carrier, getter: {
    keys(value: Carrier): string[];
    get(value: Carrier, key: string): string | string[] | undefined;
  }): unknown;
  withContext?<T>(context: unknown, work: () => T): T;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

export interface ProblemOptions {
  type?: string;
  title?: string;
  instance?: string;
  extensions?: Record<string, unknown>;
}

export type CookieSameSite = "strict" | "lax" | "none";
export interface CookieOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: CookieSameSite;
  secure?: boolean;
}

export interface ChallengeOptions {
  scheme?: string;
  realm?: string;
  status?: 401 | 407;
  detail?: string;
  init?: ResponseInit;
}

export interface WebSocketLike {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketHandler<RouteParams extends Params = Params> = {
  bivarianceHack(socket: WebSocketLike, context: ServerContext<RouteParams>): void | Promise<void>;
}["bivarianceHack"];

export interface WebSocketAdapter {
  upgrade(
    request: Request,
    handler: WebSocketHandler,
    context: ServerContext,
  ): Response | Promise<Response>;
}

export interface ServerContext<RouteParams extends Params = Params> {
  request: Request;
  url: URL;
  params: RouteParams;
  headers: Headers;
  query: URLSearchParams;
  state: RequestState;
  auth: AuthContext;
  signal: AbortSignal;
  telemetry?: ServerTelemetry;
  bind<T extends object = Record<string, unknown>>(): Promise<T>;
  json(value: JsonValue, init?: ResponseInit): Response;
  text(value: string, init?: ResponseInit): Response;
  redirect(location: string, status?: 301 | 302 | 303 | 307 | 308): Response;
  ok(value?: JsonValue, init?: ResponseInit): Response;
  created(value?: JsonValue, init?: ResponseInit): Response;
  accepted(value?: JsonValue, init?: ResponseInit): Response;
  noContent(init?: ResponseInit): Response;
  badRequest(message?: string, init?: ResponseInit): Response;
  bad(message?: string, init?: ResponseInit): Response;
  unauthorized(message?: string, init?: ResponseInit): Response;
  forbidden(message?: string, init?: ResponseInit): Response;
  notFound(message?: string, init?: ResponseInit): Response;
  conflict(message?: string, init?: ResponseInit): Response;
  unprocessableEntity(message?: string, init?: ResponseInit): Response;
  tooManyRequests(message?: string, init?: ResponseInit): Response;
  methodNotAllowed(allow?: string | readonly string[], init?: ResponseInit): Response;
  error(status?: number, message?: string, init?: ResponseInit): Response;
  internalServerError(message?: string, init?: ResponseInit): Response;
  serverError(message?: string, init?: ResponseInit): Response;
  notImplemented(message?: string, init?: ResponseInit): Response;
  serviceUnavailable(message?: string, init?: ResponseInit): Response;
  problem(status: number, detail?: string, options?: ProblemOptions): Response;
  challenge(options?: ChallengeOptions): Response;
  setCookie(response: Response, name: string, value: string, options?: CookieOptions): Response;
  clearCookie(response: Response, name: string, options?: CookieOptions): Response;
  upgrade(handler: WebSocketHandler): Response | Promise<Response>;
}

export type Next = () => Response | Promise<Response>;
export type Middleware<RouteParams extends Params = Params> = {
  bivarianceHack(context: ServerContext<RouteParams>, next: Next): Response | Promise<Response>;
}["bivarianceHack"];
export type Handler<RouteParams extends Params = Params> = {
  bivarianceHack(context: ServerContext<RouteParams>): Response | Promise<Response>;
}["bivarianceHack"];
export type ProbeResult = boolean | Response | void;
export type ProbeHandler = (context: ServerContext) => ProbeResult | Promise<ProbeResult>;

export interface ApiRouteOptions<RouteParams extends Params = Params> {
  auth?: AuthRequirement;
  middleware?: readonly Middleware<RouteParams>[];
}

export interface ApiRoute<RouteParams extends Params = Params> extends ApiRouteOptions<RouteParams> {
  path: string;
  method?: string | readonly string[];
  handler: Handler<RouteParams>;
  upgrade?: WebSocketHandler<RouteParams>;
}

export interface ProbeOptions {
  livez?: ProbeHandler;
  readyz?: ProbeHandler;
  startupz?: ProbeHandler;
  targetz?: ProbeHandler;
}

export interface ServerAppOptions {
  router?: Router;
  routes?: readonly ApiRoute[];
  middleware?: readonly Middleware[];
  onError?: (error: unknown, context: ServerContext) => Response | Promise<Response>;
  auth?: AuthResolver;
  fallback?: Handler;
  websocket?: WebSocketAdapter;
  probes?: ProbeOptions;
  telemetry?: ServerTelemetry;
}

export interface ServerApp {
  fetch(request: Request): Promise<Response>;
}

export interface RouteBuilder {
  route<const Path extends string>(method: string | readonly string[], path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  get<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  post<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  put<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  patch<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  delete<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  options<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  head<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  trace<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  connect<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
  ws<const Path extends string>(path: Path, handler: WebSocketHandler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): ApiRoute<PathParams<Path>>;
}

export interface Router extends Omit<RouteBuilder, "route" | "get" | "post" | "put" | "patch" | "delete" | "options" | "head" | "trace" | "connect" | "ws"> {
  readonly routes: readonly ApiRoute[];
  readonly middleware: readonly Middleware[];
  use(...middleware: Middleware[]): Router;
  route<const Path extends string>(method: string | readonly string[], path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  get<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  post<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  put<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  patch<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  delete<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  options<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  head<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  trace<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  connect<const Path extends string>(path: Path, handler: Handler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
  ws<const Path extends string>(path: Path, handler: WebSocketHandler<PathParams<Path>>, options?: ApiRouteOptions<PathParams<Path>>): Router;
}
