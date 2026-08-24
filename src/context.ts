import type { AuthContext } from "@askrjs/auth";
import type {
  ServerContext,
  WebSocketHandler,
  ServerAppOptions,
  WebSocketAdapter,
} from "./contracts";
import { bind } from "./binding";
import * as responses from "./http/responses";
import { createEventStream } from "./http/event-stream";

const responseHelpers = Object.freeze({ ...responses });
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

export function createServerContext(
  request: Request,
  auth: AuthContext,
  options: Pick<ServerAppOptions, "telemetry" | "websocket">,
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
    auth,
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
