import {
  renderRouteRequestToString,
  type RenderRouteRequestResult,
} from "@askrjs/askr/ssr";
import type { ServerQueryRegistry } from "@askrjs/askr/data";
import type { RouteAuthOptions, RouteManifest, RouteRegistry } from "@askrjs/askr/router";
import type { Handler, ServerContext } from "../contracts";

export interface AskrPageHandlerOptions {
  manifest?: RouteManifest;
  registry?: RouteRegistry;
  auth?: RouteAuthOptions;
  queryRegistry?: ServerQueryRegistry;
  seed?: number;
}

function translate(result: RenderRouteRequestResult, context: ServerContext): Response {
  if (result.kind === "no-match") return context.notFound();
  if (result.kind === "redirect") {
    return new Response(null, {
      status: result.status ?? 302,
      headers: { location: result.to },
    });
  }
  if (result.kind === "deny") return new Response(null, { status: result.status });
  return new Response(result.html, {
    headers: { "content-type": "text/html; charset=utf-8; askr-fragment=1" },
  });
}

export function createAskrPageHandler(options: AskrPageHandlerOptions): Handler {
  const manifest = options.manifest ?? options.registry?.manifest;
  if (!manifest) {
    throw new Error("createAskrPageHandler requires a route manifest or registry.");
  }
  return async (context) => {
    if (context.request.method !== "GET" && context.request.method !== "HEAD") {
      return context.notFound();
    }
    const result = await renderRouteRequestToString({
      url: context.request.url,
      manifest,
      auth: options.auth ?? manifest.auth,
      authContext: context.auth,
      request: context.request,
      signal: context.signal,
      queryRegistry: options.queryRegistry,
      seed: options.seed,
    });
    return translate(result, context);
  };
}
