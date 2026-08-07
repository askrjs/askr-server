const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function routeMethods(method: string | readonly string[] | undefined): readonly string[] {
  const values = typeof method === "string" ? [method] : (method ?? ["GET"]);
  if (!values.length) throw new TypeError("A route must declare at least one HTTP method.");
  const normalized = values.map((value) => value.trim().toUpperCase());
  if (normalized.some((value) => !token.test(value))) {
    throw new TypeError("Route methods must be valid non-empty HTTP tokens.");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("A route must not declare duplicate HTTP methods.");
  }
  return normalized;
}
