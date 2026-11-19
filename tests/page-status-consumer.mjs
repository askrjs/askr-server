import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouteRegistry, route, forbidden, fallback } from "@askrjs/askr/router";
import { createAskrPageHandler } from "@askrjs/server/askr";
import { createServerApp } from "@askrjs/server";

const registry = createRouteRegistry(() => {
  route("/", () => "home");
  route("/failed", () => "private", {
    loader() {
      throw new Error("failed");
    },
    error: () => "loader error page",
  });
  route("/denied", () => "private", {
    policies: [() => forbidden()],
    forbidden: () => "denied page",
  });
  fallback(() => "missing page");
});
const app = createServerApp({ fallback: createAskrPageHandler({ registry }) });
for (const [path, status, body] of [
  ["/", 200, "home"],
  ["/failed", 500, "loader error page"],
  ["/denied", 403, "denied page"],
  ["/missing", 404, "missing page"],
]) {
  test(`renders ${path} with status ${status}`, async () => {
    const response = await app.fetch(new Request(new URL(path, "https://example.test")));
    assert.ok((await response.text()).includes(body), path);
    assert.equal(response.status, status, path);
  });
}
