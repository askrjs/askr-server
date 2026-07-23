import { renderRouteRequest, type RenderRouteRequestResult } from "@askrjs/askr/ssr";
import type { ServerQueryRegistry } from "@askrjs/askr/data";
import type {
  ParsedSegment,
  RouteAuthOptions,
  RouteContext,
  RouteManifest,
  RouteRecord,
  RouteRegistry,
} from "@askrjs/askr/router";
import { resolveRouteMeta, serializeRouteMeta } from "@askrjs/askr/router";
import { resolveRouteRequest } from "@askrjs/askr/router";
import type { Handler, ServerContext } from "../contracts";
import type { ActionRegistry } from "./actions";
import type { CspNonceProvider } from "../csp-nonce";

export interface AskrPageHandlerOptions {
  manifest?: RouteManifest;
  registry?: RouteRegistry;
  auth?: RouteAuthOptions;
  queryRegistry?: ServerQueryRegistry;
  seed?: number;
  actions?: ActionRegistry<any>;
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

async function translate(
  result: RenderRouteRequestResult,
  context: ServerContext,
  status = 200,
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
    const head = headerValue(serializeRouteMeta(metadata));
    if (head) headers.set("x-askr-head", head);
    if (metadata.html?.lang) {
      headers.set("x-askr-html-lang", headerValue(metadata.html.lang));
    }
    if (metadata.html?.dir) headers.set("x-askr-html-dir", metadata.html.dir);
  }
  return new Response(result.stream ?? result.html, { status, headers });
}

function splitPath(pathname: string): string[] {
  const normalized = pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
  return normalized === "/" ? [] : normalized.replace(/^\//, "").split("/");
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchSegments(
  parts: readonly string[],
  segments: readonly ParsedSegment[],
): Record<string, string> | undefined {
  if (segments.length === 1 && segments[0]?.kind === "catchall") {
    return {
      "*": parts.length === 0 ? "/" : parts.length === 1 ? parts[0]! : `/${parts.join("/")}`,
    };
  }
  const splat = segments.findIndex((segment) => segment.kind === "splat");
  if (splat === -1 && parts.length !== segments.length) return undefined;
  if (splat !== -1 && (splat !== segments.length - 1 || parts.length < splat)) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const part = parts[index];
    if (segment.kind === "static") {
      if (segment.value !== part) return undefined;
    } else if (segment.kind === "splat") {
      params[segment.value] = parts.slice(index).map(decodeParam).join("/");
      return params;
    } else if (segment.kind === "param") {
      if (part === undefined) return undefined;
      params[segment.value] = decodeParam(part);
    } else {
      if (part === undefined) return undefined;
      params["*"] = part;
    }
  }
  return params;
}

function findRoute(
  manifest: RouteManifest,
  pathname: string,
): { readonly record: RouteRecord; readonly params: Record<string, string> } | undefined {
  const parts = splitPath(pathname);
  for (const record of manifest.records) {
    const params = matchSegments(parts, record.segments);
    if (params) return { record, params };
  }
  return undefined;
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

export function createAskrPageHandler(options: AskrPageHandlerOptions): Handler {
  const manifest = options.manifest ?? options.registry?.manifest;
  if (!manifest) {
    throw new Error("createAskrPageHandler requires a route manifest or registry.");
  }
  return async (context) => {
    const cspNonce = options.cspNonce?.(context);
    if (context.request.method === "POST" && options.actions) {
      const resolved = await resolveRouteRequest(context.request.url, {
        manifest,
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
        allowsRedirect: (location) => findRoute(manifest, location.pathname) !== undefined,
      });
      if (execution?.kind === "response") return execution.response;
      if (execution?.kind === "invalid") {
        const token = await options.actions.csrfToken(context);
        const result = await renderRouteRequest({
          url: context.request.url,
          manifest,
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
        return translate(result, context, 422);
      }
    }
    if (context.request.method !== "GET" && context.request.method !== "HEAD") {
      return context.notFound();
    }
    const token = options.actions ? await options.actions.csrfToken(context) : undefined;
    const result = await renderRouteRequest({
      url: context.request.url,
      manifest,
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
    return translate(result, context);
  };
}
