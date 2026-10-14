import { createRouteRegistry, fallback, page, route } from "@askrjs/askr/router";
import type { RouteRegistry } from "@askrjs/askr/router";
import { schema } from "@askrjs/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MockInstance } from "vite-plus/test";
import { createServerApp } from "./test-app";
import { defineServerActions, handleAction } from "../src/askr/actions";
import { createAskrPageHandler } from "../src/askr/page-handler";

// Core `matchRoute` counts a path handled only by a scoped `fallback()` as a
// match, so action redirects to such paths are accepted (#61). They render that
// section's not-found view, which is usually a typo, so development mode warns.

const save = Object.freeze({
  id: "save-item",
  input: schema.object({}),
  invalidates: Object.freeze([]),
});

const Layout = () => "layout";
const NotFound = () => "not-found";

function routeTable(): void {
  route("/items/{id}", () => "item", { actions: [save] });
  page("/l/{lang}", Layout, () => {
    route("about", () => "about");
    fallback(NotFound);
  });
}

function warning(target: string): string {
  return (
    `[Askr] Action "save-item" redirected to "${target}", which matches only a fallback ` +
    `route, not a page. It will render that section's not-found view; the redirect target ` +
    `may be a typo.`
  );
}

function pageHandler(registry: RouteRegistry, redirect: () => string) {
  const actions = defineServerActions(
    { dependencies: {}, csrf: false },
    handleAction(save, () => ({ redirect: redirect() })),
  );
  return createServerApp({ fallback: createAskrPageHandler({ registry, actions }) });
}

function post(app: ReturnType<typeof pageHandler>, from = "/items/42") {
  return app.fetch(
    new Request(`http://example.test${from}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _askr_action: save.id }),
    }),
  );
}

describe("action redirects to fallback-only paths", () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  describe("in development", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "development");
    });

    it("should accept the redirect and warn naming the action and target", async () => {
      const response = await post(
        pageHandler(createRouteRegistry(routeTable), () => "/l/en/missing/deep"),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/l/en/missing/deep");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(warning("/l/en/missing/deep"));
    });

    it("should return the enhanced envelope unchanged and warn", async () => {
      const response = await pageHandler(
        createRouteRegistry(routeTable),
        () => "/l/en/missing?x=1",
      ).fetch(
        new Request("http://example.test/items/42", {
          method: "POST",
          headers: {
            accept: "application/vnd.askr.action+json;v=1",
            "content-type": "application/json",
            "x-askr-action": save.id,
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        version: 1,
        ok: true,
        invalidates: [],
        redirect: "/l/en/missing?x=1",
      });
      expect(warn).toHaveBeenCalledWith(warning("/l/en/missing"));
    });

    it("should not warn for a redirect to a concrete page", async () => {
      const response = await post(
        pageHandler(createRouteRegistry(routeTable), () => "/l/en/about"),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/l/en/about");
      expect(warn).not.toHaveBeenCalled();
    });

    it("should not warn for the implicit same-page redirect", async () => {
      const actions = defineServerActions(
        { dependencies: {}, csrf: false },
        handleAction(save, () => ({})),
      );
      const app = createServerApp({
        fallback: createAskrPageHandler({ registry: createRouteRegistry(routeTable), actions }),
      });
      const response = await post(app);
      expect(response.status).toBe(303);
      expect(warn).not.toHaveBeenCalled();
    });

    it("should not warn when a catch-all page's own action returns to it", async () => {
      const registry = createRouteRegistry(() => {
        route("/*", NotFound, { actions: [save] });
      });
      const actions = defineServerActions(
        { dependencies: {}, csrf: false },
        handleAction(save, () => ({})),
      );
      const app = createServerApp({ fallback: createAskrPageHandler({ registry, actions }) });
      const implicit = await post(app, "/anything");
      expect(implicit.status).toBe(303);
      expect(implicit.headers.get("location")).toBe("/anything");
      expect(warn).not.toHaveBeenCalled();
    });

    it("should warn once per action and target when the action repeats", async () => {
      let target = "/l/en/missing";
      const app = pageHandler(createRouteRegistry(routeTable), () => target);
      for (let index = 0; index < 5; index += 1) {
        expect((await post(app)).status).toBe(303);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      target = "/l/fr/missing";
      expect((await post(app)).status).toBe(303);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith(warning("/l/fr/missing"));
    });

    it("should name the encoded target path", async () => {
      const response = await post(
        pageHandler(createRouteRegistry(routeTable), () => "/l/en/café typo?x=1#h"),
      );
      expect(response.status).toBe(303);
      expect(warn).toHaveBeenCalledWith(warning("/l/en/caf%C3%A9%20typo"));
    });

    it("should warn for a root fallback", async () => {
      const registry = createRouteRegistry(() => {
        route("/items/{id}", () => "item", { actions: [save] });
        fallback(NotFound);
      });
      const response = await post(pageHandler(registry, () => "/itemz/42"));
      expect(response.status).toBe(303);
      expect(warn).toHaveBeenCalledWith(warning("/itemz/42"));
    });

    it("should not warn when a concrete route shares the fallback's pattern", async () => {
      const registry = createRouteRegistry(() => {
        route("/items/{id}", () => "item", { actions: [save] });
        route("/l/{lang}/*", () => "catch-all page");
        page("/l/{lang}", Layout, () => {
          route("about", () => "about");
          fallback(NotFound);
        });
      });
      const response = await post(pageHandler(registry, () => "/l/en/anything"));
      expect(response.status).toBe(303);
      expect(warn).not.toHaveBeenCalled();
    });

    it("should warn for fallback-only targets under a base path", async () => {
      const registry = createRouteRegistry(routeTable, { basePath: "/app" });
      const concrete = await post(
        pageHandler(registry, () => "/app/l/en/about"),
        "/app/items/42",
      );
      expect(concrete.status).toBe(303);
      expect(warn).not.toHaveBeenCalled();
      const missing = await post(
        pageHandler(registry, () => "/app/l/en/missing"),
        "/app/items/42",
      );
      expect(missing.status).toBe(303);
      expect(missing.headers.get("location")).toBe("/app/l/en/missing");
      expect(warn).toHaveBeenCalledWith(warning("/app/l/en/missing"));
    });

    it("should still reject a redirect that matches nothing, without warning", async () => {
      const registry = createRouteRegistry(() => {
        route("/items/{id}", () => "item", { actions: [save] });
      });
      const response = await post(pageHandler(registry, () => "/nowhere"));
      expect(response.status).toBe(500);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("in production", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
    });

    it("should accept the redirect without warning", async () => {
      const response = await post(
        pageHandler(createRouteRegistry(routeTable), () => "/l/en/missing/deep"),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/l/en/missing/deep");
      expect(warn).not.toHaveBeenCalled();
    });

    it("should return the same response as development", async () => {
      const app = pageHandler(createRouteRegistry(routeTable), () => "/l/en/missing?x=1#h");
      const production = await post(app);
      vi.stubEnv("NODE_ENV", "development");
      const development = await post(app);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(development.status).toBe(production.status);
      expect([...development.headers]).toEqual([...production.headers]);
      expect(await development.text()).toBe(await production.text());
    });
  });
});
