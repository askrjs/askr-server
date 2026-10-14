import type { AuthContext } from "@askrjs/auth";
import { describe, expect, it, vi } from "vite-plus/test";
import { createServerApp } from "../src/application";
import { createRouter } from "../src/router";
import type { ServerTelemetry, ServerTelemetryFields } from "../src/contracts";

const identity: AuthContext = {
  authenticated: true,
  principal: { id: "account" },
  session: null,
  tenant: null,
};

describe("request-bound provider token access", () => {
  it("replaces an enumerable resolver token with a private immutable request capability", async () => {
    const request = new Request("https://app.test/api");
    const tokenOptions = { resource: "graph", scopes: ["read"] };
    const token = vi.fn(async () => "PRIVATE_ACCESS_TOKEN");
    const resolved = Object.freeze({ ...identity, token: "RESOLVER_TOKEN_CANARY" });
    const resolver = { resolve: async () => resolved, token };
    const app = createServerApp({
      auth: resolver,
      router: createRouter().get("/api", async (context) => {
        expect(Object.keys(context.auth)).not.toContain("token");
        expect(JSON.stringify(context.auth)).not.toMatch(/PRIVATE_ACCESS_TOKEN|token/);
        expect(Object.getOwnPropertyDescriptor(context.auth, "token")).toMatchObject({
          enumerable: false,
          writable: false,
          configurable: false,
        });
        expect(await context.auth.token("microsoft", tokenOptions)).toBe("PRIVATE_ACCESS_TOKEN");
        return context.noContent();
      }),
    });
    expect((await app.fetch(request)).status).toBe(204);
    expect(token).toHaveBeenCalledExactlyOnceWith(request, "microsoft", tokenOptions);
    expect(resolved.token).toBe("RESOLVER_TOKEN_CANARY");
  });

  it("offers a safe configuration failure for manual auth and anonymous requests", async () => {
    const seen: unknown[] = [];
    const router = createRouter().get("/", async (context) => {
      try {
        await context.auth.token("google", { scopes: [] });
      } catch (error) {
        seen.push(error);
      }
      return context.noContent();
    });
    for (const auth of [undefined, { resolve: async () => identity }]) {
      expect(
        (await createServerApp({ router, auth }).fetch(new Request("https://app.test/"))).status,
      ).toBe(204);
    }
    expect(seen).toHaveLength(2);
    for (const error of seen) expect(error).toMatchObject({ code: "configuration" });
  });

  it("binds each invocation to its own Request during concurrent dispatch", async () => {
    const token = vi.fn(async (request: Request) => request.headers.get("x-account")!);
    const resolver = { resolve: async () => identity, token };
    const app = createServerApp({
      auth: resolver,
      router: createRouter().get("/", async (context) => {
        await Promise.resolve();
        return context.text(await context.auth.token("google", { scopes: ["read"] }));
      }),
    });
    const results = await Promise.all(
      ["first", "second"].map(async (account) => {
        const response = await app.fetch(
          new Request("https://app.test/", { headers: { "x-account": account } }),
        );
        return response.text();
      }),
    );
    expect(results).toEqual(["first", "second"]);
  });

  it("returns a safe internal failure when manual auth resolution rejects before dispatch", async () => {
    const handler = vi.fn(() => new Response("must not dispatch"));
    const app = createServerApp({
      auth: {
        resolve: async () => {
          throw new Error("PRIVATE_RESOLVER_CANARY");
        },
      },
      router: createRouter().get("/", handler),
    });
    const response = await app.fetch(new Request("https://app.test/"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("PRIVATE_RESOLVER_CANARY");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps token ownership through telemetry with extraction=%s",
    async (extract) => {
      const request = new Request("https://app.test/", {
        headers: { "x-request-id": "request-1", traceparent: "parent" },
      });
      const token = vi.fn(async () => "PRIVATE_ACCESS_TOKEN");
      const wrap = <T>(_fields: ServerTelemetryFields, work: () => T): T => work();
      const telemetry: ServerTelemetry = {
        request: vi.fn(wrap),
        routeMatch: wrap,
        loader: wrap,
        action: wrap,
        apiOperation: wrap,
        queryPrefetch: wrap,
        ssrRender: wrap,
        log: () => {},
        traceId: () => undefined,
        ...(extract
          ? {
              extract: (
                headers: Headers,
                getter: Parameters<NonNullable<ServerTelemetry["extract"]>>[1],
              ) => {
                expect(getter.keys(headers)).toEqual(["traceparent", "x-request-id"]);
                expect(getter.get(headers, "traceparent")).toBe("parent");
                expect(getter.get(headers, "missing")).toBeUndefined();
                return "parent-context";
              },
              withContext: <T>(context: unknown, work: () => T): T => {
                expect(context).toBe("parent-context");
                return work();
              },
            }
          : {}),
      };
      const app = createServerApp({
        auth: { resolve: async () => identity, token },
        telemetry,
        router: createRouter().get("/", async (context) => {
          expect(await context.auth.token("google", { scopes: ["read"] })).toBe(
            "PRIVATE_ACCESS_TOKEN",
          );
          expect(context.state.requestId).toBe("request-1");
          return context.noContent();
        }),
      });
      expect((await app.fetch(request)).status).toBe(204);
      expect(token).toHaveBeenCalledExactlyOnceWith(request, "google", { scopes: ["read"] });
      expect(telemetry.request).toHaveBeenCalledOnce();
    },
  );
});
