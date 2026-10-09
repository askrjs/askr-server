import assert from "node:assert/strict";
import { createRouter, createServerApp } from "@askrjs/server";

let cancelled = 0;
const stream = () =>
  new Response(
    new ReadableStream({
      cancel() {
        cancelled++;
      },
    }),
  );
const head = createServerApp(createRouter().get("/", stream));
assert.equal((await head.fetch(new Request("https://askr.test/", { method: "HEAD" }))).body, null);
assert.equal(cancelled, 1);

const replaced = createServerApp({
  router: createRouter().get("/", stream),
  middleware: [
    async (_context, next) => {
      await next();
      return new Response("replacement");
    },
  ],
});
assert.equal(await (await replaced.fetch(new Request("https://askr.test/"))).text(), "replacement");
assert.equal(cancelled, 2);

let deniedCalls = 0;
const denied = createServerApp({
  router: createRouter().get(
    "/",
    () => {
      deniedCalls++;
      return new Response("secret");
    },
    {
      auth: () => ({ allowed: false, reason: "forbidden" }),
    },
  ),
  onAccessDenied: () => undefined,
});
assert.equal((await denied.fetch(new Request("https://askr.test/"))).status, 500);
assert.equal(deniedCalls, 0);
const probe = createServerApp({ probes: { readyz: () => "invalid" } });
assert.equal((await probe.fetch(new Request("https://askr.test/readyz"))).status, 503);

let errorCalls = 0;
const reason = new Error("onError failure");
const failure = createServerApp({
  router: createRouter().get("/", () => {
    throw new Error("route failure");
  }),
  middleware: [(_context, next) => next()],
  onError: () => {
    errorCalls++;
    throw reason;
  },
});
await assert.rejects(failure.fetch(new Request("https://askr.test/")), (error) => error === reason);
assert.equal(errorCalls, 1);

let entered;
const pulling = new Promise((resolve) => {
  entered = resolve;
});
const controller = new AbortController();
const aborted = new Error("request aborted");
const body = new ReadableStream({
  pull() {
    entered();
  },
  cancel(value) {
    assert.equal(value, aborted);
    cancelled++;
    return new Promise(() => {});
  },
});
const request = new Request("https://askr.test/", {
  method: "POST",
  signal: controller.signal,
  body,
  headers: { "content-type": "application/json" },
  duplex: "half",
});
const binding = createServerApp({
  router: createRouter().post("/", async (context) => context.json(await context.bind())),
});
const pending = binding.fetch(request);
await pulling;
controller.abort(aborted);
const abortedResponse = await pending;
assert.equal(abortedResponse.status, 400);
assert.equal((await abortedResponse.json()).detail, "Request body could not be read.");
assert.equal(cancelled, 3);
assert.equal(request.body.locked, false);
for (const path of ["response-body", "dist/index.js"])
  await assert.rejects(import(`@askrjs/server/${path}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
