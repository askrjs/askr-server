import type { Middleware } from "../contracts";
import { addHeaders } from "../http/headers";

export interface RateLimitStore {
  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{
    readonly remaining: number;
    /** Epoch milliseconds at which the current window resets. */
    readonly reset: number;
    readonly allowed: boolean;
  }>;
}
export interface RateLimitOptions {
  readonly store: RateLimitStore;
  readonly limit: number;
  readonly windowMs: number;
  readonly key?: (context: Parameters<Middleware>[0]) => string;
  readonly now?: () => number;
}

export function rateLimit(options: RateLimitOptions): Middleware {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error("rateLimit requires a positive integer limit.");
  }
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new Error("rateLimit requires a positive windowMs.");
  }
  return async (context, next) => {
    const key =
      options.key?.(context) ??
      context.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
      "anonymous";
    const result = await options.store.consume(key, options.limit, options.windowMs);
    const now = options.now?.() ?? Date.now();
    const resetSeconds = Math.max(0, Math.ceil((result.reset - now) / 1000));
    const headers = new Headers({
      "RateLimit-Limit": String(options.limit),
      "RateLimit-Remaining": String(Math.max(0, result.remaining)),
      "RateLimit-Reset": String(resetSeconds),
    });
    if (!result.allowed) {
      headers.set("Retry-After", String(resetSeconds));
      return context.tooManyRequests("Rate limit exceeded.", { headers });
    }
    const response = await next();
    return addHeaders(response, headers);
  };
}
