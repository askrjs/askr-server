import type { AuthContext, AuthRequirement } from "@askrjs/auth";
import type { InferSchema, ObjectSchema, Schema } from "@askrjs/schema";

/** MCP protocol version negotiated between client and server. */
export type McpProtocolRevision = "2025-11-25" | "2025-06-18";
/** The transport an MCP session is communicating over. */
export type McpTransportKind = "http" | "stdio";
/** Severity level for {@link McpContext.log}, following syslog conventions. */
export type McpLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

/** A single piece of MCP content (text, image, resource link, etc.), keyed by `type`. */
export interface McpContent {
  type: string;
  [key: string]: unknown;
}

/**
 * The per-request context passed to tool/resource/prompt handlers, exposing client info,
 * negotiated protocol/transport details, and `progress`/`log` callbacks for sending
 * notifications back to the client.
 */
export interface McpContext<Dependencies = undefined> {
  readonly dependencies: Dependencies;
  readonly auth: AuthContext;
  readonly client: { name: string; version: string; title?: string } | null;
  readonly clientCapabilities: Readonly<Record<string, unknown>>;
  readonly protocolRevision: McpProtocolRevision;
  readonly transport: McpTransportKind;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
  progress(progress: number, total?: number, message?: string): void | Promise<void>;
  log(level: McpLogLevel, data: unknown, logger?: string): void | Promise<void>;
}

/** Metadata shared by tools, resources, and prompts. */
export interface McpPrimitiveOptions {
  title?: string;
  description?: string;
  auth?: AuthRequirement;
  annotations?: Readonly<Record<string, unknown>>;
}

/** Options for registering a tool via {@link McpServer.tool}. */
export interface McpToolOptions<
  Input extends ObjectSchema = ObjectSchema,
  Output extends Schema | undefined = undefined,
> extends McpPrimitiveOptions {
  input?: Input;
  output?: Output;
}

/** The result returned by a tool handler: content blocks and/or a typed structured result. */
export type McpToolResult<Output extends Schema | undefined = undefined> = {
  content?: readonly McpContent[];
  structuredContent?: Output extends Schema ? InferSchema<Output> : unknown;
  isError?: boolean;
};

/** Options for registering a resource via {@link McpServer.resource}. */
export interface McpResourceOptions extends McpPrimitiveOptions {
  name?: string;
  mimeType?: string;
}

/** Options for registering a prompt via {@link McpServer.prompt}. */
export interface McpPromptOptions<
  Arguments extends ObjectSchema = ObjectSchema,
> extends McpPrimitiveOptions {
  arguments?: Arguments;
}

/**
 * Transport-provided context for a single inbound MCP message, passed to
 * {@link McpServer.handle}. `send` (if provided) delivers server-to-client notifications for
 * push-capable transports.
 */
export interface McpRequestEnvironment<Dependencies = undefined> {
  dependencies: Dependencies;
  auth: AuthContext;
  transport: McpTransportKind;
  sessionId?: string;
  signal?: AbortSignal;
  send?(message: unknown): void | Promise<void>;
  supportsPush?: boolean;
}

/** Pluggable backing store for stateful MCP session IDs, used by the HTTP transport. */
export interface McpSessionStore {
  create(id: string): void | Promise<void>;
  has(id: string): boolean | Promise<boolean>;
  delete(id: string): boolean | Promise<boolean>;
}

/** Options for {@link createMcpServer}. */
export interface McpServerOptions {
  name: string;
  version: string;
  title?: string;
  instructions?: string;
  pageSize?: number;
}

/**
 * A Model Context Protocol server, as created by {@link createMcpServer}: register tools,
 * resources, resource templates, and prompts; push list-changed notifications; and dispatch
 * inbound JSON-RPC messages via `handle`.
 */
export interface McpServer<Dependencies = undefined> {
  tool<
    const Name extends string,
    Input extends ObjectSchema,
    Output extends Schema | undefined = undefined,
  >(
    name: Name,
    options: McpToolOptions<Input, Output>,
    handler: (
      context: McpContext<Dependencies>,
      input: InferSchema<Input>,
    ) => McpToolResult<Output> | Promise<McpToolResult<Output>>,
  ): McpServer<Dependencies>;
  resource(
    uri: string,
    options: McpResourceOptions,
    handler: (
      context: McpContext<Dependencies>,
      uri: URL,
    ) => McpContent | readonly McpContent[] | Promise<McpContent | readonly McpContent[]>,
  ): McpServer<Dependencies>;
  resourceTemplate(
    template: string,
    options: McpResourceOptions & {
      complete?: (
        argument: string,
        value: string,
      ) => readonly string[] | Promise<readonly string[]>;
    },
    handler: (
      context: McpContext<Dependencies>,
      uri: URL,
      variables: Readonly<Record<string, string>>,
    ) => McpContent | readonly McpContent[] | Promise<McpContent | readonly McpContent[]>,
  ): McpServer<Dependencies>;
  prompt<const Name extends string, Arguments extends ObjectSchema>(
    name: Name,
    options: McpPromptOptions<Arguments>,
    handler: (
      context: McpContext<Dependencies>,
      args: InferSchema<Arguments>,
    ) =>
      | { description?: string; messages: readonly unknown[] }
      | Promise<{ description?: string; messages: readonly unknown[] }>,
  ): McpServer<Dependencies>;
  notifyToolsChanged(): Promise<void>;
  notifyResourcesChanged(): Promise<void>;
  notifyPromptsChanged(): Promise<void>;
  handle(
    message: unknown,
    environment: McpRequestEnvironment<Dependencies>,
  ): Promise<unknown | undefined>;
  terminateSession(sessionId: string): void;
}
