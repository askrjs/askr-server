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

bench("dispatch a server request", async () => {
  await app.fetch(new Request("http://example.test/health"));
});
