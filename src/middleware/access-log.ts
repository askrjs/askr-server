import type { Middleware } from "../contracts";

export type ResponseLogger = (entry: {
  request: Request;
  response: Response;
  durationMs: number;
  requestId?: string;
}) => void;

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
