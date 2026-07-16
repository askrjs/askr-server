import type { ServerContext } from "../contracts";
import type { ResponseDefinition } from "./types";

function isDevelopment(): boolean {
  const processLike = (globalThis as {
    process?: { env?: { NODE_ENV?: string } };
  }).process;
  return processLike?.env?.NODE_ENV !== "production";
}

export async function validateOperationResponse(
  enabled: boolean | undefined,
  definitions: readonly ResponseDefinition[],
  response: Response,
  context: ServerContext,
): Promise<Response> {
  if (!enabled || !isDevelopment()) return response;
  const definition = definitions.find((item) => item.status === String(response.status));
  if (!definition?.schema) return response;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== definition.mediaType) {
    return context.problem(500, "Operation response did not use its declared media type.", {
      extensions: { expected: definition.mediaType, received: contentType ?? null },
    });
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return context.problem(500, "Operation response body could not be validated as JSON.");
  }
  const result = definition.schema.safeParse(body);
  if (result.success) return response;
  return context.problem(500, "Operation response did not match its declared schema.", {
    extensions: {
      issues: result.issues.map((issue) => ({ ...issue, path: ["response", ...issue.path] })),
    },
  });
}
