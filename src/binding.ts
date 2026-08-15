import type { Params } from "./contracts";
import { hasBufferedRequestBody, readRequestFormData, readRequestText } from "./body-limit";
import { contentType } from "./http/media-types";

/** Error thrown when request data cannot be bound, e.g. an unreadable or malformed body. */
export class BindingError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly field?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BindingError";
  }
}

/** Minimal request context required by {@link bind} to gather body, query, and path values. */
export interface BindContext {
  request: Request;
  params: Params;
  url: URL;
  query: URLSearchParams;
}

type CollectedValue = FormDataEntryValue | string;

function dictionary<Value>(): Record<string, Value> {
  // The literal form is substantially cheaper in V8 than Object.create(null).
  return { __proto__: null } as unknown as Record<string, Value>;
}

function appendValue<Value>(
  values: Record<string, Value | Value[]>,
  key: string,
  value: Value,
): void {
  if (!Object.hasOwn(values, key)) {
    values[key] = value;
    return;
  }
  const previous = values[key];
  if (Array.isArray(previous)) previous.push(value);
  else values[key] = [previous, value];
}

function collectValues(
  entries: Iterable<readonly [string, CollectedValue]>,
): Record<string, CollectedValue | CollectedValue[]> {
  const values = dictionary<CollectedValue | CollectedValue[]>();
  for (const [key, value] of entries) appendValue(values, key, value);
  return values;
}

function queryValues(query: URLSearchParams): Record<string, string | string[]> {
  return collectValues(query) as Record<string, string | string[]>;
}

function overwriteValues(output: Record<string, unknown>, values: Record<string, unknown>): void {
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (key === "__proto__") {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    } else {
      output[key] = value;
    }
  }
}

function canHaveBody(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
}

function ensureUnread(request: Request): void {
  if (request.bodyUsed && !hasBufferedRequestBody(request))
    throw new BindingError("Request body has already been consumed.");
}

async function textBody(request: Request): Promise<string> {
  ensureUnread(request);
  try {
    return await readRequestText(request);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 413)
      throw error;
    throw new BindingError("Request body could not be read.", undefined, { cause: error });
  }
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await textBody(request);
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new BindingError("Request body contains invalid JSON.", undefined, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BindingError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

async function urlEncodedBody(request: Request): Promise<Record<string, string | string[]>> {
  const raw = await textBody(request);
  return raw ? queryValues(new URLSearchParams(raw)) : {};
}

async function multipartBody(
  request: Request,
): Promise<Record<string, FormDataEntryValue | FormDataEntryValue[]>> {
  ensureUnread(request);
  try {
    return collectValues(await readRequestFormData(request)) as Record<
      string,
      FormDataEntryValue | FormDataEntryValue[]
    >;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 413)
      throw error;
    throw new BindingError("Request body contains invalid multipart form data.", undefined, {
      cause: error,
    });
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!canHaveBody(request)) return {};
  const type = contentType(request.headers.get("content-type"));
  if (!type) return {};
  if (type === "application/json" || type.endsWith("+json")) return jsonBody(request);
  if (type === "application/x-www-form-urlencoded") return urlEncodedBody(request);
  if (type === "multipart/form-data") return multipartBody(request);
  return {};
}

/**
 * Merges a request's body, query string, and path parameters into a single object, in that
 * precedence order (path parameters win, then query string, then body). Supports JSON,
 * URL-encoded, and multipart/form-data bodies; unrecognized content types yield an empty body.
 *
 * @param context - The request, URL, query, and path parameters to bind from.
 * @returns The merged values, cast to `T`.
 * @throws {BindingError} If the body cannot be read or parsed for its declared content type.
 */
export async function bind<T extends object = Record<string, unknown>>(
  context: BindContext,
): Promise<T> {
  const body = await readBody(context.request);
  const output = Object.getPrototypeOf(body) === Object.prototype ? body : {};
  if (output !== body) overwriteValues(output, body);
  overwriteValues(output, queryValues(context.query));
  overwriteValues(output, context.params);
  return output as T;
}
