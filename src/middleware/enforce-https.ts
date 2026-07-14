import type { Middleware } from "../contracts";

export function enforceHttps(
  options: { trustProxy?: boolean; status?: 301 | 302 | 307 | 308 } = {},
): Middleware {
  return async (ctx, next) => {
    const forwardedProtocol = options.trustProxy
      ? ctx.request.headers.get("x-forwarded-proto")
      : null;
    const protocol =
      forwardedProtocol?.split(",")[0]?.trim() ||
      new URL(ctx.request.url).protocol.replace(":", "");
    if (protocol === "https") return next();
    const url = new URL(ctx.request.url);
    url.protocol = "https:";
    return Response.redirect(url, options.status ?? 308);
  };
}
