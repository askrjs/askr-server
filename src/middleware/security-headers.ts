import type { Middleware, ServerContext } from "../contracts";
import { addHeaders } from "../http/headers";

/**
 * Creates middleware that adds standard security headers to every response:
 * `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`, and (if configured)
 * `Content-Security-Policy`.
 *
 * @param options.contentSecurityPolicy - A static CSP string, or a function of the request
 * context (e.g. to embed a per-request nonce). Omitted if not set.
 * @param options.referrerPolicy - Defaults to `strict-origin-when-cross-origin`.
 * @param options.frameOptions - Defaults to `DENY`.
 */
export function securityHeaders(
  options: {
    contentSecurityPolicy?: string | ((context: ServerContext) => string);
    referrerPolicy?: string;
    frameOptions?: string;
  } = {},
): Middleware {
  return async (context, next) => {
    const response = await next();
    const headers = new Headers({
      "x-content-type-options": "nosniff",
      "referrer-policy": options.referrerPolicy ?? "strict-origin-when-cross-origin",
      "x-frame-options": options.frameOptions ?? "DENY",
    });
    if (options.contentSecurityPolicy) {
      headers.set(
        "content-security-policy",
        typeof options.contentSecurityPolicy === "function"
          ? options.contentSecurityPolicy(context)
          : options.contentSecurityPolicy,
      );
    }
    return addHeaders(response, headers);
  };
}
