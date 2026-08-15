import type { Middleware } from "../contracts";
import { addHeaders } from "../http/headers";

/** Pluggable backing store for {@link rateLimit}, tracking request counts per key/window. */
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
/** Options for {@link rateLimit}. */
export interface RateLimitOptions {
  readonly store?: RateLimitStore;
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Returns an application-trusted bucket identity. Proxy headers are
   * intentionally never interpreted by this middleware.
   */
  readonly key: (context: Parameters<Middleware>[0]) => string;
  readonly now?: () => number;
}

/** Options for {@link createMemoryRateLimitStore}. */
export interface MemoryRateLimitStoreOptions {
  readonly now?: () => number;
}

/**
 * Creates an in-memory {@link RateLimitStore} backed by a `Map`, suitable for single-process
 * deployments. Periodically prunes expired entries as a side effect of `consume` calls.
 *
 * @param options.now - Clock function used to determine window boundaries. Defaults to `Date.now`.
 */
export function createMemoryRateLimitStore(
  options: MemoryRateLimitStoreOptions = {},
): RateLimitStore {
  const entries = new Map<string, { count: number; reset: number }>();
  const now = options.now ?? Date.now;
  let operations = 0;
  return {
    async consume(key, limit, windowMs) {
      const current = now();
      let entry = entries.get(key);
      if (!entry || entry.reset <= current) {
        entry = { count: 0, reset: current + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      if (++operations % 64 === 0) {
        for (const [candidate, value] of entries) {
          if (value.reset <= current && candidate !== key) entries.delete(candidate);
        }
      }
      return {
        allowed: entry.count <= limit,
        remaining: Math.max(0, limit - entry.count),
        reset: entry.reset,
      };
    },
  };
}

/**
 * Creates middleware that enforces a request-rate limit per key (e.g. per client), adding
 * `RateLimit-*` response headers and returning `429 Too Many Requests` with `Retry-After`
 * when the limit is exceeded. Genuine CORS preflight requests (`OPTIONS` with both `Origin`
 * and `Access-Control-Request-Method`) are quota-neutral regardless of middleware order.
 *
 * @param options - Limit, window, key resolver, and optional store/clock.
 * @throws {Error} If `limit` is not a positive integer or `windowMs` is not positive.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error("rateLimit requires a positive integer limit.");
  }
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new Error("rateLimit requires a positive windowMs.");
  }
  const store = options.store ?? createMemoryRateLimitStore({ now: options.now });
  return async (context, next) => {
    if (
      context.request.method === "OPTIONS" &&
      context.request.headers.has("origin") &&
      context.request.headers.has("access-control-request-method")
    ) {
      return next();
    }
    const key = options.key(context);
    const result = await store.consume(key, options.limit, options.windowMs);
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
