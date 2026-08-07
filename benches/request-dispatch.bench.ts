import { bench } from "vitest";
import { createServerApp } from "../src/index";

const app = createServerApp({
  routes: [
    {
      path: "/health",
      method: "GET",
      handler: (ctx) => ctx.ok({ ok: true }),
    },
  ],
});
const response = new Response(null, { status: 204 });
const prebuiltResponseApp = createServerApp({
  routes: [{ path: "/health", method: "GET", handler: () => response }],
});
const middlewareApp = createServerApp({
  middleware: [(_context, next) => next(), (_context, next) => next()],
  routes: [{ path: "/health", method: "GET", handler: () => response }],
});
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
