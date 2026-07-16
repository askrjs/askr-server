import type { Issue } from "@askrjs/schema";
import type { ServerContext } from "../contracts";
import type { ApiBodyInput, ApiInput, InferApiInput } from "./types";

export type OperationInputResult<Input extends ApiInput> =
  | { readonly success: true; readonly data: InferApiInput<Input> }
  | { readonly success: false; readonly status: 400; readonly detail: string }
  | { readonly success: false; readonly status: 422; readonly issues: readonly Issue[] };

function appendValue(
  output: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!Object.hasOwn(output, key)) {
    output[key] = value;
    return;
  }
  const previous = output[key];
  output[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
}

function entries(input: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of input) appendValue(output, key, value);
  return output;
}

function mediaType(request: Request): string | undefined {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

async function readBody(request: Request, declaration: ApiBodyInput): Promise<
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly detail: string }
> {
  if (request.bodyUsed) {
    return { success: false, detail: "Request body has already been consumed." };
  }
  if (request.body === null) return { success: true, data: {} };
  const type = mediaType(request);
  if (!type || !declaration.mediaTypes.map((value) => value.toLowerCase()).includes(type)) {
    return {
      success: false,
      detail: type
        ? `Content type ${type} is not allowed for this operation.`
        : "A content type is required for a declared request body.",
    };
  }
  try {
    if (type === "application/json" || type?.endsWith("+json")) {
      const source = await request.text();
      if (!source.trim()) return { success: false, detail: "Request body contains empty JSON." };
      try {
        return { success: true, data: JSON.parse(source) as unknown };
      } catch {
        return { success: false, detail: "Request body contains invalid JSON." };
      }
    }
    if (type === "application/x-www-form-urlencoded") {
      return { success: true, data: entries(new URLSearchParams(await request.text()).entries()) };
    }
    if (type === "multipart/form-data") {
      return { success: true, data: entries((await request.formData()).entries()) };
    }
    return {
      success: false,
      detail: type
        ? `Content type ${type} is not supported for declared request bodies.`
        : "A content type is required for a declared request body.",
    };
  } catch {
    return { success: false, detail: "Request body could not be read." };
  }
}

export async function readOperationInput<Input extends ApiInput>(
  context: ServerContext,
  input: Input,
): Promise<OperationInputResult<Input>> {
  const sources: Partial<Record<keyof ApiInput, unknown>> = {
    params: context.params,
    query: entries(context.query.entries()),
    headers: Object.fromEntries(context.headers.entries()),
  };
  if (input.body) {
    const body = await readBody(context.request, input.body);
    if (!body.success) return { success: false, status: 400, detail: body.detail };
    sources.body = body.data;
  }

  const data: Record<string, unknown> = {};
  const issues: Issue[] = [];
  for (const source of ["params", "query", "headers", "body"] as const) {
    const value = source === "body"
      ? input.body?.schema
      : input[source];
    if (!value) continue;
    const result = value.safeParse(sources[source]);
    if (result.success) {
      data[source] = result.data;
    } else {
      issues.push(...result.issues.map((entry: Issue) => Object.freeze({
        ...entry,
        path: Object.freeze([source, ...entry.path]),
      })));
    }
  }
  return issues.length
    ? { success: false, status: 422, issues: Object.freeze(issues) }
    : { success: true, data: data as InferApiInput<Input> };
}
