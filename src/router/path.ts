export type RoutePathSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "parameter"; readonly name: string }
  | { readonly kind: "wildcard"; readonly name?: string };

function invalid(path: string, detail: string): TypeError {
  return new TypeError(`Invalid route path ${JSON.stringify(path)}: ${detail}.`);
}

export function parseRoutePath(path: string): readonly RoutePathSegment[] {
  if (!path.startsWith("/")) throw invalid(path, "paths must start with /");
  if (path.includes("?") || path.includes("#")) {
    throw invalid(path, "paths must not contain a query string or fragment");
  }
  if (path === "/") return [];
  const source = path.endsWith("/") ? path.slice(1, -1) : path.slice(1);
  if (!source) throw invalid(path, "paths must not contain empty segments");
  const parts = source.split("/");
  if (parts.some((part) => !part)) throw invalid(path, "paths must not contain empty segments");

  const names = new Set<string>();
  return parts.map((part, index) => {
    if (part === "*") {
      if (index !== parts.length - 1) throw invalid(path, "wildcards must be the final segment");
      return { kind: "wildcard" };
    }
    const parameter = /^\{([^{}]+)\}$/.exec(part);
    if (parameter) {
      const sourceName = parameter[1]!.trim();
      const wildcard = sourceName.startsWith("*");
      const name = (wildcard ? sourceName.slice(1) : sourceName).trim();
      if (!name || name.includes("*")) throw invalid(path, "parameter names must not be empty");
      if (names.has(name)) throw invalid(path, `parameter ${JSON.stringify(name)} is duplicated`);
      if (wildcard && index !== parts.length - 1) {
        throw invalid(path, "wildcards must be the final segment");
      }
      names.add(name);
      return wildcard ? { kind: "wildcard", name } : { kind: "parameter", name };
    }
    if (part.includes("{") || part.includes("}")) {
      throw invalid(path, "parameters must occupy an entire segment");
    }
    return { kind: "static", value: part };
  });
}
