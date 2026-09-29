import { createRouteRegistry, fallback, matchRoute, page, route } from "@askrjs/askr/router";
import type { RouteRegistry } from "@askrjs/askr/router";
import { schema } from "@askrjs/schema";
import { describe, expect, it } from "vitest";
import { createServerApp } from "./test-app";
import { defineServerActions, handleAction } from "../src/askr/actions";
import { createAskrPageHandler } from "../src/askr/page-handler";

// The page handler must agree with askr core about which paths are routes. It
// once kept its own copy of the segment matcher, which compared static segments
// raw and ignored the registry base path, so action redirects to real routes
// were rejected. Every URL below goes through both the server's redirect gate
// and core `matchRoute`; the two must give the same answer.

const save = Object.freeze({
  id: "save-item",
  input: schema.object({}),
  invalidates: Object.freeze([]),
});

const Layout = () => "layout";
const NotFound = () => "not-found";

function routeTable(): void {
  route("/items/{id}", () => "item", { actions: [save] });
  route("/café", () => "cafe");
  route("/a b", () => "space");
  route("/Done", () => "done");
  route("/users/{id}", () => "user");
  route("/users/me", () => "me");
  route("/docs/*", () => "docs");
  route("/files/{*path}", () => "files");
  page("/l/{lang}", Layout, () => {
    route("about", () => "about");
    fallback(NotFound);
  });
}

const targets = [
  "/café",
  "/caf%C3%A9",
  "/caf%c3%a9",
  "/caf%C3%A9/",
  "/caf%25C3%25A9",
  "/cafe",
  "/a%20b",
  "/a b",
  "/Done",
  "/Done/",
  "/done",
  "/DONE",
  "/users/42",
  "/users/me",
  "/users/caf%C3%A9",
  "/users/a%2Fb",
  "/users/%E0%A4%A",
  "/users",
  "/users/42/extra",
  "/docs/intro",
  "/docs/caf%C3%A9",
  "/docs/a%2Fb",
  "/docs",
  "/docs/a/b",
  "/files",
  "/files/",
  "/files/a/b/c",
  "/files/caf%C3%A9/a%2Fb",
  "/l/en/about",
  "/l/en/missing/deep",
  "/l",
  "/",
  "/items/42",
  "/a/b/c/d",
  "//double",
  "/%2F",
];

function gateApp(registry: RouteRegistry, redirect: string) {
  const actions = defineServerActions(
    { dependencies: {}, csrf: false },
    handleAction(save, () => ({ redirect })),
  );
  return createServerApp({ fallback: createAskrPageHandler({ registry, actions }) });
}

async function redirectAllowed(registry: RouteRegistry, from: string, to: string) {
  const response = await gateApp(registry, to).fetch(
    new Request(`http://example.test${from}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _askr_action: save.id }),
    }),
  );
  if (response.status === 303) return true;
  if (response.status === 500) return false;
  throw new Error(`unexpected status ${response.status} for redirect to ${to}`);
}

function coreMatches(registry: RouteRegistry, target: string): boolean {
  // Mirror how the action pipeline resolves a redirect before gating it.
  const location = new URL(target, "http://example.test/items/42");
  if (location.origin !== "http://example.test") return false;
  return matchRoute(location.pathname, { registry }) !== null;
}

describe("page handler route parity with askr core", () => {
  const registry = createRouteRegistry(routeTable);

  it.each(targets)(
    "should gate a redirect to %s exactly as core matchRoute does",
    async (target) => {
      expect(await redirectAllowed(registry, "/items/42", target)).toBe(
        coreMatches(registry, target),
      );
    },
  );

  it("should allow redirects to percent-encoded static segments", async () => {
    expect(await redirectAllowed(registry, "/items/42", "/caf%C3%A9")).toBe(true);
    expect(await redirectAllowed(registry, "/items/42", "/a%20b")).toBe(true);
  });

  it("should not treat a double-encoded static segment as the decoded route", async () => {
    expect(await redirectAllowed(registry, "/items/42", "/caf%25C3%25A9")).toBe(
      coreMatches(registry, "/caf%25C3%25A9"),
    );
    expect(coreMatches(registry, "/caf%25C3%25A9")).toBe(false);
  });

  it.each([
    "/docs/caf%C3%A9",
    "/docs/a%2Fb",
    "/files/caf%C3%A9/a%2Fb",
    "/files/",
    "/users/caf%C3%A9",
    "/users/a%2Fb",
    "/users/%E0%A4%A",
  ])(
    "should pass action handlers the same params core matchRoute captures for %s",
    async (path) => {
      let seen: Record<string, string> | undefined;
      const actions = defineServerActions(
        { dependencies: {}, csrf: false },
        handleAction(save, (context) => {
          seen = { ...context.params };
          return {};
        }),
      );
      const paramsRegistry = createRouteRegistry(() => {
        route("/docs/*", () => "docs", { actions: [save] });
        route("/files/{*path}", () => "files", { actions: [save] });
        route("/users/{id}", () => "user", { actions: [save] });
      });
      await createServerApp({
        fallback: createAskrPageHandler({ registry: paramsRegistry, actions }),
      }).fetch(
        new Request(`http://example.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ _askr_action: save.id }),
        }),
      );
      const { pathname } = new URL(path, "http://example.test");
      expect(seen).toBeDefined();
      expect(seen).toEqual({ ...matchRoute(pathname, { registry: paramsRegistry })?.params });
    },
  );

  describe("with a base path", () => {
    const based = createRouteRegistry(routeTable, { basePath: "/app" });

    it.each(["/app/caf%C3%A9", "/app/docs/intro", "/app/files/a/b", "/caf%C3%A9", "/app"])(
      "should gate a redirect to %s exactly as core matchRoute does",
      async (target) => {
        expect(await redirectAllowed(based, "/app/items/42", target)).toBe(
          coreMatches(based, target),
        );
      },
    );

    it("should allow redirects to routes under the base path", async () => {
      expect(await redirectAllowed(based, "/app/items/42", "/app/files/a/b")).toBe(true);
    });
  });
});
