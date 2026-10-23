import assert from "node:assert/strict";
import { createRouter } from "../src/router";
import { beforeAll, test } from "vite-plus/test";
import { createServerApp, type Handler } from "../src/index";

export function defineRouterScaleBench(tier: string, routeCount: number): void {
  const handler: Handler = (context) => context.ok({ ok: true });
  const router = createRouter();
  for (let index = 0; index < routeCount; index++) router.get(`/items/${index}`, handler);
  const app = createServerApp(router);
  const request = new Request(`http://example.test/items/${routeCount - 1}`);

  beforeAll(async () => {
    assert.equal((await app.fetch(request)).status, 200);
  });

  const name = `${tier}: dispatch through ${routeCount} static routes`;
  test(name, async ({ bench }) => {
    await bench(name, async () => {
      await app.fetch(request);
    }).run();
  });
}

export function defineDynamicRouterScaleBench(tier: string, routeCount: number): void {
  const handler: Handler = (context) => context.ok({ ok: true });
  const router = createRouter();
  for (let index = 0; index < routeCount; index++) router.get(`/buckets/${index}/{key}`, handler);
  const app = createServerApp(router);
  const request = new Request(`http://example.test/buckets/${routeCount - 1}/object`);

  beforeAll(async () => {
    assert.equal((await app.fetch(request)).status, 200);
  });

  const name = `${tier}: dispatch through ${routeCount} dynamic routes`;
  test(name, async ({ bench }) => {
    await bench(name, async () => {
      await app.fetch(request);
    }).run();
  });
}

export function defineWildcardRouterScaleBench(tier: string, routeCount: number): void {
  const handler: Handler = (context) => context.ok({ ok: true });
  const router = createRouter();
  for (let index = 0; index < routeCount; index++) router.get(`/objects/${index}/{*key}`, handler);
  const app = createServerApp(router);
  const request = new Request(`http://example.test/objects/${routeCount - 1}/a/b/c.json`);

  beforeAll(async () => {
    assert.equal((await app.fetch(request)).status, 200);
  });

  const name = `${tier}: dispatch through ${routeCount} wildcard routes`;
  test(name, async ({ bench }) => {
    await bench(name, async () => {
      await app.fetch(request);
    }).run();
  });
}
