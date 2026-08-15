import type { ApiRoute, Params } from "../contracts";
import { routeMethods } from "./method";
import { parseRoutePath } from "./path";

type Leaf = {
  route: ApiRoute;
  methods: readonly string[];
  order: number;
  parameterNames: readonly string[];
};

type Node = {
  static: Map<string, Node>;
  parameter?: Node;
  namedWildcard?: Node;
  wildcard?: Node;
  leaves: Leaf[];
};

export interface RouteMatch {
  route: ApiRoute;
  params: Params;
}

type MatchCandidate = {
  leaf: Leaf;
  values: readonly string[];
  deferEmptyWildcard: boolean;
};

export interface MatchResult {
  match?: RouteMatch;
  allowed: readonly string[];
}

export interface CompiledMatcher {
  match(pathname: string, method: string, params?: Params): MatchResult;
}

export class MalformedPathParameterError extends URIError {}

function node(): Node {
  return { static: new Map(), leaves: [] };
}

function pathnameSegments(pathname: string): string[] | undefined {
  if (pathname === "/") return [];
  if (pathname.charCodeAt(0) !== 47) return undefined;
  const end =
    pathname.charCodeAt(pathname.length - 1) === 47 ? pathname.length - 1 : pathname.length;
  if (end <= 1) return undefined;
  const parts: string[] = [];
  let start = 1;
  for (let index = 1; index <= end; index += 1) {
    if (index !== end && pathname.charCodeAt(index) !== 47) continue;
    if (index === start) return undefined;
    parts.push(pathname.slice(start, index));
    start = index + 1;
  }
  return parts;
}

function parameterChild(parent: Node): Node {
  parent.parameter ??= node();
  return parent.parameter;
}

function wildcardChild(parent: Node, named: boolean): Node {
  const key = named ? "namedWildcard" : "wildcard";
  parent[key] ??= node();
  return parent[key];
}

function addRoute(root: Node, route: ApiRoute, order: number): void {
  let current = root;
  const names: string[] = [];
  for (const segment of parseRoutePath(route.path)) {
    if (segment.kind === "wildcard") {
      if (segment.name) names.push(segment.name);
      current = wildcardChild(current, segment.name !== undefined);
      break;
    }
    if (segment.kind === "parameter") {
      names.push(segment.name);
      current = parameterChild(current);
      continue;
    }
    const existing = current.static.get(segment.value);
    if (existing) current = existing;
    else {
      const child = node();
      current.static.set(segment.value, child);
      current = child;
    }
  }
  const methods = routeMethods(route.method);
  current.leaves.push({ route, methods, order, parameterNames: names });
}

function hasMethod(leaf: Leaf, method: string): boolean {
  return leaf.methods.length === 1 ? leaf.methods[0] === method : leaf.methods.includes(method);
}

function supports(leaf: Leaf, method: string): boolean {
  if (hasMethod(leaf, method)) return true;
  return method === "HEAD" && !leaf.route.upgrade && hasMethod(leaf, "GET");
}

function preferredLeaf(
  method: string,
  left: Leaf | undefined,
  right: Leaf | undefined,
): Leaf | undefined {
  if (!left) return right;
  if (!right) return left;
  if (method === "HEAD") {
    const leftExplicit = hasMethod(left, "HEAD");
    const rightExplicit = hasMethod(right, "HEAD");
    if (leftExplicit !== rightExplicit) return leftExplicit ? left : right;
  }
  return left.order <= right.order ? left : right;
}

function matchingLeaf(leaves: readonly Leaf[], method: string): Leaf | undefined {
  let match: Leaf | undefined;
  for (const leaf of leaves) {
    if (supports(leaf, method)) match = preferredLeaf(method, match, leaf);
  }
  return match;
}

function decode(leaf: Leaf, values: readonly string[], params?: Params): Params {
  const output = params ?? {};
  try {
    leaf.parameterNames.forEach((name, index) => {
      const value = decodeURIComponent(values[index] ?? "");
      if (name === "__proto__") {
        Object.defineProperty(output, name, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
      } else {
        output[name] = value;
      }
    });
  } catch (error) {
    throw new MalformedPathParameterError("A route parameter contains invalid percent-encoding.", {
      cause: error,
    });
  }
  return output;
}

function routeMatch(leaf: Leaf, values: readonly string[], params?: Params): RouteMatch {
  return { route: leaf.route, params: decode(leaf, values, params) };
}

const noValues: readonly string[] = Object.freeze([]);

function matchCandidate(
  leaf: Leaf,
  values: readonly string[] | undefined,
  deferEmptyWildcard: boolean,
): MatchCandidate {
  return { leaf, values: values ? [...values] : noValues, deferEmptyWildcard };
}

function findMatch(
  current: Node,
  parts: readonly string[],
  index: number,
  values: string[] | undefined,
  method: string,
): MatchCandidate | undefined {
  if (index === parts.length) {
    const exact = matchingLeaf(current.leaves, method);
    if (exact) {
      return matchCandidate(exact, values, false);
    }
    if (current.namedWildcard) {
      const leaf = matchingLeaf(current.namedWildcard.leaves, method);
      if (leaf) {
        const captures = values ?? [];
        captures.push("");
        const match = matchCandidate(leaf, captures, true);
        captures.pop();
        return match;
      }
    }
    return undefined;
  }

  const part = parts[index]!;
  const staticChild = current.static.get(part);
  if (staticChild) {
    const match = findMatch(staticChild, parts, index + 1, values, method);
    if (match) return { ...match, deferEmptyWildcard: false };
  }
  let emptyParameterFallback: MatchCandidate | undefined;
  if (current.parameter) {
    const captures = values ?? [];
    captures.push(part);
    const match = findMatch(current.parameter, parts, index + 1, captures, method);
    captures.pop();
    if (match && !match.deferEmptyWildcard) return match;
    emptyParameterFallback = match;
  }

  const named = current.namedWildcard
    ? matchingLeaf(current.namedWildcard.leaves, method)
    : undefined;
  const unnamed = current.wildcard ? matchingLeaf(current.wildcard.leaves, method) : undefined;
  const leaf = preferredLeaf(method, named, unnamed);
  if (!leaf) return emptyParameterFallback;
  if (leaf === named) {
    const captures = values ?? [];
    captures.push(parts.slice(index).join("/"));
    const match = matchCandidate(leaf, captures, false);
    captures.pop();
    return match;
  }
  return matchCandidate(leaf, values, false);
}

function collectLeaves(
  current: Node,
  parts: readonly string[],
  index: number,
  leaves: Leaf[],
): void {
  if (index === parts.length) {
    leaves.push(...current.leaves);
    if (current.namedWildcard) leaves.push(...current.namedWildcard.leaves);
    return;
  }
  const part = parts[index]!;
  const staticChild = current.static.get(part);
  if (staticChild) collectLeaves(staticChild, parts, index + 1, leaves);
  if (current.parameter) collectLeaves(current.parameter, parts, index + 1, leaves);
  if (current.namedWildcard) leaves.push(...current.namedWildcard.leaves);
  if (current.wildcard) leaves.push(...current.wildcard.leaves);
}

function allowedMethods(leaves: Leaf[]): string[] {
  const allowed: string[] = [];
  const seen = new Set<string>();
  leaves.sort((left, right) => left.order - right.order);
  for (const leaf of leaves) {
    for (const method of leaf.methods) {
      if (!seen.has(method)) {
        seen.add(method);
        allowed.push(method);
      }
      if (method === "GET" && !leaf.route.upgrade && !seen.has("HEAD")) {
        seen.add("HEAD");
        allowed.push("HEAD");
      }
    }
  }
  return allowed;
}

function normalizedMethod(method: string): string {
  for (let index = 0; index < method.length; index += 1) {
    const code = method.charCodeAt(index);
    if (code >= 97 && code <= 122) return method.toUpperCase();
  }
  return method;
}

const noMethods: readonly string[] = Object.freeze([]);

export function createMatcher(routes: readonly ApiRoute[]): CompiledMatcher {
  const root = node();
  let order = 0;
  for (const route of routes) addRoute(root, route, order++);
  return {
    match(pathname, method, params) {
      const parts = pathnameSegments(pathname);
      if (!parts) return { allowed: noMethods };
      const match = findMatch(root, parts, 0, undefined, normalizedMethod(method));
      if (match) {
        return { match: routeMatch(match.leaf, match.values, params), allowed: noMethods };
      }
      const leaves: Leaf[] = [];
      collectLeaves(root, parts, 0, leaves);
      return { allowed: allowedMethods(leaves) };
    },
  };
}
