import { describe, expect, it } from "vite-plus/test";
import { createServerApp } from "./test-app";
import { PayloadTooLargeError, readRequestBytes } from "../src/body-limit";
import { bind, BindingError } from "../src/binding";
import type {
  AccessDeniedHandler,
  Handler,
  Middleware,
  Next,
  ProbeHandler,
} from "../src/contracts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const decoder = new TextDecoder();

describe("owned request body lifetime", () => {
  it.each([
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=test",
  ])(
    "maps an aborted %s body to a binding failure with the original cause",
    async (contentType) => {
      const entered = deferred<void>();
      let cancelled = 0;
      const controller = new AbortController();
      const reason = new Error("binding read aborted");
      const request = new Request("https://askr.test/", {
        method: "POST",
        duplex: "half",
        signal: controller.signal,
        headers: { "content-type": contentType },
        body: new ReadableStream<Uint8Array>(
          {
            pull() {
              entered.resolve();
            },
            cancel(value) {
              expect(value).toBe(reason);
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
      } as RequestInit);
      const url = new URL(request.url);
      const pending = bind({ request, url, params: {}, query: url.searchParams });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "BindingError",
        cause: reason,
      });
      await entered.promise;
      controller.abort(reason);
      await rejected;
      await expect(pending).rejects.toBeInstanceOf(BindingError);
      expect(cancelled).toBe(1);
      expect(request.body!.locked).toBe(false);
    },
  );

  it("does not pull a body after its request was already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted before reading");
    let cancelled = 0,
      pulled = 0;
    const request = new Request("https://askr.test/", {
      method: "POST",
      duplex: "half",
      signal: controller.signal,
      body: new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled++;
          },
          cancel(value) {
            expect(value).toBe(reason);
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
    } as RequestInit);
    controller.abort(reason);
    await expect(readRequestBytes(request, 4)).rejects.toBe(reason);
    expect(pulled).toBe(0);
    expect(cancelled).toBe(1);
    expect(request.body!.locked).toBe(false);
  });

  it("rejects a cached body after abort without canceling an already consumed stream", async () => {
    const controller = new AbortController();
    const request = new Request("https://askr.test/", {
      method: "POST",
      body: "1234",
      signal: controller.signal,
    });
    await readRequestBytes(request, 4);
    const reason = new Error("aborted after reading");
    controller.abort(reason);
    await expect(readRequestBytes(request, 4)).rejects.toBe(reason);
    expect(request.body!.locked).toBe(false);
  });

  it.each([4, 5])("bounds chunked bodies without Content-Length at %i bytes", async (length) => {
    const request = new Request("https://askr.test/", {
      method: "POST",
      duplex: "half",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("null"));
          if (length > 4) controller.enqueue(new Uint8Array([32]));
          controller.close();
        },
      }),
    } as RequestInit);
    expect(request.headers.has("content-length")).toBe(false);
    if (length === 4) expect(decoder.decode(await readRequestBytes(request, 4))).toBe("null");
    else await expect(readRequestBytes(request, 4)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("honors a stricter limit when a body has already been buffered, without poisoning later reads", async () => {
    const request = new Request("https://askr.test/", { method: "POST", body: "1234" });
    const first = await readRequestBytes(request, 4);
    await expect(readRequestBytes(request, 3)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(await readRequestBytes(request, 4)).toBe(first);
  });

  it.each(["throws", "never settles"])(
    "reports oversized body promptly when cancellation %s",
    async (mode) => {
      const cancel = deferred<void>();
      let cancellations = 0,
        failure: unknown;
      const request = new Request("https://askr.test/", {
        method: "POST",
        duplex: "half",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(5));
          },
          cancel() {
            cancellations++;
            if (mode === "throws") throw new Error("cancel failed");
            return cancel.promise;
          },
        }),
      } as RequestInit);
      const pending = readRequestBytes(request, 4);
      void pending.catch((error: unknown) => {
        failure = error;
      });
      try {
        await expect.poll(() => failure).toBeInstanceOf(PayloadTooLargeError);
        expect(request.body!.locked).toBe(false);
        expect(cancellations).toBe(1);
      } finally {
        cancel.resolve();
        await pending.catch(() => {});
      }
    },
  );

  it.each(["throws", "never settles"])(
    "aborts a stalled body read when cancellation %s",
    async (mode) => {
      const entered = deferred<void>(),
        cancel = deferred<void>();
      const controller = new AbortController();
      const reason = new Error("request aborted");
      let source!: ReadableStreamDefaultController<Uint8Array>;
      let cancellations = 0,
        failure: unknown;
      const request = new Request("https://askr.test/", {
        method: "POST",
        duplex: "half",
        signal: controller.signal,
        body: new ReadableStream<Uint8Array>({
          start(value) {
            source = value;
          },
          pull() {
            entered.resolve();
          },
          cancel() {
            cancellations++;
            if (mode === "throws") throw new Error("cancel failed");
            return cancel.promise;
          },
        }),
      } as RequestInit);
      const pending = readRequestBytes(request, 4);
      void pending.catch((error: unknown) => {
        failure = error;
      });
      await entered.promise;
      controller.abort(reason);
      try {
        await expect.poll(() => failure).toBe(reason);
        expect(cancellations).toBe(1);
        expect(request.body!.locked).toBe(false);
      } finally {
        if (cancellations === 0) source.close();
        cancel.resolve();
        await pending.catch(() => {});
      }
    },
  );
});

describe("owned response lifetime", () => {
  it.each(["global", "route"])(
    "retires a synchronous %s continuation before queued work runs",
    async (kind) => {
      const attempted = deferred<unknown>();
      let calls = 0;
      const middleware: Middleware = (_context, next) => {
        queueMicrotask(() => {
          try {
            void next();
            attempted.resolve(undefined);
          } catch (error) {
            attempted.resolve(error);
          }
        });
        return new Response("short circuit");
      };
      const app = createServerApp({
        middleware: kind === "global" ? [middleware] : [],
        routes: [
          {
            path: "/",
            middleware: kind === "route" ? [middleware] : [],
            handler: () => {
              calls++;
              return new Response("unreachable");
            },
          },
        ],
      });
      expect(await (await app.fetch(new Request("https://askr.test/"))).text()).toBe(
        "short circuit",
      );
      expect(await attempted.promise).toBeInstanceOf(Error);
      expect(calls).toBe(0);
    },
  );

  it("isolates failed error handlers across overlapping requests", async () => {
    const failed = deferred<void>();
    const reason = new Error("first error handler failed");
    const calls: string[] = [];
    const app = createServerApp({
      routes: [
        {
          path: "/{id}",
          handler: () => {
            throw new Error("route failed");
          },
        },
      ],
      middleware: [(_context, next) => next()],
      onError: async (_error, context) => {
        calls.push(context.params.id!);
        if (context.params.id === "one") {
          failed.resolve();
          throw reason;
        }
        await failed.promise;
        return new Response("recovered two", { status: 503 });
      },
    });
    const results = await Promise.allSettled(
      ["one", "two"].map((id) => app.fetch(new Request(`https://askr.test/${id}`))),
    );
    expect(results[0]).toEqual({ status: "rejected", reason });
    expect(results[1]!.status).toBe("fulfilled");
    if (results[1]!.status === "fulfilled")
      expect(await results[1].value.text()).toBe("recovered two");
    expect(calls.sort()).toEqual(["one", "two"]);
  });

  it.each(
    [undefined, null, "invalid", {}].flatMap((value) =>
      [false, true].map((global) => ({ value, global })),
    ),
  )(
    "rejects an invalid error-handler result $value with global middleware $global",
    async ({ value, global }) => {
      let calls = 0;
      const app = createServerApp({
        routes: [
          {
            path: "/",
            handler: () => {
              throw new Error("route failed");
            },
          },
        ],
        middleware: global ? [(_context, next) => next(), (_context, next) => next()] : [],
        onError: (() => {
          calls++;
          return value;
        }) as (error: unknown) => Response,
      });
      await expect(app.fetch(new Request("https://askr.test/"))).rejects.toThrow(
        /onError.*Response/u,
      );
      expect(calls).toBe(1);
    },
  );

  it.each([false, true])(
    "preserves an error-handler failure exactly once when async is %s",
    async (asynchronous) => {
      let calls = 0;
      const reason = new Error("error handler failed");
      const app = createServerApp({
        routes: [
          {
            path: "/",
            handler: () => {
              throw new Error("route failed");
            },
          },
        ],
        middleware: [(_context, next) => next(), (_context, next) => next()],
        onError: () => {
          calls++;
          if (asynchronous) return Promise.reject(reason);
          throw reason;
        },
      });
      await expect(app.fetch(new Request("https://askr.test/"))).rejects.toBe(reason);
      expect(calls).toBe(1);
    },
  );

  it.each(["same response", "same body", "clone"])(
    "preserves the delivered stream when middleware returns the %s",
    async (mode) => {
      let cancelled = 0;
      const app = createServerApp({
        routes: [
          {
            path: "/",
            handler: () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("delivered"));
                    controller.close();
                  },
                  cancel() {
                    cancelled++;
                  },
                }),
              ),
          },
        ],
        middleware: [
          async (_context, next) => {
            const response = await next();
            return mode === "same response"
              ? response
              : mode === "same body"
                ? new Response(response.body)
                : response.clone();
          },
        ],
      });
      expect(await (await app.fetch(new Request("https://askr.test/"))).text()).toBe("delivered");
      expect(cancelled).toBe(0);
    },
  );

  it("discards a replaced downstream stream without canceling its replacement", async () => {
    let discarded = 0,
      replacementCancelled = 0;
    const app = createServerApp({
      routes: [
        {
          path: "/",
          handler: () =>
            new Response(
              new ReadableStream({
                cancel() {
                  discarded++;
                },
              }),
            ),
        },
      ],
      middleware: [
        async (_context, next) => {
          await next();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("replacement"));
                controller.close();
              },
              cancel() {
                replacementCancelled++;
              },
            }),
          );
        },
      ],
    });
    expect(await (await app.fetch(new Request("https://askr.test/"))).text()).toBe("replacement");
    await expect.poll(() => discarded).toBe(1);
    expect(replacementCancelled).toBe(0);
  });

  it.each([null, "healthy", 1, {}])(
    "fails closed when a probe returns invalid result %j",
    async (value) => {
      const app = createServerApp({ probes: { readyz: (() => value) as ProbeHandler } });
      const response = await app.fetch(new Request("https://askr.test/readyz"));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await app.fetch(new Request("https://askr.test/livez"))).status).toBe(200);
    },
  );

  it.each(["global", "route"])(
    "retires the %s middleware continuation after return",
    async (kind) => {
      let saved!: Next,
        calls = 0;
      const middleware: Middleware = (_context, next) => {
        saved = next;
        return new Response("short circuit");
      };
      const app = createServerApp({
        middleware: kind === "global" ? [middleware] : [],
        routes: [
          {
            path: "/",
            middleware: kind === "route" ? [middleware] : [],
            handler: () => {
              calls++;
              return new Response("must not run");
            },
          },
        ],
      });
      expect(await (await app.fetch(new Request("https://askr.test/"))).text()).toBe(
        "short circuit",
      );
      await expect(Promise.resolve().then(() => saved())).rejects.toThrow(/next\(\).*middleware/iu);
      expect(calls).toBe(0);
    },
  );

  it.each([undefined, null, "invalid", {}])(
    "does not execute a denied route when the denial handler returns %j",
    async (value) => {
      let calls = 0,
        observed: unknown;
      const app = createServerApp({
        routes: [
          {
            path: "/",
            auth: () => ({ allowed: false, reason: "forbidden" }),
            handler: () => {
              calls++;
              return new Response("secret");
            },
          },
        ],
        onAccessDenied: (() => value) as AccessDeniedHandler,
        onError: (error) => {
          observed = error;
          return new Response("handled", { status: 500 });
        },
      });
      const response = await app.fetch(new Request("https://askr.test/"));
      expect(response?.status).toBe(500);
      expect(calls).toBe(0);
      expect(observed).toBeInstanceOf(TypeError);
      expect((observed as Error).message).toMatch(/denial.*Response/iu);
    },
  );

  it.each(["succeeds", "throws", "never settles"])(
    "discards the suppressed HEAD body when cancellation %s",
    async (mode) => {
      let cancelled = 0;
      const app = createServerApp({
        routes: [
          {
            path: "/",
            handler: () =>
              new Response(
                new ReadableStream({
                  cancel() {
                    cancelled++;
                    if (mode === "throws") throw new Error("cancel failed");
                    if (mode === "never settles") return new Promise<void>(() => undefined);
                  },
                }),
                { headers: { "x-source": "handler" } },
              ),
          },
        ],
      });
      const response = await app.fetch(new Request("https://askr.test/", { method: "HEAD" }));
      expect(response.body).toBeNull();
      expect(response.headers.get("x-source")).toBe("handler");
      await expect.poll(() => cancelled).toBe(1);
      expect((await app.fetch(new Request("https://askr.test/missing"))).status).toBe(404);
    },
  );

  it("discards a downstream response when middleware throws after next", async () => {
    let cancelled = 0;
    const reason = new Error("middleware failed");
    const app = createServerApp({
      routes: [
        {
          path: "/",
          handler: () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled++;
                },
              }),
            ),
        },
      ],
      middleware: [
        async (_context, next) => {
          await next();
          throw reason;
        },
      ],
      onError: (error) => {
        expect(error).toBe(reason);
        return new Response("handled", { status: 500 });
      },
    });
    expect(await (await app.fetch(new Request("https://askr.test/"))).text()).toBe("handled");
    await expect.poll(() => cancelled).toBe(1);
  });

  it("discards a late downstream response after middleware has already failed", async () => {
    const entered = deferred<void>(),
      reply = deferred<Response>();
    let cancelled = 0;
    const app = createServerApp({
      routes: [
        {
          path: "/",
          handler: () => {
            entered.resolve();
            return reply.promise;
          },
        },
      ],
      middleware: [
        async (_context, next) => {
          void next();
          await entered.promise;
          throw new Error("failed first");
        },
      ],
      onError: () => new Response("handled", { status: 500 }),
    });
    expect((await app.fetch(new Request("https://askr.test/"))).status).toBe(500);
    reply.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
    );
    await expect.poll(() => cancelled).toBe(1);
  });

  it.each(
    [undefined, null, "invalid", {}].flatMap((value) =>
      ["route", "fallback"].flatMap((kind) =>
        [false, true].map((global) => ({ value, kind, global })),
      ),
    ),
  )(
    "rejects an invalid $kind result $value with global middleware $global",
    async ({ value, kind, global }) => {
      const handler = (() => value) as Handler;
      let observed: unknown;
      const middleware: Middleware[] = global ? [(_context, next) => next()] : [];
      const app = createServerApp({
        ...(kind === "route" ? { routes: [{ path: "/", handler }] } : { fallback: handler }),
        middleware,
        onError: (error) => {
          observed = error;
          return new Response("handled", { status: 500 });
        },
      });
      const response = await app.fetch(new Request("https://askr.test/"));
      expect(response?.status).toBe(500);
      expect(observed).toBeInstanceOf(TypeError);
      expect((observed as Error).message).toMatch(/handler.*Response/iu);
    },
  );
});
