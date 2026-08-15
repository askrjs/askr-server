import type { Middleware } from "../contracts";
import { addHeaders } from "../http/headers";

/**
 * Creates middleware that reads a request ID from an incoming header (generating one if
 * absent), stores it on `ctx.state.requestId`, and echoes it back on the response header.
 *
 * @param options.header - Header name to read/write. Defaults to `x-request-id`.
 * @param options.generate - ID generator used when the header is absent. Defaults to `crypto.randomUUID()`.
 */
export function requestId(options: { header?: string; generate?: () => string } = {}): Middleware {
  const header = options.header ?? "x-request-id";
  const generate = options.generate ?? (() => crypto.randomUUID());
  return async (ctx, next) => {
    const id = ctx.request.headers.get(header) ?? generate();
    ctx.state.requestId = id;
    return addHeaders(await next(), { [header]: id });
  };
}
