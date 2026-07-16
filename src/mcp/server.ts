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

const supported = new Set(["2025-11-25", "2025-06-18"]);
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
  if (typeof revision !== "string" || !supported.has(revision))
    return failure(id, errorCode.params, "Unsupported protocol version");
  const client =
    object(params.clientInfo) &&
    typeof params.clientInfo.name === "string" &&
    typeof params.clientInfo.version === "string"
      ? (params.clientInfo as McpContext["client"])
      : null;
  const session: Session = {
    initialized: false,
    client,
    capabilities: object(params.capabilities) ? params.capabilities : {},
    revision: revision as McpContext["protocolRevision"],
    environment: environment as McpRequestEnvironment<unknown>,
  };
  if (environment.sessionId) sessions.set(environment.sessionId, session);
  return success(id, {
    protocolVersion: revision,
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

export function createMcpServer<Dependencies = undefined>(
  options: McpServerOptions,
): McpServer<Dependencies> {
  const registries: Registries = {
    tools: new Map(),
    resources: new Map(),
    templates: [],
    prompts: new Map(),
    pageSize: Math.max(1, options.pageSize ?? 50),
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
      registries.resources.set(uri, { uri, options: primitiveOptions, handler });
      return api;
    },
    resourceTemplate(template, primitiveOptions, handler) {
      registries.templates.push({ template, options: primitiveOptions, handler });
      return api;
    },
    prompt(name, primitiveOptions: McpPromptOptions<ObjectSchema>, handler) {
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
        if (message.method === "initialize")
          return initialize(id, params, environment, options, sessions);
        if (message.method === "notifications/initialized") {
          if (session) session.initialized = true;
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
