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

export interface MemoryRateLimitStoreOptions {
  readonly now?: () => number;
}

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

export function rateLimit(options: RateLimitOptions): Middleware {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error("rateLimit requires a positive integer limit.");
  }
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new Error("rateLimit requires a positive windowMs.");
  }
  const store = options.store ?? createMemoryRateLimitStore({ now: options.now });
  return async (context, next) => {
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
