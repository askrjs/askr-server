import assert from "node:assert/strict";
import { createRouter } from "../src/router";
import { bench } from "vite-plus/test";
import { createServerApp } from "../src/index";

const app = createServerApp(createRouter().get("/health", (ctx) => ctx.ok({ ok: true })));
const response = new Response(null, { status: 204 });
const prebuiltResponseApp = createServerApp(createRouter().get("/health", () => response));
const middlewareApp = createServerApp({
  middleware: [(_context, next) => next(), (_context, next) => next()],
  router: createRouter().get("/health", () => response),
});
for (const [target, status] of [
  [app, 200],
  [prebuiltResponseApp, 204],
  [middlewareApp, 204],
] as const)
  assert.equal((await target.fetch(new Request("http://example.test/health"))).status, status);
const request = new Request("http://example.test/health");

bench("dispatch a server request", async () => {
  await app.fetch(new Request("http://example.test/health"));
});

bench("dispatch a prebuilt response", async () => {
  await prebuiltResponseApp.fetch(request);
});

bench("dispatch through two middleware", async () => {
  await middlewareApp.fetch(request);
});
