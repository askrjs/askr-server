import type {
  ApiOperation,
  InputDocumentation,
  JsonSchema,
  ParameterDefinition,
  RouteState,
  Schema,
} from "./types";

function projectedSchema(jsonSchema: unknown): Pick<Schema, "jsonSchema"> {
  return { jsonSchema: jsonSchema as JsonSchema };
}

export function operationParameters(
  input: ApiOperation<unknown>["input"],
  documentation: InputDocumentation | undefined,
  errors: string[],
): ParameterDefinition[] {
  const output: ParameterDefinition[] = [];
  const sources = [
    ["params", "path"],
    ["query", "query"],
    ["headers", "header"],
  ] as const;
  for (const [source, location] of sources) {
    const declaration = input?.[source];
    const metadata = documentation?.[source];
    if (!declaration) {
      if (metadata && Object.keys(metadata).length) {
        errors.push(`documentation for undeclared ${source}`);
      }
      continue;
    }
    const properties = declaration.jsonSchema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      errors.push(`${source} input schema must expose object properties`);
      continue;
    }
    const required = new Set(
      Array.isArray(declaration.jsonSchema.required)
        ? declaration.jsonSchema.required.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    );
    for (const [name, jsonSchema] of Object.entries(properties as Record<string, unknown>)) {
      const docs = metadata?.[name];
      output.push({
        name,
        in: location,
        schema: projectedSchema(jsonSchema),
        ...docs,
        ...(location === "path" || required.has(name) ? { required: true } : {}),
      });
    }
    for (const name of Object.keys(metadata ?? {})) {
      if (!Object.hasOwn(properties, name)) {
        errors.push(`documentation for undeclared ${source}.${name}`);
      }
    }
  }
  return output;
}

export function operationBodies(
  operation: ApiOperation<unknown>,
  errors: string[],
): RouteState<unknown>["bodies"] {
  const body = operation.input?.body;
  if (!body) {
    if (operation.documentation?.body) errors.push("documentation for undeclared body");
    return [];
  }
  const mediaTypes = [
    ...new Set(body.mediaTypes.map((value) => value.trim().toLowerCase())),
  ].filter(Boolean);
  if (mediaTypes.length === 0) errors.push("body input must declare at least one media type");
  if (mediaTypes.length !== body.mediaTypes.length) {
    errors.push("body input media types must be unique and non-empty");
  }
  for (const mediaType of mediaTypes) {
    if (
      mediaType !== "application/json" &&
      !mediaType.endsWith("+json") &&
      mediaType !== "application/x-www-form-urlencoded" &&
      mediaType !== "multipart/form-data"
    ) {
      errors.push(`body input media type ${mediaType} is not supported at runtime`);
    }
  }
  return mediaTypes.map((mediaType) => ({
    mediaType,
    schema: body.schema,
    ...operation.documentation?.body,
  }));
}
