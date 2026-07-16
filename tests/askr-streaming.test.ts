import { createRouteRegistry, defer, Resolve, route, routeData } from "@askrjs/askr/router";
import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/application";
import { createAskrPageHandler } from "../src/askr/page-handler";

interface PageData {
  readonly message: ReturnType<typeof defer<string>>;
}

function deferredPage() {
  const data = routeData<PageData>();
  return Resolve({
    value: data.message,
    pending: "loading",
    rejected: (error) => `failed:${String(error)}`,
    children: (message) => `ready:${message}`,
  });
}

describe("Askr page streaming", () => {
  it("should pass through deferred chunks while preserving fragment metadata", async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const registry = createRouteRegistry(() => {
      route("/deferred", deferredPage, {
        loader: () => ({ message: defer(pending) }),
        meta: { title: "Deferred title", html: { lang: "en", dir: "ltr" } },
      });
    });
    const response = await createServerApp({
      fallback: createAskrPageHandler({ registry }),
    }).fetch(new Request("http://example.test/deferred"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("askr-fragment=1");
    expect(response.headers.get("x-askr-head")).toContain("Deferred title");
    expect(response.headers.get("x-askr-html-lang")).toBe("en");
    expect(response.headers.get("x-askr-html-dir")).toBe("ltr");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const initial = decoder.decode((await reader.read()).value);
    expect(initial).toContain("loading");
    expect(initial).not.toContain("ready:");

    release("complete");
    let remainder = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += decoder.decode(chunk.value, { stream: true });
    }
    remainder += decoder.decode();
    expect(remainder).toContain('data-askr-deferred-patch="d:0"');
    expect(remainder).toContain("ready:complete");
    expect(remainder).toContain('data-askr-render-data="true"');
  });

  it("should close a deferred response cleanly when the request aborts", async () => {
    const pending = new Promise<string>(() => undefined);
    const controller = new AbortController();
    const registry = createRouteRegistry(() => {
      route("/deferred", deferredPage, {
        loader: () => ({ message: defer(pending) }),
      });
    });
    const response = await createServerApp({
      fallback: createAskrPageHandler({ registry }),
    }).fetch(new Request("http://example.test/deferred", { signal: controller.signal }));
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);

    controller.abort();
    expect((await reader.read()).done).toBe(true);
  });
});
