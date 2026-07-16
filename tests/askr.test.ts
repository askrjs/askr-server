import { describe, expect, it } from "vitest";
import { requireUser, type AuthContext } from "@askrjs/auth";
import { createRouteRegistry, route } from "@askrjs/askr/router";
import { createAskrPageHandler } from "../src/askr/index";
import { createServerApp, json, text } from "../src/index";

const user: AuthContext = {
  authenticated: true,
  principal: { id: "user-1" },
  session: null,
  tenant: null,
};

const anonymous: AuthContext = {
  authenticated: false,
  principal: null,
  session: null,
  tenant: null,
};

describe("Askr page fallback", () => {
  it("should expose the identical AuthContext to API SSR preload and page rendering", async () => {
    let apiAuth: AuthContext | undefined;
    let requirementAuth: AuthContext | undefined;
    let preloadAuth: AuthContext | undefined;
    let loaderAuth: AuthContext | undefined;
    const registry = createRouteRegistry(() => {
      route("/page", () => "page", {
        auth: (context) => {
          requirementAuth = context;
          return { allowed: true };
        },
        preload: (context) => {
          preloadAuth = context.auth;
        },
        loader: (context) => {
          loaderAuth = context.auth;
        },
      });
    });
    const app = createServerApp({
      auth: { resolve: async () => user },
      routes: [
        {
          path: "/api",
          handler: (context) => {
            apiAuth = context.auth;
            return json({ ok: true });
          },
        },
      ],
      fallback: createAskrPageHandler({ registry }),
    });
    await app.fetch(new Request("http://example.test/api"));
    await app.fetch(new Request("http://example.test/page"));
    expect(apiAuth).toBe(user);
    expect(requirementAuth).toBe(user);
    expect(preloadAuth).toBe(user);
    expect(loaderAuth).toBe(user);
  });

  it("should avoid a second auth resolution during SSR", async () => {
    let serverResolutions = 0;
    let routeResolutions = 0;
    const registry = createRouteRegistry(
      () => route("/page", () => "page", { auth: requireUser() }),
      { auth: { resolve: () => ((routeResolutions += 1), anonymous) } },
    );
    const app = createServerApp({
      auth: { resolve: async () => ((serverResolutions += 1), user) },
      fallback: createAskrPageHandler({ registry }),
    });
    expect((await app.fetch(new Request("http://example.test/page"))).status).toBe(200);
    expect(serverResolutions).toBe(1);
    expect(routeResolutions).toBe(0);
  });

  it("should redirect before protected preload and omit hydration data after denial", async () => {
    let preloaded = false;
    let rendered = false;
    const registry = createRouteRegistry(
      () =>
        route("/private", () => ((rendered = true), "private"), {
          auth: requireUser(),
          preload: () => {
            preloaded = true;
          },
        }),
      { auth: { resolve: () => anonymous, loginPath: "/login" } },
    );
    const app = createServerApp({ fallback: createAskrPageHandler({ registry }) });
    const response = await app.fetch(new Request("http://example.test/private"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?next=%2Fprivate");
    expect(await response.text()).toBe("");
    expect(preloaded).toBe(false);
    expect(rendered).toBe(false);
  });

  it("should return 403 before rendering forbidden content", async () => {
    let rendered = false;
    const registry = createRouteRegistry(() => {
      route("/private", () => ((rendered = true), "private"), {
        auth: () => ({ allowed: false, reason: "forbidden" }),
      });
    });
    const app = createServerApp({
      auth: { resolve: async () => user },
      fallback: createAskrPageHandler({ registry }),
    });
    expect((await app.fetch(new Request("http://example.test/private"))).status).toBe(403);
    expect(rendered).toBe(false);
  });

  it("should preserve API route precedence over page fallback", async () => {
    let pageRendered = false;
    const registry = createRouteRegistry(() => {
      route("/api", () => ((pageRendered = true), "page"));
    });
    const app = createServerApp({
      routes: [{ path: "/api", handler: () => text("api") }],
      fallback: createAskrPageHandler({ registry }),
    });
    expect(await (await app.fetch(new Request("http://example.test/api"))).text()).toBe("api");
    expect(pageRendered).toBe(false);
  });

  it("should return a marked SSR fragment without document markup", async () => {
    const registry = createRouteRegistry(() => route("/", () => "fragment"));
    const app = createServerApp({ fallback: createAskrPageHandler({ registry }) });
    const response = await app.fetch(new Request("http://example.test/"));
    expect(response.headers.get("content-type")).toContain("askr-fragment=1");
    expect(await response.text()).toBe("fragment");
  });

  it("should emit escaped deterministic owned metadata", async () => {
    const registry = createRouteRegistry(() =>
      route("/", () => "fragment", {
        meta: {
          title: "<unsafe> & title",
          description: 'a "quoted" description',
          openGraph: { title: "OG title" },
          links: [{ rel: "alternate", href: 'https://example.test/?q="unsafe"' }],
          jsonLd: { value: "</script><script>alert(1)</script>" },
          html: { lang: "en\r\nmalicious", dir: "ltr" },
        },
      }),
    );
    const response = await createServerApp({ fallback: createAskrPageHandler({ registry }) }).fetch(
      new Request("http://example.test/"),
    );
    const head = response.headers.get("x-askr-head") ?? "";
    expect(head).toContain('<title data-askr-head="">&lt;unsafe&gt; &amp; title</title>');
    expect(head).toContain('property="og:title"');
    expect(head).toContain("\\u003c/script\\u003e");
    expect(head).not.toContain("<script>alert(1)</script>");
    expect(response.headers.get("x-askr-html-lang")).toBe("en malicious");
    expect(response.headers.get("x-askr-html-dir")).toBe("ltr");
  });
});
