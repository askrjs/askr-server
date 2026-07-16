import type { ObjectSchema, Schema } from "@askrjs/schema";
import type {
  McpContext,
  McpPrimitiveOptions,
  McpRequestEnvironment,
  McpResourceOptions,
} from "./types";

export type RecordValue = Record<string, unknown>;
type Entry = { name: string; options: McpPrimitiveOptions };
export type Tool = Entry & { input: ObjectSchema; output?: Schema; handler: Function };
export type Resource = { uri: string; options: McpResourceOptions; handler: Function };
export type Template = {
  template: string;
  options: McpResourceOptions & { complete?: Function };
  handler: Function;
};
export type Prompt = Entry & { arguments: ObjectSchema; handler: Function };
export type Session = {
  initialized: boolean;
  client: McpContext["client"];
  capabilities: RecordValue;
  revision: McpContext["protocolRevision"];
  environment: McpRequestEnvironment<unknown>;
};
export interface Registries {
  tools: Map<string, Tool>;
  resources: Map<string, Resource>;
  templates: Template[];
  prompts: Map<string, Prompt>;
  pageSize: number;
}

export const errorCode = {
  invalid: -32600,
  method: -32601,
  params: -32602,
  internal: -32603,
} as const;

export function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function failure(id: unknown, code: number, message: string, data?: unknown): RecordValue {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function success(id: unknown, result: unknown): RecordValue {
  return { jsonrpc: "2.0", id, result };
}

export function page<T>(values: readonly T[], cursor: unknown, size: number) {
  const start = typeof cursor === "string" && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const valuesPage = values.slice(start, start + size);
  const next = start + valuesPage.length;
  return { values: valuesPage, ...(next < values.length ? { nextCursor: String(next) } : {}) };
}

export async function visible(
  entry: { options: McpPrimitiveOptions },
  auth: McpRequestEnvironment["auth"],
): Promise<boolean> {
  return entry.options.auth ? (await entry.options.auth(auth)).allowed : true;
}

export function templateMatch(template: string, value: string): Record<string, string> | undefined {
  const names: string[] = [];
  const expression = template
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\{([^}]+)\\\}/g, (_, name: string) => {
      names.push(name);
      return "([^/]+)";
    });
  const match = new RegExp(`^${expression}$`).exec(value);
  return match
    ? Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]))
    : undefined;
}
