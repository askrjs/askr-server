import type { Middleware, ServerContext } from "../contracts";
import { addHeaders } from "../http/headers";

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
