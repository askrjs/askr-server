import assert from "node:assert/strict";
import { createRouter } from "../src/router";
import { bench } from "vite-plus/test";
import { createServerApp } from "../src/application";
import { bind } from "../src/binding";

let sink: unknown;
const response = new Response(null, { status: 204 });
const app = createServerApp(
  createRouter().post("/items/{id}", async (ctx) => {
    sink = await ctx.bind();
    return response;
  }),
);
const proof = await app.fetch(
  new Request("http://example.test/items/42?view=full", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"name":"Ada"}',
  }),
);
assert.equal(proof.status, 204);
assert.deepEqual(sink, { name: "Ada", view: "full", id: "42" });

const queryRequest = new Request(
  "http://example.test/items/42?tag=one&tag=two&view=full&locale=en",
  { method: "POST" },
);
const queryUrl = new URL(queryRequest.url);

bench("merge route and query without dispatch", async () => {
  sink = await bind({
    request: queryRequest,
    params: { id: "42" },
    url: queryUrl,
    query: queryUrl.searchParams,
  });
});

bench("bind route and query values", async () => {
  await app.fetch(queryRequest);
  void sink;
});

const repeatedQuery = new URLSearchParams();
for (let index = 0; index < 32; index += 1) repeatedQuery.append("tag", `value-${index}`);
const repeatedQueryRequest = new Request(`http://example.test/items/42?${repeatedQuery}`, {
  method: "POST",
});

bench("bind 32 repeated query values", async () => {
  await app.fetch(repeatedQueryRequest);
  void sink;
});

bench("bind a JSON request", async () => {
  await app.fetch(
    new Request("http://example.test/items/42?view=full", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "request-1" },
      body: '{"name":"Ada","active":true,"roles":["admin","editor"]}',
    }),
  );
  void sink;
});

bench("bind a URL-encoded form request", async () => {
  await app.fetch(
    new Request("http://example.test/items/42?view=full", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=Ada&role=admin&role=editor&active=true",
    }),
  );
  void sink;
});
