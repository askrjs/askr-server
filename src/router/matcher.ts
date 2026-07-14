import type { ApiRoute, Params } from "../contracts";

const METHOD_BITS: Readonly<Record<string, number>> = {
  GET: 1 << 0,
  HEAD: 1 << 1,
  POST: 1 << 2,
  PUT: 1 << 3,
  PATCH: 1 << 4,
  DELETE: 1 << 5,
  OPTIONS: 1 << 6,
  TRACE: 1 << 7,
  CONNECT: 1 << 8,
};
const GET_BIT = METHOD_BITS.GET;
const HEAD_BIT = METHOD_BITS.HEAD;

type Segment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string }
  | { kind: "wildcard"; name?: string };

type CompiledRoute = {
  route: ApiRoute;
  segments: Segment[];
  methods: string[];
  methodMask: number;
};

export interface RouteMatch {
  route: ApiRoute;
  params: Params;
}

export interface MatchResult {
  match?: RouteMatch;
  allowed: string[];
}

function segments(path: string): string[] {
  return path.split("?", 1)[0].split("/").filter(Boolean);
}

function compile(route: ApiRoute): CompiledRoute {
  const parsed = segments(route.path).map((segment): Segment => {
    if (segment === "*") return { kind: "wildcard" };
    if (segment.startsWith("{*") && segment.endsWith("}")) {
      return { kind: "wildcard", name: segment.slice(2, -1) };
    }
    if (segment.startsWith("{") && segment.endsWith("}")) {
      return { kind: "param", name: segment.slice(1, -1).trim() };
    }
    return { kind: "literal", value: segment };
  });
  const methods = (typeof route.method === "string" ? [route.method] : route.method ?? ["GET"])
    .map((method) => method.toUpperCase());
  return {
    route,
    segments: parsed,
    methods,
    methodMask: methods.reduce((mask, method) => mask | (METHOD_BITS[method] ?? 0), 0),
  };
}

function matchPath(route: CompiledRoute, pathname: string): Params | undefined {
  const parts = segments(pathname);
  const params: Params = {};
  let part = 0;
  for (const segment of route.segments) {
    if (segment.kind === "wildcard") {
      if (segment.name) params[segment.name] = parts.slice(part).map(decodeURIComponent).join("/");
      else if (part >= parts.length) return undefined;
      return params;
    }
    const value = parts[part++];
    if (value === undefined) return undefined;
    if (segment.kind === "literal" && segment.value !== value) return undefined;
    if (segment.kind === "param") params[segment.name] = decodeURIComponent(value);
  }
  return part === parts.length ? params : undefined;
}

export function createMatcher(routes: readonly ApiRoute[]): (request: Request) => MatchResult {
  const compiled = routes.map(compile);
  return (request) => {
    const candidates = compiled
      .map((route) => ({ route, params: matchPath(route, new URL(request.url).pathname) }))
      .filter((candidate): candidate is { route: CompiledRoute; params: Params } => candidate.params !== undefined);
    const allowed: string[] = [];
    const seen = new Set<string>();
    let match: RouteMatch | undefined;
    let implicitHead: RouteMatch | undefined;
    for (const candidate of candidates) {
      for (const method of candidate.route.methods) {
        if (!seen.has(method)) {
          seen.add(method);
          allowed.push(method);
        }
      }
      const canImplicitHead = !candidate.route.route.upgrade &&
        (candidate.route.methodMask & GET_BIT) !== 0 &&
        (candidate.route.methodMask & HEAD_BIT) === 0;
      if (canImplicitHead && !seen.has("HEAD")) {
        seen.add("HEAD");
        allowed.push("HEAD");
      }
      const requestBit = METHOD_BITS[request.method] ?? 0;
      if (!match && (candidate.route.methodMask & requestBit) !== 0) {
        match = { route: candidate.route.route, params: candidate.params };
      }
      if (request.method === "HEAD" && canImplicitHead && !implicitHead) {
        implicitHead = { route: candidate.route.route, params: candidate.params };
      }
    }
    return { match: match ?? implicitHead, allowed };
  };
}
