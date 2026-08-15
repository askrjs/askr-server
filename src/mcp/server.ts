import { schema, type ObjectSchema } from "@askrjs/schema";
import { dispatchMethod } from "./dispatch";
import { errorCode, failure, object, success, type Registries, type Session } from "./internal";
import type {
  McpContext,
  McpPromptOptions,
  McpRequestEnvironment,
  McpServer,
  McpServerOptions,
} from "./types";

export const supportedProtocolRevisions = ["2025-11-25", "2025-06-18"] as const;
const supported = new Set<string>(supportedProtocolRevisions);
const empty = schema.object({});

function contextFor<Dependencies>(
  params: Record<string, unknown>,
  environment: McpRequestEnvironment<Dependencies>,
  session: Session | undefined,
): McpContext<Dependencies> {
  return {
    dependencies: environment.dependencies,
    auth: environment.auth,
    client: session?.client ?? null,
    clientCapabilities: session?.capabilities ?? {},
    protocolRevision: session?.revision ?? "2025-11-25",
    transport: environment.transport,
    ...(environment.sessionId ? { sessionId: environment.sessionId } : {}),
    signal: environment.signal ?? new AbortController().signal,
    progress: async (progress, total, message) => {
      const metadata = object(params._meta) ? params._meta : undefined;
      if (metadata?.progressToken === undefined) return;
      await environment.send?.({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: metadata.progressToken,
          progress,
          ...(total === undefined ? {} : { total }),
          ...(message ? { message } : {}),
        },
      });
    },
    log: async (level, data, logger) =>
      environment.send?.({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level, data, ...(logger ? { logger } : {}) },
      }),
  };
}

function initialize<Dependencies>(
  id: unknown,
  params: Record<string, unknown>,
  environment: McpRequestEnvironment<Dependencies>,
  options: McpServerOptions,
  sessions: Map<string, Session>,
) {
  const revision = params.protocolVersion;
  if (typeof revision !== "string")
    return failure(id, errorCode.params, "Protocol version is required");
  if (!object(params.capabilities)) {
    return failure(id, errorCode.params, "Client capabilities are required");
  }
  if (
    !object(params.clientInfo) ||
    typeof params.clientInfo.name !== "string" ||
    !params.clientInfo.name.trim() ||
    typeof params.clientInfo.version !== "string" ||
    !params.clientInfo.version.trim()
  ) {
    return failure(id, errorCode.params, "Client information is required");
  }
  const negotiated = supported.has(revision) ? revision : supportedProtocolRevisions[0];
  const client = params.clientInfo as McpContext["client"];
  const session: Session = {
    client,
    capabilities: params.capabilities,
    revision: negotiated as McpContext["protocolRevision"],
  };
  if (environment.sessionId) sessions.set(environment.sessionId, session);
  return success(id, {
    protocolVersion: negotiated,
    capabilities: {
      tools: { listChanged: environment.supportsPush === true },
      resources: { listChanged: environment.supportsPush === true },
      prompts: { listChanged: environment.supportsPush === true },
      completions: {},
      logging: {},
    },
    serverInfo: {
      name: options.name,
      version: options.version,
      ...(options.title ? { title: options.title } : {}),
    },
    ...(options.instructions ? { instructions: options.instructions } : {}),
  });
}

/**
 * Creates a transport-neutral Model Context Protocol server: register tools, resources,
 * resource templates, and prompts, then feed it JSON-RPC messages via `handle` (e.g. from
 * {@link registerMcpRoutes}). Manages session negotiation, protocol version selection, and
 * list-changed notifications to subscribed clients.
 *
 * @param options - Server name/version/instructions and pagination settings.
 * @returns An {@link McpServer} exposing registration methods, notification methods, and `handle`.
 * @throws {TypeError} If `name`/`version` are blank, `pageSize` is invalid, or a duplicate
 * tool/resource/template/prompt is registered.
 */
export function createMcpServer<Dependencies = undefined>(
  options: McpServerOptions,
): McpServer<Dependencies> {
  if (!options.name.trim()) throw new TypeError("MCP server name must not be blank.");
  if (!options.version.trim()) throw new TypeError("MCP server version must not be blank.");
  const pageSize = options.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new TypeError("MCP pageSize must be a positive safe integer.");
  }
  const registries: Registries = {
    tools: new Map(),
    resources: new Map(),
    templates: [],
    prompts: new Map(),
    pageSize,
  };
  const sessions = new Map<string, Session>();
  const listeners = new Set<McpRequestEnvironment<Dependencies>>();
  const notify = async (method: string) => {
    await Promise.all(
      [...listeners].map((environment) => environment.send?.({ jsonrpc: "2.0", method })),
    );
  };
  const api: McpServer<Dependencies> = {
    tool(name, primitiveOptions, handler) {
      if (registries.tools.has(name)) throw new TypeError(`Duplicate MCP tool ${name}.`);
      registries.tools.set(name, {
        name,
        options: primitiveOptions,
        input: primitiveOptions.input ?? empty,
        output: primitiveOptions.output,
        handler,
      });
      return api;
    },
    resource(uri, primitiveOptions, handler) {
      if (registries.resources.has(uri)) throw new TypeError(`Duplicate MCP resource ${uri}.`);
      registries.resources.set(uri, { uri, options: primitiveOptions, handler });
      return api;
    },
    resourceTemplate(template, primitiveOptions, handler) {
      if (registries.templates.some((entry) => entry.template === template)) {
        throw new TypeError(`Duplicate MCP resource template ${template}.`);
      }
      registries.templates.push({ template, options: primitiveOptions, handler });
      return api;
    },
    prompt(name, primitiveOptions: McpPromptOptions<ObjectSchema>, handler) {
      if (registries.prompts.has(name)) throw new TypeError(`Duplicate MCP prompt ${name}.`);
      registries.prompts.set(name, {
        name,
        options: primitiveOptions,
        arguments: primitiveOptions.arguments ?? empty,
        handler,
      });
      return api;
    },
    notifyToolsChanged: () => notify("notifications/tools/list_changed"),
    notifyResourcesChanged: () => notify("notifications/resources/list_changed"),
    notifyPromptsChanged: () => notify("notifications/prompts/list_changed"),
    terminateSession(sessionId) {
      sessions.delete(sessionId);
      for (const listener of listeners)
        if (listener.sessionId === sessionId) listeners.delete(listener);
    },
    async handle(message, environment) {
      if (
        !object(message) ||
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string" ||
        ("id" in message && !(typeof message.id === "string" || typeof message.id === "number"))
      )
        return failure(object(message) ? message.id : null, errorCode.invalid, "Invalid Request");
      const id = message.id;
      const notification = id === undefined;
      const params = object(message.params) ? message.params : {};
      let session = environment.sessionId ? sessions.get(environment.sessionId) : undefined;
      try {
        if (message.method === "initialize") {
          if (notification) return undefined;
          if (session) return failure(id, errorCode.invalid, "Session is already initialized");
          return initialize(id, params, environment, options, sessions);
        }
        if (message.method === "notifications/initialized") {
          if (environment.sessionId && !session) return undefined;
          if (environment.send) listeners.add(environment);
          return undefined;
        }
        if (
          message.method === "notifications/cancelled" ||
          message.method === "notifications/progress"
        )
          return undefined;
        if (!session && environment.sessionId)
          return failure(id, errorCode.invalid, "Session is not initialized");
        const result = await dispatchMethod(
          id,
          message.method,
          params,
          contextFor(params, environment, session),
          environment,
          registries,
        );
        return notification ? undefined : result;
      } catch (error) {
        return notification
          ? undefined
          : failure(id, errorCode.internal, "Internal error", {
              message: error instanceof Error ? error.message : String(error),
            });
      }
    },
  };
  return api;
}
