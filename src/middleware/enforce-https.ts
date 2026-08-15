import type { Middleware } from "../contracts";

/**
 * Creates middleware that redirects non-HTTPS requests to their HTTPS equivalent.
 *
 * @param options.trustProxy - When true, honors the `X-Forwarded-Proto` header (first value)
 * instead of the request's own scheme, for use behind a TLS-terminating proxy.
 * @param options.status - Redirect status code to use. Defaults to `308` (permanent, method-preserving).
 */
export function enforceHttps(
  options: { trustProxy?: boolean; status?: 301 | 302 | 307 | 308 } = {},
): Middleware {
  return async (ctx, next) => {
    const forwardedProtocol = options.trustProxy
      ? ctx.request.headers.get("x-forwarded-proto")
      : null;
    const separator = forwardedProtocol?.indexOf(",") ?? -1;
    const forwarded = forwardedProtocol
      ? (separator === -1 ? forwardedProtocol : forwardedProtocol.slice(0, separator)).trim()
      : "";
    const protocol = forwarded || ctx.url.protocol.slice(0, -1);
    if (protocol.toLowerCase() === "https") return next();
    const url = new URL(ctx.url);
    url.protocol = "https:";
    return Response.redirect(url, options.status ?? 308);
  };
}
