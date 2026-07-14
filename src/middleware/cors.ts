import type { Middleware, ServerContext } from "../contracts";
import { addHeaders } from "../http/headers";

export interface CorsOptions {
  origin?: string | ((origin: string, context: ServerContext) => string | null);
  methods?: readonly string[];
  allowedHeaders?: readonly string[];
  exposedHeaders?: readonly string[];
  credentials?: boolean;
  maxAgeSeconds?: number;
}

function tokens(value: string | null): string[] {
  return value?.split(",").map((token) => token.trim()).filter(Boolean) ?? [];
}

function mergeVary(headers: Headers, ...values: string[]): void {
  const merged = tokens(headers.get("vary"));
  const seen = new Set(merged.map((value) => value.toLowerCase()));
  for (const value of values) {
    if (!seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      merged.push(value);
    }
  }
  if (merged.length) headers.set("vary", merged.join(", "));
}

function corsHeaders(origin: string, credentials: boolean): Headers {
  const headers = new Headers({ "access-control-allow-origin": origin });
  if (credentials) headers.set("access-control-allow-credentials", "true");
  return headers;
}

function rejected(ctx: ServerContext, message: string, ...vary: string[]): Response {
  const response = ctx.forbidden(message);
  const headers = new Headers({ vary: response.headers.get("vary") ?? "" });
  mergeVary(headers, "Origin", ...vary);
  return addHeaders(response, headers);
}

export function cors(options: CorsOptions = {}): Middleware {
  const configured = options.origin ?? "*";
  if (options.credentials && configured === "*") {
    throw new TypeError("CORS credentials cannot be used with a wildcard origin.");
  }
  const methods = (options.methods ?? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    .map((method) => method.toUpperCase());
  const allowedHeaders = options.allowedHeaders ?? ["content-type", "authorization", "x-request-id"];
  const allowedHeaderSet = new Set(allowedHeaders.map((header) => header.toLowerCase()));

  return async (ctx, next) => {
    const requestOrigin = ctx.request.headers.get("origin");
    if (!requestOrigin) return next();

    const resolved = typeof configured === "function"
      ? configured(requestOrigin, ctx)
      : configured === "*" || configured === requestOrigin ? configured : null;
    if (!resolved) return rejected(ctx, "Origin is not allowed");
    if (options.credentials && resolved === "*") {
      throw new TypeError("A dynamic CORS origin cannot return '*' when credentials are enabled.");
    }

    const requestedMethod = ctx.request.headers.get("access-control-request-method");
    const preflight = ctx.request.method === "OPTIONS" && requestedMethod !== null;
    if (preflight) {
      const normalizedMethod = requestedMethod.toUpperCase();
      if (!methods.includes(normalizedMethod)) {
        return rejected(ctx, "Requested method is not allowed", "Access-Control-Request-Method");
      }
      const requestedHeaders = tokens(ctx.request.headers.get("access-control-request-headers"));
      if (requestedHeaders.some((header) => !allowedHeaderSet.has(header.toLowerCase()))) {
        return rejected(
          ctx,
          "Requested headers are not allowed",
          "Access-Control-Request-Method",
          "Access-Control-Request-Headers",
        );
      }
      const headers = corsHeaders(resolved, options.credentials === true);
      headers.set("access-control-allow-methods", methods.join(", "));
      if (requestedHeaders.length) headers.set("access-control-allow-headers", allowedHeaders.join(", "));
      if (options.maxAgeSeconds !== undefined) {
        headers.set("access-control-max-age", String(options.maxAgeSeconds));
      }
      mergeVary(
        headers,
        "Origin",
        "Access-Control-Request-Method",
        ...(requestedHeaders.length ? ["Access-Control-Request-Headers"] : []),
      );
      return new Response(null, { status: 204, headers });
    }

    const response = await next();
    const headers = corsHeaders(resolved, options.credentials === true);
    if (options.exposedHeaders?.length) {
      headers.set("access-control-expose-headers", options.exposedHeaders.join(", "));
    }
    const existingVary = response.headers.get("vary");
    if (existingVary) headers.set("vary", existingVary);
    mergeVary(headers, "Origin");
    return addHeaders(response, headers);
  };
}
