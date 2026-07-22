import type { Router, ServerContext } from "../contracts";
import { PayloadTooLargeError, readRequestText } from "../body-limit";
import { createEventStream, type EventStream } from "../http/event-stream";
import type { McpRequestEnvironment, McpServer, McpSessionStore } from "./types";

export interface McpHttpOptions<Dependencies = undefined> {
  dependencies: Dependencies;
  stateful?: boolean;
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
  maxRequestBytes?: number;
  resource?: string;
  authorizationServers?: readonly string[];
  sessionStore?: McpSessionStore;
  heartbeatInterval?: number;
}

type Channel = EventStream;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
function validRequest(
  context: ServerContext,
  options: McpHttpOptions<unknown>,
): Response | undefined {
  const origin = context.headers.get("origin");
  if (origin && options.allowedOrigins && !options.allowedOrigins.includes(origin))
    return context.forbidden("Origin is not allowed.");
  const host = context.headers.get("host");
  if (options.allowedHosts && (!host || !options.allowedHosts.includes(host)))
    return context.forbidden("Host is not allowed.");
  return undefined;
}
function memorySessionStore(): McpSessionStore {
  const values = new Set<string>();
  return {
    create(id) {
      values.add(id);
    },
    has: (id) => values.has(id),
    delete: (id) => values.delete(id),
  };
}

export function protectedResourceMetadata(
  resource: string,
  authorizationServers: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    resource,
    authorization_servers: [...authorizationServers],
    bearer_methods_supported: ["header"],
  });
}

export function registerMcpRoutes<Dependencies>(
  router: Router,
  path: string,
  mcp: McpServer<Dependencies>,
  options: McpHttpOptions<Dependencies>,
): Router {
  const channels = new Map<string, Channel>();
  const sessions = options.sessionStore ?? memorySessionStore();
  const environment = (
    context: ServerContext,
    sessionId?: string,
  ): McpRequestEnvironment<Dependencies> => ({
    dependencies: options.dependencies,
    auth: context.auth,
    transport: "http",
    ...(sessionId ? { sessionId } : {}),
    signal: context.signal,
    supportsPush: options.stateful === true,
    send: sessionId
      ? async (message) => {
          await channels.get(sessionId)?.send({ event: "message", data: message });
        }
      : undefined,
  });
  router.post(path, async (context) => {
    const invalid = validRequest(context, options as McpHttpOptions<unknown>);
    if (invalid) return invalid;
    const contentType = context.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json")
      return context.error(415, "MCP requires application/json.");
    const accept = context.headers.get("accept") ?? "";
    if (
      !accept.includes("application/json") &&
      !accept.includes("text/event-stream") &&
      accept !== "*/*"
    )
      return context.error(406, "MCP requires application/json or text/event-stream.");
    const length = Number(context.headers.get("content-length") ?? 0);
    const maximum = options.maxRequestBytes ?? 1024 * 1024;
    if (Number.isFinite(length) && length > maximum)
      return context.error(413, "MCP request is too large.");
    let message: unknown;
    try {
      const text = await readRequestText(context.request, maximum);
      message = JSON.parse(text);
    } catch (error) {
      if (error instanceof PayloadTooLargeError)
        return context.problem(413, "MCP request is too large.", { title: "Payload Too Large" });
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }
    if (Array.isArray(message))
      return json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "JSON-RPC batches are not supported" },
        },
        400,
      );
    const requestedRevision = context.headers.get("mcp-protocol-version");
    if (
      requestedRevision &&
      requestedRevision !== "2025-03-26" &&
      requestedRevision !== "2025-11-25" &&
      requestedRevision !== "2025-06-18"
    )
      return context.badRequest("Unsupported MCP-Protocol-Version.");
    const requested = context.headers.get("mcp-session-id") ?? undefined;
    if (requested && options.stateful && !(await sessions.has(requested)))
      return context.notFound("MCP session not found.");
    const isInitialize =
      message &&
      typeof message === "object" &&
      (message as Record<string, unknown>).method === "initialize";
    const sessionId = options.stateful
      ? (requested ?? (isInitialize ? crypto.randomUUID() : undefined))
      : undefined;
    if (options.stateful && !sessionId) return context.badRequest("MCP-Session-Id is required.");
    if (sessionId && !requested) await sessions.create(sessionId);
    const result = await mcp.handle(message, environment(context, sessionId));
    const headers: Record<string, string> = sessionId ? { "mcp-session-id": sessionId } : {};
    return result === undefined
      ? new Response(null, { status: 202, headers })
      : json(result, 200, headers);
  });
  router.get(path, async (context) => {
    const invalid = validRequest(context, options as McpHttpOptions<unknown>);
    if (invalid) return invalid;
    if (!options.stateful) return context.methodNotAllowed(["POST"]);
    const sessionId = context.headers.get("mcp-session-id");
    if (!sessionId || !(await sessions.has(sessionId)))
      return context.notFound("MCP session not found.");
    if (!(context.headers.get("accept") ?? "").includes("text/event-stream"))
      return context.error(406, "MCP GET requires text/event-stream.");
    await channels.get(sessionId)?.close();
    const next = createEventStream({
      signal: context.signal,
      heartbeatInterval: options.heartbeatInterval ?? 30_000,
    });
    channels.set(sessionId, next);
    await next.comment("connected");
    void next.closed.then(() => {
      if (channels.get(sessionId) === next) channels.delete(sessionId);
    });
    return next.response;
  });
  router.delete(path, async (context) => {
    const invalid = validRequest(context, options as McpHttpOptions<unknown>);
    if (invalid) return invalid;
    if (!options.stateful) return context.methodNotAllowed(["POST"]);
    const sessionId = context.headers.get("mcp-session-id");
    if (!sessionId || !(await sessions.delete(sessionId)))
      return context.notFound("MCP session not found.");
    await channels.get(sessionId)?.close();
    channels.delete(sessionId);
    mcp.terminateSession(sessionId);
    return context.noContent();
  });
  if (options.resource) {
    const metadataPath = "/.well-known/oauth-protected-resource";
    router.get(metadataPath, (context) =>
      context.json(protectedResourceMetadata(options.resource!, options.authorizationServers)),
    );
  }
  return router;
}
