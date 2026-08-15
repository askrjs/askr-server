import type { Middleware } from "../contracts";

/** Callback invoked by {@link accessLog} with details of a completed request. */
export type ResponseLogger = (entry: {
  request: Request;
  response: Response;
  durationMs: number;
  requestId?: string;
}) => void;

/**
 * Creates middleware that times each request and invokes `logger` with the request, response,
 * duration, and (if present) request ID after the downstream chain resolves.
 *
 * @param logger - Called once per request with the completed entry.
 */
export function accessLog(logger: ResponseLogger): Middleware {
  return async (ctx, next) => {
    const started = performance.now();
    const response = await next();
    logger({
      request: ctx.request,
      response,
      durationMs: performance.now() - started,
      requestId: typeof ctx.state.requestId === "string" ? ctx.state.requestId : undefined,
    });
    return response;
  };
}
