import type { Middleware, ServerContext } from "../contracts";
import { addHeaders } from "../http/headers";

export interface CorsOptions {
  origin?: string | ((origin: string | null, context: ServerContext) => string | null);
  methods?: readonly string[];
  allowedHeaders?: readonly string[];
  exposedHeaders?: readonly string[];
  credentials?: boolean;
  maxAgeSeconds?: number;
}

export function cors(options: CorsOptions = {}): Middleware {
  const methods = options.methods ?? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  const allowedHeaders = options.allowedHeaders ?? [
    "content-type",
    "authorization",
    "x-request-id",
  ];
  return async (ctx, next) => {
    const origin = ctx.request.headers.get("origin");
    const configuredOrigin =
      typeof options.origin === "function" ? options.origin(origin, ctx) : (options.origin ?? "*");
    if (!configuredOrigin) return ctx.forbidden("Origin is not allowed");
    const response =
      ctx.request.method === "OPTIONS" ? new Response(null, { status: 204 }) : await next();
    const headers = new Headers({
      "access-control-allow-origin": configuredOrigin,
      "access-control-allow-methods": methods.join(", "),
      "access-control-allow-headers": allowedHeaders.join(", "),
    });
    if (options.credentials) headers.set("access-control-allow-credentials", "true");
    if (options.exposedHeaders?.length)
      headers.set("access-control-expose-headers", options.exposedHeaders.join(", "));
    if (options.maxAgeSeconds !== undefined)
      headers.set("access-control-max-age", String(options.maxAgeSeconds));
    if (configuredOrigin !== "*") headers.set("vary", "Origin");
    return addHeaders(response, headers);
  };
}
