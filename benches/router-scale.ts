import { bench } from "vitest";
import { createServerApp, type Handler } from "../src/index";

export function defineRouterScaleBench(tier: string, routeCount: number): void {
  const handler: Handler = (context) => context.ok({ ok: true });
  const routes = Array.from({ length: routeCount }, (_, index) => ({
    path: `/items/${index}`,
    handler,
  }));
  const app = createServerApp({ routes });
  const request = new Request(`http://example.test/items/${routeCount - 1}`);

  bench(`${tier}: dispatch through ${routeCount} static routes`, async () => {
    await app.fetch(request);
  });
}

export function defineDynamicRouterScaleBench(tier: string, routeCount: number): void {
  const handler: Handler = (context) => context.ok({ ok: true });
  const routes = Array.from({ length: routeCount }, (_, index) => ({
    path: `/buckets/${index}/{key}`,
    handler,
  }));
  const app = createServerApp({ routes });
  const request = new Request(`http://example.test/buckets/${routeCount - 1}/object`);

  bench(`${tier}: dispatch through ${routeCount} dynamic routes`, async () => {
    await app.fetch(request);
  });
}

export function defineWildcardRouterScaleBench(tier: string, routeCount: number): void {
  const handler: Handler = (context) => context.ok({ ok: true });
  const routes = Array.from({ length: routeCount }, (_, index) => ({
    path: `/objects/${index}/{*key}`,
    handler,
  }));
  const app = createServerApp({ routes });
  const request = new Request(`http://example.test/objects/${routeCount - 1}/a/b/c.json`);

  bench(`${tier}: dispatch through ${routeCount} wildcard routes`, async () => {
    await app.fetch(request);
  });
}
