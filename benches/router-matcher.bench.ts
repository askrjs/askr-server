import { bench } from "vitest";
import type { ApiRoute } from "../src/contracts";
import { createMatcher, type MatchResult } from "../src/router/matcher";

const handler = () => new Response(null, { status: 204 });
const routeCount = 1_024;

function routes(path: (index: number) => string): ApiRoute[] {
  return Array.from({ length: routeCount }, (_, index) => ({ path: path(index), handler }));
}

const staticMatcher = createMatcher(routes((index) => `/items/${index}`));
const dynamicMatcher = createMatcher(routes((index) => `/buckets/${index}/{key}`));
const wildcardMatcher = createMatcher(routes((index) => `/objects/${index}/{*key}`));
const methodMatcher = createMatcher([
  { path: "/items/fixed", method: "GET", handler },
  { path: "/items/{id}", method: "PURGE", handler },
  { path: "/items/{*path}", method: "POST", handler },
]);

let sink: MatchResult;

bench("match a static route", () => {
  sink = staticMatcher.match("/items/1023", "GET");
});

bench("match a dynamic route", () => {
  sink = dynamicMatcher.match("/buckets/1023/object", "GET");
});

bench("match a wildcard route", () => {
  sink = wildcardMatcher.match("/objects/1023/a/b/c.json", "GET");
});

bench("collect allowed methods after a method miss", () => {
  sink = methodMatcher.match("/items/fixed", "DELETE");
});

void sink;
