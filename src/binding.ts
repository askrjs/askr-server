import type { Params } from "./contracts";

export class BindingError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "BindingError";
  }
}

export interface BindContext {
  request: Request;
  params: Params;
  url: URL;
  headers: Headers;
  query: URLSearchParams;
}

function queryValues(query: URLSearchParams): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  for (const [key, value] of query) {
    const previous = values[key];
    values[key] = previous === undefined
      ? value
      : Array.isArray(previous)
        ? [...previous, value]
        : [previous, value];
  }
  return values;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!["POST", "PUT", "PATCH"].includes(request.method)) return {};
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType) return {};
  const raw = await request.text();
  if (!raw) return {};
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BindingError("Request body contains invalid JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BindingError("Request body must be a JSON object.");
    }
    return value as Record<string, unknown>;
  }
  if (contentType === "application/x-www-form-urlencoded") {
    return queryValues(new URLSearchParams(raw));
  }
  return {};
}

export async function bind<T extends Record<string, unknown>>(context: BindContext): Promise<T> {
  const body = await readBody(context.request);
  const headers: Record<string, string> = {};
  context.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { ...body, ...queryValues(context.query), ...headers, ...context.params } as T;
}
