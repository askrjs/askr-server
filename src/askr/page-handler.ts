import { renderRouteRequest, type RenderRouteRequestResult } from "@askrjs/askr/ssr";
import type { ServerQueryRegistry } from "@askrjs/askr/data";
import type { RouteAuthOptions, RouteContext, RouteRegistry } from "@askrjs/askr/router";
import { matchRoute, resolveRouteMeta, serializeRouteMeta } from "@askrjs/askr/router";
import { resolveRouteRequest } from "@askrjs/askr/router";
import type { Handler, ServerContext } from "../contracts";
import type { ActionRegistry } from "./actions";
import type { CspNonceProvider } from "../csp-nonce";
import { isDevelopment } from "../development";

/** Options for {@link createAskrPageHandler}. */
export interface AskrPageHandlerOptions {
  registry: RouteRegistry;
  auth?: RouteAuthOptions;
  queryRegistry?: ServerQueryRegistry;
  seed?: number;
  actions?: ActionRegistry;
  cspNonce?: CspNonceProvider;
}

function headerValue(value: string): string {
  let output = "";
  let replaced = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      if (!replaced) output += " ";
      replaced = true;
    } else {
      output += character;
      replaced = false;
    }
  }
  return output;
}

function encodeHeaderText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function escapeStyleRawText(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

function styleCarrier(styles: readonly { cssText: string }[], cspNonce?: string): string {
  if (styles.length === 0) return "";
  const nonce = cspNonce
    ? ` nonce="${headerValue(cspNonce).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`
    : "";
  return `<style data-askr-style-registry="true"${nonce}>${escapeStyleRawText(styles.map((style) => style.cssText).join("\n"))}\n</style>`;
}

function prependBody(prefix: string, body: BodyInit | null): BodyInit {
  if (!body) return prefix;
  const source = new Response(body).body!;
  const reader = source.getReader();
  const encoder = new TextEncoder();
  let prefixPending = true;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixPending) {
        prefixPending = false;
        controller.enqueue(encoder.encode(prefix));
        return;
      }
      const part = await reader.read();
      if (cancelled) return;
      if (part.done) controller.close();
      else controller.enqueue(part.value);
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
}

export async function translateAskrPageResult(
  result: RenderRouteRequestResult,
  context: ServerContext,
  status = 200,
  cspNonce?: string,
): Promise<Response> {
  if (result.kind === "no-match") return context.notFound();
  if (result.kind === "redirect") {
    return new Response(null, {
      status: result.status ?? 302,
      headers: { location: result.to },
    });
  }
  if (result.kind === "deny") return new Response(null, { status: result.status });
  const headers = new Headers({ "content-type": "text/html; charset=utf-8; askr-fragment=1" });
  if (result.record) {
    const metadata = await resolveRouteMeta(result.record, routeContext(context, result.params));
    const head = serializeRouteMeta(metadata);
    headers.set("x-askr-encoding", "base64url-v1");
    if (head) headers.set("x-askr-head", encodeHeaderText(head));
    if (metadata.html?.lang) {
      headers.set("x-askr-html-lang", encodeHeaderText(metadata.html.lang));
    }
    if (metadata.html?.dir) headers.set("x-askr-html-dir", encodeHeaderText(metadata.html.dir));
  }
  const carrier = styleCarrier(result.styles, cspNonce);
  const body = result.stream ?? result.html;
  return new Response(carrier ? prependBody(carrier, body) : body, { status, headers });
}

// Development warnings are deduplicated per action and target; the set is
// bounded because redirect targets can carry request data.
const fallbackRedirectWarningLimit = 256;

// A match is fallback-only when every record with the matched pattern is a
// fallback. A concrete route may share a scoped fallback's pattern, and then
// core matches the concrete route first, so it must not warn.
function matchesOnlyFallback(registry: RouteRegistry, path: string): boolean {
  let fallbackFound = false;
  for (const record of registry.manifest.records) {
    if (record.path !== path) continue;
    if (!record.isFallback) return false;
    fallbackFound = true;
  }
  return fallbackFound;
}

/**
 * Accepts same-origin redirects to any path core `matchRoute` matches, which
 * includes paths handled only by a `fallback()`. In development, those redirects
 * log a warning, because they render a not-found view and are usually typos.
 * An action declared on a catch-all page (`route("/*", ..., { actions })`) that
 * returns to that same pattern is expected and does not warn.
 */
function redirectGate(
  registry: RouteRegistry,
): (location: URL, action: string, fromPath: string) => boolean {
  const warned = new Set<string>();
  return (location, action, fromPath) => {
    const match = matchRoute(location.pathname, { registry });
    if (match === null) return false;
    if (isDevelopment() && match.path !== fromPath && matchesOnlyFallback(registry, match.path)) {
      const key = `${action}\n${location.pathname}`;
      if (!warned.has(key)) {
        if (warned.size >= fallbackRedirectWarningLimit) warned.clear();
        warned.add(key);
        console.warn(
          `[Askr] Action "${action}" redirected to "${location.pathname}", which matches only a ` +
            `fallback route, not a page. It will render that section's not-found view; the ` +
            `redirect target may be a typo.`,
        );
      }
    }
    return true;
  };
}

function routeContext(context: ServerContext, params: Record<string, string>): RouteContext {
  return {
    mode: "ssr",
    params,
    pathname: context.url.pathname,
    search: context.url.search,
    hash: context.url.hash,
    href: `${context.url.pathname}${context.url.search}${context.url.hash}`,
    auth: context.auth,
    signal: context.signal,
  };
}

/**
 * Creates a catch-all route {@link Handler} that server-renders Askr framework pages: routes
 * `GET`/`HEAD` requests through Askr's SSR pipeline, and (if `options.actions` is provided)
 * dispatches `POST` requests as form actions, re-rendering the page with validation errors on
 * failure or following a redirect/response on success.
 *
 * @param options - Route registry, auth policy, query registry, action registry, and CSP nonce provider.
 * @throws {Error} If `options.registry` is not provided.
 */
export function createAskrPageHandler(options: AskrPageHandlerOptions): Handler {
  if (!options.registry) {
    throw new Error("createAskrPageHandler requires a route registry.");
  }
  const { manifest } = options.registry;
  const allowsRedirect = redirectGate(options.registry);
  return async (context) => {
    const cspNonce = options.cspNonce?.(context);
    if (context.request.method === "POST" && options.actions) {
      const resolved = await resolveRouteRequest(context.request.url, {
        registry: options.registry,
        mode: "ssr",
        auth: options.auth ?? manifest.auth,
        authContext: context.auth,
        request: context.request,
        signal: context.signal,
        telemetry: context.telemetry,
        load: false,
      });
      if (!resolved) return context.notFound();
      if (resolved.kind === "deny") return new Response(null, { status: resolved.status });
      if (resolved.kind === "redirect") return context.redirect(resolved.to, 303);
      if (!resolved.record) return context.notFound();
      const page = Object.freeze({
        record: resolved.record,
        params: Object.freeze({ ...resolved.params }),
      });
      context.params = page.params;
      const execution = await options.actions.execute(context, {
        authorized: page.record.options.actions ?? [],
        params: page.params,
        policies: page.record.options.policies ?? [],
        allowsRedirect: (location, action) => allowsRedirect(location, action, page.record.path),
      });
      if (execution?.kind === "response") return execution.response;
      if (execution?.kind === "invalid") {
        const token = await options.actions.csrfToken(context);
        const result = await renderRouteRequest({
          url: context.request.url,
          registry: options.registry,
          auth: options.auth ?? manifest.auth,
          authContext: context.auth,
          request: context.request,
          signal: context.signal,
          queryRegistry: options.queryRegistry,
          seed: options.seed,
          telemetry: context.telemetry,
          framework: {
            action: execution,
            ...(token ? { csrf: token } : {}),
          },
          cspNonce,
        });
        return translateAskrPageResult(result, context, 422, cspNonce);
      }
    }
    if (context.request.method !== "GET" && context.request.method !== "HEAD") {
      return context.notFound();
    }
    const token = options.actions ? await options.actions.csrfToken(context) : undefined;
    const result = await renderRouteRequest({
      url: context.request.url,
      registry: options.registry,
      auth: options.auth ?? manifest.auth,
      authContext: context.auth,
      request: context.request,
      signal: context.signal,
      queryRegistry: options.queryRegistry,
      seed: options.seed,
      telemetry: context.telemetry,
      framework: token ? { csrf: token } : undefined,
      cspNonce,
    });
    const status = result.kind === "render" && result.record?.isFallback ? 404 : 200;
    return translateAskrPageResult(result, context, status, cspNonce);
  };
}
