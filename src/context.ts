import type { AuthContext } from "@askrjs/auth";
import type { ServerContext, WebSocketHandler, ServerAppOptions } from "./contracts";
import { bind } from "./binding";
import * as responses from "./http/responses";
import { createEventStream } from "./http/event-stream";

export function anonymousAuthContext(): AuthContext {
  return { authenticated: false, principal: null, session: null, tenant: null };
}

export function createServerContext(
  request: Request,
  auth: AuthContext,
  options: Pick<ServerAppOptions, "telemetry" | "websocket">,
): ServerContext {
  const url = new URL(request.url);
  let bound: Promise<Record<string, unknown>> | undefined;
  let context: ServerContext;
  const upgrade = (handler: WebSocketHandler) =>
    options.websocket
      ? options.websocket.upgrade(request, handler, context)
      : responses.problem(501, "This server does not provide a WebSocket upgrade adapter.");
  context = {
    request,
    url,
    params: {},
    headers: request.headers,
    query: url.searchParams,
    state: {},
    auth,
    signal: request.signal,
    sse: (streamOptions) => createEventStream({ ...streamOptions, signal: request.signal }),
    telemetry: options.telemetry,
    bind: <T extends object = Record<string, unknown>>() => {
      bound ??= bind(context);
      return bound as Promise<T>;
    },
    ...responses,
    upgrade,
  };
  return context;
}
