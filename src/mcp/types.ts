import type { AuthContext, AuthRequirement } from "@askrjs/auth";
import type { InferSchema, ObjectSchema, Schema } from "@askrjs/schema";

export type McpProtocolRevision = "2025-11-25" | "2025-06-18";
export type McpTransportKind = "http" | "stdio";
export type McpLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export interface McpContent {
  type: string;
  [key: string]: unknown;
}

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

export interface McpPrimitiveOptions {
  title?: string;
  description?: string;
  auth?: AuthRequirement;
  annotations?: Readonly<Record<string, unknown>>;
}

export interface McpToolOptions<
  Input extends ObjectSchema = ObjectSchema,
  Output extends Schema | undefined = undefined,
> extends McpPrimitiveOptions {
  input?: Input;
  output?: Output;
}

export type McpToolResult<Output extends Schema | undefined = undefined> = {
  content?: readonly McpContent[];
  structuredContent?: Output extends Schema ? InferSchema<Output> : unknown;
  isError?: boolean;
};

export interface McpResourceOptions extends McpPrimitiveOptions {
  name?: string;
  mimeType?: string;
}

export interface McpPromptOptions<
  Arguments extends ObjectSchema = ObjectSchema,
> extends McpPrimitiveOptions {
  arguments?: Arguments;
}

export interface McpRequestEnvironment<Dependencies = undefined> {
  dependencies: Dependencies;
  auth: AuthContext;
  transport: McpTransportKind;
  sessionId?: string;
  signal?: AbortSignal;
  send?(message: unknown): void | Promise<void>;
  supportsPush?: boolean;
}

export interface McpSessionStore {
  create(id: string): void | Promise<void>;
  has(id: string): boolean | Promise<boolean>;
  delete(id: string): boolean | Promise<boolean>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  title?: string;
  instructions?: string;
  pageSize?: number;
}

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
