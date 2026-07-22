import type { ApiOptions, JsonSchema, RouteState, Schema } from "./types";

const componentName = /^[A-Za-z0-9._-]+$/;
const operationId = /^[A-Za-z][A-Za-z0-9._-]*$/;
const statusCode = /^(?:[1-5](?:[0-9][0-9]|XX)|default)$/;

function visitSchema(value: unknown, visit: (ref: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitSchema(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") visit(record.$ref);
  for (const item of Object.values(record)) visitSchema(item, visit);
}

function routeSchemas<Dependencies>(
  route: RouteState<Dependencies>,
): Array<Pick<Schema, "jsonSchema">> {
  return [
    ...route.parameters.map((parameter) => parameter.schema),
    ...route.bodies.map((body) => body.schema),
    ...route.responses.flatMap((response) => (response.schema ? [response.schema] : [])),
  ];
}

function validateReferences<Dependencies>(
  routes: readonly RouteState<Dependencies>[],
  schemas: ReadonlyMap<string, JsonSchema>,
): string[] {
  const errors: string[] = [];
  const values: unknown[] = [...schemas.values()];
  for (const route of routes) values.push(...routeSchemas(route).map((value) => value.jsonSchema));
  for (const value of values) {
    visitSchema(value, (ref) => {
      const prefix = "#/components/schemas/";
      if (ref.startsWith(prefix)) {
        const name = ref.slice(prefix.length);
        if (!schemas.has(name)) errors.push(`unresolved schema reference ${ref}`);
      }
    });
  }
  return errors;
}

function pathParameters(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
}

export function validateApi<Dependencies>(
  routes: readonly RouteState<Dependencies>[],
  schemas: ReadonlyMap<string, JsonSchema>,
  options: ApiOptions,
): void {
  const errors: string[] = [];
  const operationIds = new Map<string, string>();
  const routeKeys = new Set<string>();
  const securitySchemes = new Set(Object.keys(options.securitySchemes ?? {}));

  for (const name of schemas.keys()) {
    if (!componentName.test(name)) errors.push(`invalid component name ${name}`);
  }
  for (const name of securitySchemes) {
    if (!componentName.test(name)) errors.push(`invalid security scheme name ${name}`);
  }
  for (const route of routes) {
    const label = `${route.method} ${route.path}`;
    errors.push(...route.errors.map((error) => `${label}: ${error}`));
    if (route.path.includes("*")) errors.push(`${label}: wildcard paths are not supported`);
    if (options.metadata === "authored" && !route.operationIdExplicit)
      errors.push(`${label}: operationId is required`);
    if (!route.operationId) errors.push(`${label}: operationId is required`);
    else if (!operationId.test(route.operationId))
      errors.push(`${label}: invalid operationId ${route.operationId}`);
    else if (operationIds.has(route.operationId))
      errors.push(
        `duplicate operationId ${route.operationId} collides between ${operationIds.get(route.operationId)} and ${label}`,
      );
    else operationIds.set(route.operationId, label);
    if (route.summary !== undefined && !route.summary.trim())
      errors.push(`${label}: summary must not be blank`);
    else if (options.metadata === "authored" && route.summary === undefined)
      errors.push(`${label}: summary is required`);
    if (options.metadata === "authored" && !route.responses.some((response) => response.explicit))
      errors.push(
        `${label}: at least one response is required (automatic access responses do not count)`,
      );
    const routeKey = `${route.method.toLowerCase()} ${route.path}`;
    if (routeKeys.has(routeKey)) errors.push(`${label}: duplicate method/path pair`);
    routeKeys.add(routeKey);

    const expected = pathParameters(route.path).sort();
    const actual = route.parameters
      .filter((value) => value.in === "path")
      .map((value) => value.name)
      .sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      errors.push(`${label}: path parameters must exactly match {${expected.join(", ")}}`);
    }
    const parameterKeys = new Set<string>();
    for (const parameter of route.parameters) {
      const key = `${parameter.in}:${parameter.name.toLowerCase()}`;
      if (parameterKeys.has(key))
        errors.push(`${label}: duplicate parameter ${parameter.in} ${parameter.name}`);
      parameterKeys.add(key);
    }
    for (const response of route.responses) {
      if (!statusCode.test(response.status))
        errors.push(`${label}: invalid response status ${response.status}`);
    }
    for (const requirement of route.access?.security ?? []) {
      for (const name of Object.keys(requirement)) {
        if (!securitySchemes.has(name)) errors.push(`${label}: unresolved security scheme ${name}`);
      }
    }
  }
  errors.push(...validateReferences(routes, schemas));
  if (errors.length)
    throw new Error(`Invalid OpenAPI definition:\n- ${[...new Set(errors)].join("\n- ")}`);
}
