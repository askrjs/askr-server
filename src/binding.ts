import type { Params } from "./contracts";

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

export interface BindContext {
  request: Request;
  params: Params;
  url: URL;
  headers: Headers;
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

function mediaType(request: Request): string | undefined {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

function canHaveBody(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
}

function ensureUnread(request: Request): void {
  if (request.bodyUsed) throw new BindingError("Request body has already been consumed.");
}

async function textBody(request: Request): Promise<string> {
  ensureUnread(request);
  try {
    return await request.text();
  } catch (error) {
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
    return collectValues(await request.formData()) as Record<
      string,
      FormDataEntryValue | FormDataEntryValue[]
    >;
  } catch (error) {
    throw new BindingError("Request body contains invalid multipart form data.", undefined, {
      cause: error,
    });
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!canHaveBody(request)) return {};
  const type = mediaType(request);
  if (!type) return {};
  if (type === "application/json" || type.endsWith("+json")) return jsonBody(request);
  if (type === "application/x-www-form-urlencoded") return urlEncodedBody(request);
  if (type === "multipart/form-data") return multipartBody(request);
  return {};
}

function headerValues(headers: Headers): Record<string, string> {
  const values = dictionary<string>();
  headers.forEach((value, key) => {
    values[key] = value;
  });
  return values;
}

export async function bind<T extends object = Record<string, unknown>>(context: BindContext): Promise<T> {
  const body = await readBody(context.request);
  return {
    ...body,
    ...queryValues(context.query),
    ...headerValues(context.headers),
    ...context.params,
  } as T;
}
