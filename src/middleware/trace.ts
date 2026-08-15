import type { Middleware, ServerContext } from "../contracts";

/**
 * Creates middleware that invokes `start` at the beginning of each request and, if it returns
 * a function, invokes that function after the downstream chain settles (success or throw) —
 * e.g. to open and close a tracing span around the request.
 *
 * @param start - Called with the request context; may return a cleanup/finish callback.
 */
export function trace(
  start: (context: ServerContext) => void | (() => void | Promise<void>),
): Middleware {
  return async (ctx, next) => {
    const finish = start(ctx);
    try {
      return await next();
    } finally {
      await finish?.();
    }
  };
}
