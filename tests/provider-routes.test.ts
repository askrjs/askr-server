import { describe, expect, it, vi } from "vite-plus/test";
import { createServerApp } from "../src/application";
import { createApi } from "../src/openapi/api";
import {
  oversizedProviderCallback,
  providerCsrfResponse,
  registerProviderRoutes,
} from "../src/auth/provider-routes";

const providers = [
  { id: "google", responseMode: "query" as const },
  { id: "apple", responseMode: "form_post" as const },
];
function fixture() {
  const engine = {
    login: vi.fn(async () => new Response(null, { status: 303 })),
    callback: vi.fn(async () => new Response(null, { status: 303 })),
    logout: vi.fn(async () => new Response(null, { status: 204 })),
  };
  const api = createApi({ info: { title: "Provider route transport", version: "1" } });
  registerProviderRoutes(api, engine, { providers, origin: "https://app.test" });
  return { engine, app: createServerApp({ router: api.createRouter({}) }) };
}

describe("provider route transport", () => {
  it("validates returnTo and passes repeated scopes without accepting extension parameters", async () => {
    const { app, engine } = fixture();
    const request = new Request(
      "https://app.test/auth/login/google?returnTo=https://evil.test/&resource=calendar&scope=read&scope=write",
    );
    expect((await app.fetch(request)).status).toBe(303);
    expect(engine.login).toHaveBeenCalledExactlyOnceWith(request, {
      provider: "google",
      returnTo: "/",
      resource: "calendar",
      scopes: ["read", "write"],
    });
    for (const query of [
      "returnTo=/&returnTo=/second",
      "resource=a&resource=b",
      "client_secret=SECRET",
    ]) {
      expect(
        (await app.fetch(new Request(`https://app.test/auth/login/google?${query}`))).status,
      ).toBe(400);
    }
    expect(engine.login).toHaveBeenCalledOnce();
  });

  it("does not start or consume transactions through HEAD or a mismatched callback method", async () => {
    const { app, engine } = fixture();
    for (const [path, method] of [
      ["login/google", "HEAD"],
      ["callback/google", "HEAD"],
      ["callback/google", "POST"],
      ["callback/apple", "GET"],
    ]) {
      expect(
        (await app.fetch(new Request(`https://app.test/auth/${path}`, { method }))).status,
      ).toBe(405);
    }
    expect(engine.login).not.toHaveBeenCalled();
    expect(engine.callback).not.toHaveBeenCalled();
    expect(
      (await app.fetch(new Request("https://app.test/auth/callback/google?code=one&state=state")))
        .status,
    ).toBe(303);
    const post = new Request("https://app.test/auth/callback/apple", {
      method: "POST",
      body: new URLSearchParams({ code: "two", state: "state" }),
    });
    expect((await app.fetch(post)).status).toBe(303);
    expect(engine.callback).toHaveBeenLastCalledWith(post, { provider: "apple" });
  });

  it("preserves a safe fragment in the provider return destination", async () => {
    const { app, engine } = fixture();
    const destination = "/private?a=1#x";
    const request = new Request(
      `https://app.test/auth/login/google?returnTo=${encodeURIComponent(destination)}`,
    );
    expect((await app.fetch(request)).status).toBe(303);
    expect(engine.login).toHaveBeenCalledExactlyOnceWith(request, {
      provider: "google",
      returnTo: destination,
    });
  });

  it("delegates only exact configured oversized callback ingress to its transaction owner", () => {
    const oversized = (path: string, method: string, length = "32769") =>
      new Request(`https://app.test${path}`, {
        method,
        headers: { "content-length": length },
      });
    expect(oversizedProviderCallback(oversized("/auth/callback/apple", "POST"), providers)).toBe(
      "apple",
    );
    expect(oversizedProviderCallback(oversized("/auth/callback/google", "GET"), providers)).toBe(
      "google",
    );
    for (const [path, method] of [
      ["/auth/callback/apple", "GET"],
      ["/auth/callback/google", "POST"],
      ["/auth/callback/google", "HEAD"],
      ["/auth/callback/unknown", "POST"],
      ["/api/upload", "POST"],
    ]) {
      expect(oversizedProviderCallback(oversized(path, method), providers)).toBeUndefined();
    }
    expect(
      oversizedProviderCallback(oversized("/auth/callback/apple", "POST", "32768"), providers),
    ).toBeUndefined();
  });

  it("keeps local logout POST-only and requires exact configured Origin", async () => {
    const { app, engine } = fixture();
    expect((await app.fetch(new Request("https://app.test/auth/logout"))).status).toBe(405);
    for (const origin of [undefined, "null", "https://evil.test"]) {
      expect(
        (
          await app.fetch(
            new Request("https://app.test/auth/logout", {
              method: "POST",
              headers: origin ? { origin } : {},
            }),
          )
        ).status,
      ).toBe(403);
    }
    const request = new Request("https://app.test/auth/logout", {
      method: "POST",
      headers: { origin: "https://app.test", "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", revoke: true, providerLogout: false }),
    });
    expect((await app.fetch(request)).status).toBe(204);
    expect(engine.logout).toHaveBeenCalledExactlyOnceWith(request, {
      provider: "google",
      revoke: true,
      providerLogout: false,
    });
  });

  it("provides anonymous session JSON without caching or private session fields", async () => {
    const { app } = fixture();
    const response = await app.fetch(new Request("https://app.test/auth/session"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      authenticated: false,
      principal: null,
      tenant: null,
      scopes: [],
    });
  });
});

describe("provider cookie CSRF boundary", () => {
  const request = (
    path: string,
    method: string,
    origin?: string,
    cookie = "__Host-askr-session=opaque",
  ) =>
    new Request(`https://app.test${path}`, {
      method,
      headers: { cookie, ...(origin ? { origin } : {}) },
    });
  it("requires canonical Origin for unsafe application requests with the session cookie", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        providerCsrfResponse(request("/api/change", method), "https://app.test", providers)?.status,
      ).toBe(403);
      expect(
        providerCsrfResponse(
          request("/api/change", method, "https://evil.test"),
          "https://app.test",
          providers,
        )?.status,
      ).toBe(403);
      expect(
        providerCsrfResponse(
          request("/api/change", method, "https://app.test"),
          "https://app.test",
          providers,
        ),
      ).toBeUndefined();
    }
    expect(
      providerCsrfResponse(
        request("/api/change", "POST", undefined, "preferences=light"),
        "https://app.test",
        providers,
      ),
    ).toBeUndefined();
  });
  it("exempts only the exact form_post provider callback", () => {
    expect(
      providerCsrfResponse(
        request("/auth/callback/apple", "POST", "https://apple.test"),
        "https://app.test",
        providers,
      ),
    ).toBeUndefined();
    for (const path of [
      "/auth/callback/google",
      "/auth/callback/unknown",
      "/auth/callback/apple/extra",
      "/auth/logout",
      "/auth/other",
    ]) {
      expect(
        providerCsrfResponse(
          request(path, "POST", "https://apple.test"),
          "https://app.test",
          providers,
        )?.status,
      ).toBe(403);
    }
  });
});
