import { describe, expect, it, vi } from "vitest";
import type { ApiRoute, Middleware } from "../src/contracts";
import { anonymousAuthContext, createServerContext } from "../src/context";
import { dispatchRequest, MiddlewareNextError } from "../src/dispatch";

const context = (method = "GET") =>
  createServerContext(
    new Request("https://example.test/items", { method }),
    anonymousAuthContext(),
    {},
  );
const route = (handler: ApiRoute["handler"], middleware?: readonly Middleware[]): ApiRoute => ({
  path: "/items",
  method: "GET",
  handler,
  middleware,
});
const options = (errorResponse: (error: unknown) => Response | Promise<Response>) => ({
  errorResponse,
});

describe("request dispatch", () => {
  it("should nest global and route middleware around the terminal handler", async () => {
    const order: string[] = [];
    const global: Middleware = async (_context, next) => {
      order.push("global-before");
      const response = await next();
      order.push("global-after");
      return response;
    };
    const local: Middleware = async (_context, next) => {
      order.push("route-before");
      const response = await next();
      order.push("route-after");
      return response;
    };
    const matched = route(() => {
      order.push("handler");
      return new Response("ok");
    }, [local]);

    const response = await dispatchRequest(
      [global],
      context(),
      { match: { route: matched, params: {} }, allowed: [] },
      options((error) => Promise.reject(error)),
    );

    expect(await response.text()).toBe("ok");
    expect(order).toEqual([
      "global-before",
      "route-before",
      "handler",
      "route-after",
      "global-after",
    ]);
  });

  it("should report a structured error when middleware calls next twice", async () => {
    let observed: unknown;
    const handler = vi.fn(() => new Response("ok"));
    const response = await dispatchRequest(
      [
        async (_context, next) => {
          await next();
          return next();
        },
      ],
      context(),
      { match: { route: route(handler), params: {} }, allowed: [] },
      options((error) => {
        observed = error;
        return new Response("handled", { status: 500 });
      }),
    );

    expect(response.status).toBe(500);
    expect(observed).toBeInstanceOf(MiddlewareNextError);
    expect(observed).toMatchObject({
      name: "MiddlewareNextError",
      code: "middleware_next_reused",
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should send middleware failures to the configured error response", async () => {
    const failure = new Error("middleware failed");
    const errorResponse = vi.fn(() => new Response("recovered", { status: 503 }));

    const response = await dispatchRequest(
      [async () => Promise.reject(failure)],
      context(),
      { allowed: [] },
      options(errorResponse),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("recovered");
    expect(errorResponse).toHaveBeenCalledWith(failure, expect.any(Object));
  });

  it("should execute terminal route, method, and fallback outcomes", async () => {
    const matched = route(() => new Response("matched", { status: 201 }));
    const direct = await dispatchRequest(
      [],
      context(),
      { match: { route: matched, params: {} }, allowed: [] },
      options((error) => Promise.reject(error)),
    );
    const method = await dispatchRequest(
      [],
      context("DELETE"),
      { allowed: ["GET", "HEAD"] },
      options((error) => Promise.reject(error)),
    );
    const fallback = await dispatchRequest(
      [],
      context(),
      { allowed: [] },
      {
        fallback: () => new Response("fallback", { status: 418 }),
        errorResponse: (error) => Promise.reject(error),
      },
    );

    expect(direct.status).toBe(201);
    expect(await direct.text()).toBe("matched");
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, HEAD");
    expect(fallback.status).toBe(418);
    expect(await fallback.text()).toBe("fallback");
  });
});
