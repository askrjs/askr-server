import { addAutomaticAccessResponses } from "./route-builder";
import type {
  ApiOptions,
  JsonSchema,
  OpenApiDocument,
  ParameterDefinition,
  ResponseDefinition,
  RouteState,
} from "./types";
import { validateApi } from "./validate";

const methodOrder = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return sortedRecord(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "x-askr-optional")
      .map(([key, item]) => [key, normalize(item)] as const),
  );
}

function parameter(value: ParameterDefinition): Record<string, unknown> {
  return {
    name: value.name,
    in: value.in,
    ...(value.description ? { description: value.description } : {}),
    ...((value.in === "path" || value.required) ? { required: true } : {}),
    ...(value.deprecated ? { deprecated: true } : {}),
    schema: normalize(value.schema.value),
    ...(value.example !== undefined ? { example: value.example } : {}),
  };
}

function response(value: ResponseDefinition): Record<string, unknown> {
  return {
    description: value.description,
    ...(value.headers ? { headers: normalize(value.headers) } : {}),
    ...(value.schema && value.mediaType
      ? {
          content: {
            [value.mediaType]: {
              schema: normalize(value.schema.value),
              ...(value.examples ? { examples: normalize(value.examples) } : {}),
            },
          },
        }
      : {}),
  };
}

function requestBody<Dependencies>(route: RouteState<Dependencies>): Record<string, unknown> | undefined {
  if (!route.bodies.length) return undefined;
  const descriptions = route.bodies.map((body) => body.description).filter(Boolean);
  return {
    ...(descriptions[0] ? { description: descriptions[0] } : {}),
    ...(route.bodies.some((body) => body.required) ? { required: true } : {}),
    content: sortedRecord(route.bodies.map((body) => [body.mediaType, {
      schema: normalize(body.schema.value),
      ...(body.examples ? { examples: normalize(body.examples) } : {}),
    }] as const)),
  };
}

function operation<Dependencies>(route: RouteState<Dependencies>): Record<string, unknown> {
  const body = requestBody(route);
  const responses = sortedRecord(
    route.responses.map((item) => [item.status, response(item)] as const),
  );
  return {
    ...(route.tags.length ? { tags: [...new Set(route.tags)] } : {}),
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    operationId: route.operationId,
    ...(route.parameters.length ? { parameters: route.parameters.map(parameter) } : {}),
    ...(body ? { requestBody: body } : {}),
    responses,
    ...(route.access ? { security: route.access.security.map((item) => ({ ...item })) } : {}),
    ...(route.deprecated ? { deprecated: true } : {}),
    ...(route.externalDocs ? { externalDocs: { ...route.externalDocs } } : {}),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function createDocument<Dependencies>(
  routes: readonly RouteState<Dependencies>[],
  userSchemas: ReadonlyMap<string, JsonSchema>,
  options: ApiOptions,
  definitionErrors: readonly string[] = [],
): OpenApiDocument {
  if (definitionErrors.length) {
    throw new Error(`Invalid OpenAPI definition:\n- ${definitionErrors.join("\n- ")}`);
  }
  const schemas = new Map(userSchemas);
  if (schemas.has("Problem")) throw new Error("Invalid OpenAPI definition:\n- component name Problem is reserved");
  schemas.set("Problem", {
    type: "object",
    description: "A problem detail response defined by RFC 9457.",
    required: ["type", "title", "status"],
    properties: {
      type: { type: "string", format: "uri-reference" },
      title: { type: "string" },
      status: { type: "integer", minimum: 100, maximum: 599 },
      detail: { type: "string" },
      instance: { type: "string", format: "uri-reference" },
    },
    additionalProperties: true,
  });
  for (const route of routes) addAutomaticAccessResponses(route);
  validateApi(routes, schemas, options);

  const paths = new Map<string, Map<string, Record<string, unknown>>>();
  for (const route of routes) {
    const methods = paths.get(route.path) ?? new Map();
    methods.set(route.method.toLowerCase(), operation(route));
    paths.set(route.path, methods);
  }
  const pathObject = sortedRecord([...paths].map(([path, methods]) => [path, Object.fromEntries(
    [...methods].sort(([left], [right]) => methodOrder.indexOf(left) - methodOrder.indexOf(right)),
  )] as const));
  const securitySchemes = options.securitySchemes;
  const document = {
    openapi: "3.1.2",
    info: normalize(options.info),
    ...(options.servers ? { servers: options.servers.map(normalize) } : {}),
    paths: pathObject,
    components: {
      schemas: sortedRecord([...schemas].map(([name, value]) => [name, normalize(value)] as const)),
      ...(securitySchemes ? { securitySchemes: normalize(securitySchemes) } : {}),
    },
    ...(options.externalDocs ? { externalDocs: normalize(options.externalDocs) } : {}),
  };
  return deepFreeze(document) as OpenApiDocument;
}
