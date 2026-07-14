import type { Middleware, ServerContext } from "../contracts";

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
