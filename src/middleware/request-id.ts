import type { Middleware } from "../contracts";
import { addHeaders } from "../http/headers";

export function requestId(options: { header?: string; generate?: () => string } = {}): Middleware {
  const header = options.header ?? "x-request-id";
  const generate = options.generate ?? (() => crypto.randomUUID());
  return async (ctx, next) => {
    const id = ctx.request.headers.get(header) ?? generate();
    ctx.state.requestId = id;
    return addHeaders(await next(), { [header]: id });
  };
}
