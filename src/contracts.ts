import type { AuthContext, AuthRequirement, AuthResolver } from "@askrjs/auth";

export type RequestState = Record<string, unknown>;
export type Params = Record<string, string>;
export type JsonValue = unknown;

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

export type WebSocketHandler = (
  socket: WebSocketLike,
  context: ServerContext,
) => void | Promise<void>;

export interface WebSocketAdapter {
  upgrade(
    request: Request,
    handler: WebSocketHandler,
    context: ServerContext,
  ): Response | Promise<Response>;
}

export interface ServerContext {
  request: Request;
  url: URL;
  params: Params;
  headers: Headers;
  query: URLSearchParams;
  state: RequestState;
  auth: AuthContext;
  signal: AbortSignal;
  bind<T extends Record<string, unknown>>(): Promise<T>;
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
export type Middleware = (context: ServerContext, next: Next) => Response | Promise<Response>;
export type Handler = (context: ServerContext) => Response | Promise<Response>;
export type ProbeResult = boolean | Response | void;
export type ProbeHandler = (context: ServerContext) => ProbeResult | Promise<ProbeResult>;

export interface ApiRouteOptions {
  auth?: AuthRequirement;
  middleware?: readonly Middleware[];
}

export interface ApiRoute extends ApiRouteOptions {
  path: string;
  method?: string | readonly string[];
  handler: Handler;
  upgrade?: WebSocketHandler;
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
}

export interface ServerApp {
  fetch(request: Request): Promise<Response>;
}

export interface RouteBuilder {
  route(method: string | readonly string[], path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  get(path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  post(path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  put(path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  patch(path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  delete(path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  options(path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  head(path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  trace(path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  connect(path: string, handler: Handler, options?: ApiRouteOptions): ApiRoute;
  ws(path: string, handler: WebSocketHandler, options?: ApiRouteOptions): ApiRoute;
}

export interface Router extends Omit<RouteBuilder, "route" | "get" | "post" | "put" | "patch" | "delete" | "options" | "head" | "trace" | "connect" | "ws"> {
  readonly routes: readonly ApiRoute[];
  readonly middleware: readonly Middleware[];
  use(...middleware: Middleware[]): Router;
  route(method: string | readonly string[], path: string, handler: Handler, options?: ApiRouteOptions): Router;
  get(path: string, handler: Handler, options?: ApiRouteOptions): Router;
  post(path: string, handler: Handler, options?: ApiRouteOptions): Router;
  put(path: string, handler: Handler, options?: ApiRouteOptions): Router;
  patch(path: string, handler: Handler, options?: ApiRouteOptions): Router;
  delete(path: string, handler: Handler, options?: ApiRouteOptions): Router;
  options(path: string, handler: Handler, options?: ApiRouteOptions): Router;
  head(path: string, handler: Handler, options?: ApiRouteOptions): Router;
  trace(path: string, handler: Handler, options?: ApiRouteOptions): Router;
  connect(path: string, handler: Handler, options?: ApiRouteOptions): Router;
  ws(path: string, handler: WebSocketHandler, options?: ApiRouteOptions): Router;
}
