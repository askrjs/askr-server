import type { AuthContext, AuthDecision, AuthRequirement, AuthResolver } from "@askrjs/auth";
import type { EventStream, EventStreamOptions } from "./http/event-stream";
import type { Router } from "./router/contracts";
export type { RouteBuilder, Router } from "./router/contracts";

/** Arbitrary per-request state bag attached to a {@link ServerContext}. */
export type RequestState = Record<string, unknown>;
/** A map of route path parameter names to their string values. */
export type Params = Record<string, string>;
type Whitespace = " " | "\n" | "\r" | "\t";
type TrimLeft<Value extends string> = Value extends `${Whitespace}${infer Rest}`
  ? TrimLeft<Rest>
  : Value;
type TrimRight<Value extends string> = Value extends `${infer Rest}${Whitespace}`
  ? TrimRight<Rest>
  : Value;
type Trim<Value extends string> = TrimLeft<TrimRight<Value>>;
type StripWildcard<Name extends string> =
  Trim<Name> extends `*${infer Value}` ? Trim<Value> : Trim<Name>;
type SegmentParameterName<Segment extends string> = Segment extends `{${infer Name}}`
  ? StripWildcard<Name>
  : never;
type PathParameterNames<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
  ? SegmentParameterName<Segment> | PathParameterNames<Rest>
  : SegmentParameterName<Path>;
/**
 * Infers a {@link Params}-shaped object type from a route path pattern, extracting the names
 * of `{param}` and `{*param}` segments as required string keys.
 */
export type PathParams<Path extends string> = string extends Path
  ? Params
  : { [Name in PathParameterNames<Path>]: string };
/** A value that can be serialized as JSON. */
export type JsonValue = unknown;

/** Identifies the kind of operation a {@link ServerTelemetry} call is instrumenting. */
export type ServerTelemetryOperation =
  | "askr.request"
  | "askr.route.match"
  | "askr.loader"
  | "askr.action"
  | "askr.api.operation"
  | "askr.query.prefetch"
  | "askr.ssr.render"
  | "askr.vite.document";

/** Contextual fields attached to a telemetry span or log entry. */
export interface ServerTelemetryFields {
  requestId?: string;
  traceId?: string;
  route?: string;
  action?: string;
  operation?: string;
  status?: number;
  durationMs?: number;
}

/**
 * Telemetry hooks that a {@link ServerAppOptions.telemetry} implementation provides. Each
 * `work`-wrapping method should run `work` inside an appropriately named span, propagating its
 * return value.
 */
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
  extract?<Carrier>(
    carrier: Carrier,
    getter: {
      keys(value: Carrier): string[];
      get(value: Carrier, key: string): string | string[] | undefined;
    },
  ): unknown;
  withContext?<T>(context: unknown, work: () => T): T;
}

/** An RFC 9457 Problem Details object, as produced by {@link ServerContext.problem}. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

/** Optional fields used to customize a {@link Problem} response. */
export interface ProblemOptions {
  type?: string;
  title?: string;
  instance?: string;
  extensions?: Record<string, unknown>;
}

/** Valid values for the `SameSite` cookie attribute. */
export type CookieSameSite = "strict" | "lax" | "none";
/**
 * Options controlling how a cookie is set via {@link ServerContext.setCookie}.
 * Do not derive `domain` or `path` from untrusted input; invalid attribute characters are rejected.
 */
export interface CookieOptions {
  /** ASCII cookie domain without whitespace or attribute delimiters. */
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  /** Cookie path without control characters or the `;` attribute delimiter. */
  path?: string;
  sameSite?: CookieSameSite;
  secure?: boolean;
}

/** Options for building a `WWW-Authenticate` challenge response via {@link ServerContext.challenge}. */
export interface ChallengeOptions {
  scheme?: string;
  realm?: string;
  status?: 401 | 407;
  detail?: string;
  init?: ResponseInit;
}

/** Transport-neutral interface for an upgraded WebSocket connection. */
export interface WebSocketLike {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string | Uint8Array) => void): () => void;
  onClose(listener: (event: WebSocketCloseEvent) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
}

/** Details of a WebSocket close event, mirroring the DOM `CloseEvent` fields used here. */
export interface WebSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/** Handler invoked with a live {@link WebSocketLike} once a connection has been upgraded. */
export type WebSocketHandler<RouteParams extends Params = Params> = {
  bivarianceHack(socket: WebSocketLike, context: ServerContext<RouteParams>): void | Promise<void>;
}["bivarianceHack"];

/** Adapter that performs the transport-specific work of upgrading a request to a WebSocket. */
export interface WebSocketAdapter {
  upgrade(
    request: Request,
    handler: WebSocketHandler,
    context: ServerContext,
  ): Response | Promise<Response>;
}

/**
 * The per-request context passed to handlers and middleware, bundling the incoming request,
 * parsed URL/params/query, auth state, and a family of response-building helper methods
 * (`json`, `ok`, `notFound`, `problem`, `setCookie`, `upgrade`, etc.).
 */
export interface ServerContext<RouteParams extends Params = Params> {
  request: Request;
  url: URL;
  params: RouteParams;
  headers: Headers;
  query: URLSearchParams;
  state: RequestState;
  auth: AuthContext;
  signal: AbortSignal;
  sse(options?: Omit<EventStreamOptions, "signal">): EventStream;
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

/** Continuation function passed to a {@link Middleware}, invoking the next handler in the chain. */
export type Next = () => Response | Promise<Response>;
/** A middleware function that may short-circuit or delegate to `next` to produce a response. */
export type Middleware<RouteParams extends Params = Params> = {
  bivarianceHack(context: ServerContext<RouteParams>, next: Next): Response | Promise<Response>;
}["bivarianceHack"];
/** A route handler function that produces a response for a given {@link ServerContext}. */
export type Handler<RouteParams extends Params = Params> = {
  bivarianceHack(context: ServerContext<RouteParams>): Response | Promise<Response>;
}["bivarianceHack"];
/** Result of a health probe: `true`/`false` for pass/fail, a `Response` to return as-is, or `void` for pass. */
export type ProbeResult = boolean | Response | void;
/** A health-check handler used for liveness/readiness/startup probes. */
export type ProbeHandler = (context: ServerContext) => ProbeResult | Promise<ProbeResult>;
/** Handler invoked to produce a response when an auth decision denies access. */
export type AccessDeniedHandler = (
  decision: Extract<AuthDecision, { allowed: false }>,
  context: ServerContext,
) => Response | Promise<Response>;

/** Per-route configuration shared by {@link ApiRoute}. */
export interface ApiRouteOptions<RouteParams extends Params = Params> {
  auth?: AuthRequirement;
  middleware?: readonly Middleware<RouteParams>[];
  maxRequestBytes?: number;
}

/** A single registered route: a path/method pattern paired with a handler (or WebSocket upgrade handler). */
export interface ApiRoute<
  RouteParams extends Params = Params,
> extends ApiRouteOptions<RouteParams> {
  path: string;
  method?: string | readonly string[];
  handler: Handler<RouteParams>;
  upgrade?: WebSocketHandler<RouteParams>;
}

/** Optional handlers for the built-in `livez`/`readyz`/`startupz`/`targetz` health probe routes. */
export interface ProbeOptions {
  livez?: ProbeHandler;
  readyz?: ProbeHandler;
  startupz?: ProbeHandler;
  targetz?: ProbeHandler;
}

/** Options accepted by {@link createServerApp} to configure a server application. */
export interface ServerAppOptions {
  router?: Router;
  routes?: readonly ApiRoute[];
  middleware?: readonly Middleware[];
  onError?: (error: unknown, context: ServerContext) => Response | Promise<Response>;
  onAccessDenied?: AccessDeniedHandler;
  auth?: AuthResolver;
  fallback?: Handler;
  websocket?: WebSocketAdapter;
  probes?: ProbeOptions;
  telemetry?: ServerTelemetry;
  maxRequestBytes?: number;
}

/** Per-request options passed to {@link ServerApp.fetch}. */
export interface ServerDispatchOptions {
  websocket?: WebSocketAdapter;
}

/** A configured server application, as returned by {@link createServerApp}. */
export interface ServerApp {
  fetch(request: Request, dispatchOptions?: ServerDispatchOptions): Promise<Response>;
}
