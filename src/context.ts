import type { AuthContext, AuthResolver } from "@askrjs/auth";
import type {
  ServerContext,
  WebSocketHandler,
  ServerAppOptions,
  WebSocketAdapter,
} from "./contracts";
import { bind } from "./binding";
import * as responses from "./http/responses";
import { createEventStream } from "./http/event-stream";

const responseHelpers = Object.freeze({
  json: responses.json,
  text: responses.text,
  redirect: responses.redirect,
  ok: responses.ok,
  created: responses.created,
  accepted: responses.accepted,
  noContent: responses.noContent,
  badRequest: responses.badRequest,
  unauthorized: responses.unauthorized,
  forbidden: responses.forbidden,
  notFound: responses.notFound,
  conflict: responses.conflict,
  unprocessableEntity: responses.unprocessableEntity,
  tooManyRequests: responses.tooManyRequests,
  methodNotAllowed: responses.methodNotAllowed,
  error: responses.error,
  internalServerError: responses.internalServerError,
  notImplemented: responses.notImplemented,
  serviceUnavailable: responses.serviceUnavailable,
  problem: responses.problem,
  challenge: responses.challenge,
  setCookie: responses.setCookie,
  clearCookie: responses.clearCookie,
});
type ContextProperties = Pick<
  ServerContext,
  | "request"
  | "url"
  | "params"
  | "headers"
  | "query"
  | "state"
  | "auth"
  | "signal"
  | "sse"
  | "telemetry"
  | "bind"
  | "upgrade"
>;

export function anonymousAuthContext(): AuthContext {
  return { authenticated: false, principal: null, session: null, tenant: null };
}

/** Add the request capability without mutating or serializing the resolver's context. */
export function createServerAuthContext(
  auth: AuthContext,
  request: Request,
  resolver?: AuthResolver,
): ServerContext["auth"] {
  type TokenOptions = Parameters<ServerContext["auth"]["token"]>[1];
  const provider = resolver as
    | (AuthResolver & {
        token?: (request: Request, provider: string, options: TokenOptions) => Promise<string>;
      })
    | undefined;
  const token = (name: string, options: TokenOptions): Promise<string> => {
    if (typeof provider?.token === "function") return provider.token(request, name, options);
    const error = new Error("Provider token access requires provider session authentication.");
    Object.defineProperty(error, "code", { value: "configuration" });
    return Promise.reject(error);
  };
  return Object.defineProperty({ ...auth }, "token", {
    value: token,
    enumerable: false,
    writable: false,
    configurable: false,
  }) as ServerContext["auth"];
}

export function createServerContext(
  request: Request,
  auth: AuthContext,
  options: Pick<ServerAppOptions, "telemetry" | "websocket" | "auth">,
  dispatchWebsocket?: WebSocketAdapter,
): ServerContext {
  const url = new URL(request.url);
  let bound: Promise<Record<string, unknown>> | undefined;
  let context: ServerContext;
  const upgrade = (handler: WebSocketHandler) =>
    (dispatchWebsocket ?? options.websocket)
      ? (dispatchWebsocket ?? options.websocket)!.upgrade(request, handler, context)
      : responses.problem(501, "This server does not provide a WebSocket upgrade adapter.");
  context = Object.assign(Object.create(responseHelpers) as typeof responseHelpers, {
    request,
    url,
    params: {},
    headers: request.headers,
    query: url.searchParams,
    state: {},
    auth: createServerAuthContext(auth, request, options.auth),
    signal: request.signal,
    sse: (streamOptions: Parameters<ServerContext["sse"]>[0]) =>
      createEventStream({ ...streamOptions, signal: request.signal }),
    telemetry: options.telemetry,
    bind: <T extends object = Record<string, unknown>>() => {
      bound ??= bind(context);
      return bound as Promise<T>;
    },
    upgrade,
  } satisfies ContextProperties) satisfies ServerContext;
  return context;
}
