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

type Candidate = { leaf: Leaf; values: readonly string[]; specificity: readonly number[] };

export interface RouteMatch {
  route: ApiRoute;
  params: Params;
}

export interface MatchResult {
  match?: RouteMatch;
  allowed: string[];
}

export interface CompiledMatcher {
  match(pathname: string, method: string): MatchResult;
}

export class MalformedPathParameterError extends URIError {}

function node(): Node {
  return { static: new Map(), leaves: [] };
}

function pathnameSegments(pathname: string): string[] | undefined {
  if (pathname === "/") return [];
  const source = pathname.endsWith("/") ? pathname.slice(1, -1) : pathname.slice(1);
  if (!source) return undefined;
  const parts = source.split("/");
  return parts.some((part) => !part) ? undefined : parts;
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

function collect(
  current: Node,
  parts: readonly string[],
  index: number,
  values: readonly string[],
  specificity: readonly number[],
  candidates: Candidate[],
): void {
  if (index === parts.length) {
    for (const leaf of current.leaves) candidates.push({ leaf, values, specificity });
    if (current.namedWildcard) {
      for (const leaf of current.namedWildcard.leaves) {
        candidates.push({
          leaf,
          values: [...values, ""],
          specificity: [...specificity, 0],
        });
      }
    }
    return;
  }
  const part = parts[index];
  const staticChild = current.static.get(part);
  if (staticChild) collect(staticChild, parts, index + 1, values, [...specificity, 2], candidates);
  if (current.parameter) {
    collect(
      current.parameter,
      parts,
      index + 1,
      [...values, part],
      [...specificity, 1],
      candidates,
    );
  }
  if (current.namedWildcard) {
    for (const leaf of current.namedWildcard.leaves) {
      candidates.push({
        leaf,
        values: [...values, parts.slice(index).join("/")],
        specificity: [...specificity, 0],
      });
    }
  }
  if (current.wildcard) {
    for (const leaf of current.wildcard.leaves) {
      candidates.push({ leaf, values, specificity: [...specificity, 0] });
    }
  }
}

function compareSpecificity(left: Candidate, right: Candidate): number {
  const length = Math.max(left.specificity.length, right.specificity.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (right.specificity[index] ?? -1) - (left.specificity[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

function compareForMethod(method: string, left: Candidate, right: Candidate): number {
  const specificity = compareSpecificity(left, right);
  if (specificity) return specificity;
  if (method === "HEAD") {
    const leftExplicit = left.leaf.methods.includes("HEAD");
    const rightExplicit = right.leaf.methods.includes("HEAD");
    if (leftExplicit !== rightExplicit) return leftExplicit ? -1 : 1;
  }
  return left.leaf.order - right.leaf.order;
}

function supports(leaf: Leaf, method: string): boolean {
  if (leaf.methods.includes(method)) return true;
  return method === "HEAD" && !leaf.route.upgrade && leaf.methods.includes("GET");
}

function decode(candidate: Candidate): Params {
  const params = { __proto__: null } as unknown as Params;
  try {
    candidate.leaf.parameterNames.forEach((name, index) => {
      const raw = candidate.values[index] ?? "";
      params[name] = raw.split("/").map(decodeURIComponent).join("/");
    });
  } catch (error) {
    throw new MalformedPathParameterError("A route parameter contains invalid percent-encoding.", {
      cause: error,
    });
  }
  return params;
}

function allowedMethods(candidates: readonly Candidate[]): string[] {
  const allowed: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...candidates].sort(
    (left, right) => left.leaf.order - right.leaf.order,
  )) {
    for (const method of candidate.leaf.methods) {
      if (!seen.has(method)) {
        seen.add(method);
        allowed.push(method);
      }
      if (method === "GET" && !candidate.leaf.route.upgrade && !seen.has("HEAD")) {
        seen.add("HEAD");
        allowed.push("HEAD");
      }
    }
  }
  return allowed;
}

export function createMatcher(routes: readonly ApiRoute[]): CompiledMatcher {
  const root = node();
  [...routes].forEach((route, order) => addRoute(root, route, order));
  return {
    match(pathname, method) {
      const normalizedMethod = method.toUpperCase();
      const candidates: Candidate[] = [];
      const parts = pathnameSegments(pathname);
      if (parts) collect(root, parts, 0, [], [], candidates);
      candidates.sort((left, right) => compareForMethod(normalizedMethod, left, right));
      const candidate = candidates.find((value) => supports(value.leaf, normalizedMethod));
      return {
        match: candidate ? { route: candidate.leaf.route, params: decode(candidate) } : undefined,
        allowed: allowedMethods(candidates),
      };
    },
  };
}
