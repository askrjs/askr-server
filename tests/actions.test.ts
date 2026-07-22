import type { AuthContext } from "@askrjs/auth";
import { createRouteRegistry, route } from "@askrjs/askr/router";
import { schema } from "@askrjs/schema";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../src/application";
import { defineServerActions, handleAction, type ActionRegistry } from "../src/askr/actions";
import { createAskrPageHandler } from "../src/askr/page-handler";

const user: AuthContext = {
  authenticated: true,
  principal: { id: "user-1" },
  session: { id: "session-1", subject: "user-1" },
  tenant: null,
};

const anonymous: AuthContext = {
  authenticated: false,
  principal: null,
  session: null,
  tenant: null,
};

const save = Object.freeze({
  id: "save-item",
  input: schema.object({ name: schema.string({ minLength: 2 }) }),
  invalidates: Object.freeze(["items"]),
});

function actionApp(
  actionRegistry: ActionRegistry<{ store: string }>,
  options: { redirect?: boolean; auth?: AuthContext } = {},
) {
  const registry = createRouteRegistry(() => {
    route("/items/{id}", () => "item", {
      actions: [save],
      loader: () => "loader-value",
    });
    if (options.redirect) route("/done", () => "done");
    route("/other", () => "other");
  });
  return createServerApp({
    auth: { resolve: async () => options.auth ?? user },
    fallback: createAskrPageHandler({ registry, actions: actionRegistry }),
  });
}

describe("page actions", () => {
  it("should capture dependencies once and pass matched route context", async () => {
    const dependencies = { store: "store-1" };
    const handler = vi.fn((_context, input, deps) => ({ result: { input, store: deps.store } }));
    const actions = defineServerActions({ dependencies, csrf: false }, handleAction(save, handler));
    const response = await actionApp(actions).fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: {
          accept: "application/vnd.askr.action+json;v=1",
          "content-type": "application/json",
          "x-askr-action": save.id,
        },
        body: JSON.stringify({ name: "Ada" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      ok: true,
      result: { input: { name: "Ada" }, store: "store-1" },
      invalidates: ["items"],
    });
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      params: { id: "42" },
      auth: user,
      signal: expect.any(AbortSignal),
    });
  });

  it("should authorize a descriptor for the matched page only", async () => {
    const handler = vi.fn(() => ({ result: true }));
    const actions = defineServerActions(
      { dependencies: { store: "store-1" }, csrf: false },
      handleAction(save, handler),
    );
    const response = await actionApp(actions).fetch(
      new Request("http://example.test/other", {
        method: "POST",
        headers: {
          accept: "application/vnd.askr.action+json;v=1",
          "content-type": "application/json",
          "x-askr-action": save.id,
        },
        body: JSON.stringify({ name: "Ada" }),
      }),
    );
    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("should rerender native validation failures with submitted values and field errors", async () => {
    const handler = vi.fn(() => ({ result: true }));
    const actions = defineServerActions(
      { dependencies: { store: "store-1" }, csrf: false },
      handleAction(save, handler),
    );
    const response = await actionApp(actions).fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _askr_action: save.id, name: "x" }),
      }),
    );
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("item");
    expect(html).toContain('"action":"save-item"');
    expect(html).toContain('"values":{"name":"x"}');
    expect(html).toContain('"fieldErrors":{"name":["Expected at least 2 characters."]}');
    expect(html).toContain('"route":"loader-value"');
    expect(html).toContain('"framework":{"action":');
    expect(handler).not.toHaveBeenCalled();
  });

  it("should protect page actions with session-bound CSRF by default", async () => {
    const handler = vi.fn(() => ({ result: true }));
    const actions = defineServerActions(
      { dependencies: { store: "store-1" }, csrf: { secret: "test-secret" } },
      handleAction(save, handler),
    );
    const app = actionApp(actions);
    const page = await app.fetch(new Request("http://example.test/items/42"));
    const pageHtml = await page.text();
    const token = /"csrf":"([^"]+)"/.exec(pageHtml)?.[1];
    expect(token).toBeTruthy();
    expect(pageHtml).toContain('"route":"loader-value"');
    expect(pageHtml).toContain('"framework":{"csrf":');

    const rejected = await app.fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _askr_action: save.id, name: "Ada" }),
      }),
    );
    expect(rejected.status).toBe(403);

    const accepted = await app.fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _askr_action: save.id, _csrf: token!, name: "Ada" }),
      }),
    );
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/items/42");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should require an explicit pre-authentication session for anonymous actions", async () => {
    const handler = vi.fn(() => ({ result: true }));
    const actions = defineServerActions(
      { dependencies: { store: "store-1" }, csrf: { secret: "test-secret" } },
      handleAction(save, handler),
    );
    const app = actionApp(actions, { auth: anonymous });
    const page = await app.fetch(new Request("http://example.test/items/42"));
    const pageHtml = await page.text();

    expect(pageHtml).not.toContain('"framework":{"csrf":');

    const rejected = await app.fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _askr_action: save.id, name: "Ada" }),
      }),
    );

    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({
      detail: "A session is required for this action.",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("should support anonymous actions through a custom pre-authentication session", async () => {
    const handler = vi.fn(() => ({ result: true }));
    const actions = defineServerActions(
      {
        dependencies: { store: "store-1" },
        csrf: {
          secret: "test-secret",
          sessionId: (context) => context.state.preAuthSessionId as string | undefined,
        },
      },
      handleAction(save, handler),
    );
    const registry = createRouteRegistry(() => {
      route("/items/{id}", () => "item", {
        actions: [save],
        loader: () => "loader-value",
      });
    });
    const app = createServerApp({
      auth: { resolve: async () => anonymous },
      middleware: [
        (context, next) => {
          context.state.preAuthSessionId = "guest-session-1";
          return next();
        },
      ],
      fallback: createAskrPageHandler({ registry, actions }),
    });
    const page = await app.fetch(new Request("http://example.test/items/42"));
    const pageHtml = await page.text();
    const token = /"csrf":"([^"]+)"/.exec(pageHtml)?.[1];

    expect(token).toBeTruthy();

    const accepted = await app.fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _askr_action: save.id,
          _csrf: token!,
          name: "Ada",
        }),
      }),
    );

    expect(accepted.status).toBe(303);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should reject redirects outside the same-origin matched route set", async () => {
    const actions = defineServerActions(
      { dependencies: { store: "store-1" }, csrf: false },
      handleAction(save, () => ({ redirect: "https://attacker.test/" })),
    );
    const response = await actionApp(actions, { redirect: true }).fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _askr_action: save.id, name: "Ada" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      detail: "Action returned an invalid route redirect.",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("should apply ordered set and clear cookies to a native redirect", async () => {
    const actions = defineServerActions(
      { dependencies: { store: "store-1" }, csrf: false },
      handleAction(save, () => ({
        redirect: "/done?from=action#saved",
        cookies: [
          { name: "empty", value: "", options: { path: "/" } },
          { name: "session", value: "new", options: { httpOnly: true } },
          { name: "legacy", clear: true, options: { path: "/" } },
        ],
      })),
    );
    const response = await actionApp(actions, { redirect: true }).fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _askr_action: save.id, name: "Ada" }),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/done?from=action#saved");
    expect(response.headers.getSetCookie()).toEqual([
      "empty=; Path=/",
      "session=new; HttpOnly",
      "legacy=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
    ]);
  });

  it("should normalize an enhanced redirect before applying outcome cookies", async () => {
    const actions = defineServerActions(
      { dependencies: { store: "store-1" }, csrf: false },
      handleAction(save, () => ({
        result: { saved: true },
        redirect: "../done?from=enhanced#saved",
        cookies: [{ name: "session", value: "new" }],
      })),
    );
    const response = await actionApp(actions, { redirect: true }).fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: {
          accept: "application/vnd.askr.action+json;v=1",
          "content-type": "application/json",
          "x-askr-action": save.id,
        },
        body: JSON.stringify({ name: "Ada" }),
      }),
    );
    expect(await response.json()).toEqual({
      version: 1,
      ok: true,
      result: { saved: true },
      invalidates: ["items"],
      redirect: "/done?from=enhanced#saved",
    });
    expect(response.headers.getSetCookie()).toEqual(["session=new"]);
  });

  it("should reject an invalid enhanced redirect without applying cookies", async () => {
    const actions = defineServerActions(
      { dependencies: { store: "store-1" }, csrf: false },
      handleAction(save, () => ({
        redirect: "/missing",
        cookies: [{ name: "session", value: "must-not-leak" }],
      })),
    );
    const response = await actionApp(actions, { redirect: true }).fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: {
          accept: "application/vnd.askr.action+json;v=1",
          "content-type": "application/json",
          "x-askr-action": save.id,
        },
        body: JSON.stringify({ name: "Ada" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
