import type { Router, ServerContext } from "../contracts";
import { PayloadTooLargeError, readRequestText, validateMaxRequestBytes } from "../body-limit";
import { createEventStream, type EventStream } from "../http/event-stream";
import { accepts, contentType } from "../http/media-types";
import type { McpRequestEnvironment, McpServer, McpSessionStore } from "./types";

export interface McpHttpOptions<Dependencies = undefined> {
  dependencies: Dependencies;
  stateful?: boolean;
  allowedOrigins: readonly string[];
  allowedHosts: readonly string[];
  maxRequestBytes?: number;
  resource?: string;
  authorizationServers?: readonly string[];
  sessionStore?: McpSessionStore;
  heartbeatInterval?: number;
  sessionTtlMs?: number;
  maxSessions?: number;
  now?: () => number;
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
  if (!origin || !options.allowedOrigins.includes(origin))
    return context.forbidden("Origin is not allowed.");
  const host = context.headers.get("host");
  if (!host || !options.allowedHosts.includes(host))
    return context.forbidden("Host is not allowed.");
  return undefined;
}
function memorySessionStore(
  options: McpHttpOptions<unknown>,
  expired: (id: string) => void,
): McpSessionStore {
  const values = new Map<string, number>();
  const now = options.now ?? Date.now;
  const ttl = options.sessionTtlMs ?? 30 * 60_000;
  const capacity = options.maxSessions ?? 1_000;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError("MCP sessionTtlMs must be positive.");
  if (!Number.isInteger(capacity) || capacity <= 0)
    throw new TypeError("MCP maxSessions must be a positive integer.");
  const purge = () => {
    const current = now();
    for (const [id, expires] of values) {
      if (expires <= current) {
        values.delete(id);
        expired(id);
      }
    }
  };
  return {
    create(id) {
      purge();
      if (!values.has(id) && values.size >= capacity)
        throw new Error("MCP session capacity is exhausted.");
      values.set(id, now() + ttl);
    },
    has(id) {
      purge();
      return values.has(id);
    },
    delete: (id) => values.delete(id),
  };
}

/**
 * Builds an OAuth 2.0 Protected Resource Metadata document (RFC 9728) advertising `resource`
 * and its authorization servers, as served at `/.well-known/oauth-protected-resource` by
 * {@link registerMcpRoutes} when `options.resource` is configured.
 */
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

/**
 * Registers the streamable-HTTP transport for an {@link McpServer} on a router: `POST` for
 * JSON-RPC requests (with optional stateful session creation), `GET` for the Server-Sent
 * Events notification stream, and `DELETE` for session termination. Validates the `Origin` and
 * `Host` headers against allowlists, enforces a max request size, and optionally serves
 * OAuth protected-resource metadata.
 *
 * @param router - The router to register routes on.
 * @param path - The MCP endpoint path.
 * @param mcp - The MCP server instance to dispatch messages to.
 * @param options - Origin/host allowlists, statefulness, session store, and size/timing limits.
 * @returns The same `router`, for chaining.
 * @throws {TypeError} If `heartbeatInterval`, `sessionTtlMs`, or `maxSessions` are invalid.
 */
export function registerMcpRoutes<Dependencies>(
  router: Router,
  path: string,
  mcp: McpServer<Dependencies>,
  options: McpHttpOptions<Dependencies>,
): Router {
  const maximum = validateMaxRequestBytes(
    options.maxRequestBytes ?? 1024 * 1024,
    "McpHttpOptions.maxRequestBytes",
  );
  if (
    options.heartbeatInterval !== undefined &&
    (!Number.isSafeInteger(options.heartbeatInterval) || options.heartbeatInterval < 1)
  ) {
    throw new TypeError("MCP heartbeatInterval must be a positive safe integer.");
  }
  const channels = new Map<string, Channel>();
  const discardSession = (sessionId: string) => {
    void channels.get(sessionId)?.close();
    channels.delete(sessionId);
    mcp.terminateSession(sessionId);
  };
  const sessions =
    options.sessionStore ?? memorySessionStore(options as McpHttpOptions<unknown>, discardSession);
  const hasSession = async (sessionId: string): Promise<boolean> => {
    if (await sessions.has(sessionId)) return true;
    if (options.sessionStore) discardSession(sessionId);
    return false;
  };
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
    const requestType = contentType(context.headers.get("content-type"));
    if (requestType !== "application/json")
      return context.error(415, "MCP requires application/json.");
    const accept = context.headers.get("accept") ?? "";
    if (!accepts(accept, "application/json") || !accepts(accept, "text/event-stream"))
      return context.error(406, "MCP requires application/json and text/event-stream.");
    const length = Number(context.headers.get("content-length") ?? 0);
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
    if (requested && options.stateful && !(await hasSession(requested)))
      return context.notFound("MCP session not found.");
    const isInitialize =
      message &&
      typeof message === "object" &&
      (message as Record<string, unknown>).method === "initialize";
    const sessionId = options.stateful
      ? (requested ?? (isInitialize ? crypto.randomUUID() : undefined))
      : undefined;
    if (options.stateful && !sessionId) return context.badRequest("MCP-Session-Id is required.");
    const result = await mcp.handle(message, environment(context, sessionId));
    let created = false;
    if (sessionId && !requested && result && typeof result === "object" && "result" in result) {
      try {
        await sessions.create(sessionId);
        created = true;
      } catch {
        mcp.terminateSession(sessionId);
        return context.error(503, "MCP session capacity is unavailable.");
      }
    }
    const headers: Record<string, string> =
      sessionId && (requested || created) ? { "mcp-session-id": sessionId } : {};
    return result === undefined
      ? new Response(null, { status: 202, headers })
      : json(result, 200, headers);
  });
  router.get(path, async (context) => {
    const invalid = validRequest(context, options as McpHttpOptions<unknown>);
    if (invalid) return invalid;
    if (!options.stateful) return context.methodNotAllowed(["POST"]);
    const sessionId = context.headers.get("mcp-session-id");
    if (!sessionId || !(await hasSession(sessionId)))
      return context.notFound("MCP session not found.");
    if (!accepts(context.headers.get("accept") ?? "", "text/event-stream"))
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
