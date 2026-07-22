import { createRouter } from "../router/router";
import { createDocument } from "./document";
import type {
  ApiDefinition,
  ApiGroup,
  ParameterLocation,
  ParameterOptions,
  RouteBuilder,
} from "./public";
import { createRouteBuilder } from "./route-builder";
import { readOperationInput } from "./request-input";
import { validateOperationResponse } from "./response-validation";
import type {
  ApiHandler,
  ApiOperation,
  ApiOptions,
  GroupState,
  InputDocumentation,
  JsonSchema,
  ParameterDefinition,
  RouteState,
  Schema,
} from "./types";
const methods = ["get", "post", "put", "patch", "delete", "options", "head", "trace"] as const;
function joinPath(prefix: string, path: string): string {
  const left = prefix === "/" ? "" : prefix.replace(/\/$/, "");
  const right = path === "/" ? "" : path.replace(/^\//, "");
  const joined = `${left}/${right}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}
function cloneGroup(state: GroupState, prefix: string): GroupState {
  return {
    prefix: joinPath(state.prefix, prefix),
    tags: [...state.tags],
    parameters: [...state.parameters],
    middleware: [...state.middleware],
    access: state.access,
  };
}
function addGroupParameter(
  state: GroupState,
  location: ParameterLocation,
  name: string,
  value: Schema,
  options: ParameterOptions = {},
): void {
  state.parameters.push({
    name,
    in: location,
    schema: value,
    ...options,
    ...(location === "path" ? { required: true } : {}),
  });
}
function projectedSchema(jsonSchema: unknown): Pick<Schema, "jsonSchema"> {
  return { jsonSchema: jsonSchema as JsonSchema };
}
function operationParameters(
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
      if (metadata && Object.keys(metadata).length)
        errors.push(`documentation for undeclared ${source}`);
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
      if (!Object.hasOwn(properties, name))
        errors.push(`documentation for undeclared ${source}.${name}`);
    }
  }
  return output;
}

function operationBodies(
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
  if (mediaTypes.length !== body.mediaTypes.length)
    errors.push("body input media types must be unique and non-empty");
  return mediaTypes.map((mediaType) => ({
    mediaType,
    schema: body.schema,
    ...operation.documentation?.body,
  }));
}

function createGroup<Dependencies, Prefix extends string>(
  state: GroupState,
  routes: RouteState<Dependencies>[],
  validateResponses: boolean | undefined,
): ApiGroup<Dependencies, Prefix> {
  let group: ApiGroup<Dependencies, Prefix>;
  const parameter = (
    location: ParameterLocation,
    name: string,
    value: Schema,
    options?: ParameterOptions,
  ) => {
    addGroupParameter(state, location, name, value, options);
    return group;
  };
  const route = <const Path extends string>(
    method: string,
    path: Path,
    handler:
      | ApiHandler<Dependencies, import("../contracts").PathParams<`${Prefix}${Path}`>>
      | ApiOperation<Dependencies>,
  ): RouteBuilder<Dependencies> => {
    let routeState: RouteState<Dependencies>;
    const executableOperation =
      typeof handler === "function" ? undefined : (handler as ApiOperation<Dependencies>);
    const runtimeHandler: ApiHandler<Dependencies> =
      typeof handler === "function"
        ? (handler as ApiHandler<Dependencies>)
        : async (context, dependencies) => {
            const result = await readOperationInput(context, handler.input ?? {});
            if (!result.success) {
              return result.status === 400
                ? context.badRequest(result.detail)
                : context.problem(422, "Request input did not match the declared schema.", {
                    extensions: { issues: result.issues },
                  });
            }
            const response = await handler.handler(context, result.data, dependencies!);
            return validateOperationResponse(
              validateResponses,
              routeState.responses,
              response,
              context,
            );
          };
    const definitionErrors: string[] = [];
    const canonicalParameters = executableOperation
      ? operationParameters(
          executableOperation.input,
          executableOperation.documentation,
          definitionErrors,
        )
      : [...state.parameters];
    const canonicalBodies = executableOperation
      ? operationBodies(executableOperation as ApiOperation<unknown>, definitionErrors)
      : [];
    if (executableOperation && state.parameters.length) {
      definitionErrors.push("executable operations cannot inherit schema-bearing group parameters");
    }
    routeState = {
      method: method.toUpperCase(),
      path: joinPath(state.prefix, path),
      handler: runtimeHandler,
      tags: [...state.tags],
      parameters: canonicalParameters,
      bodies: canonicalBodies,
      responses: [],
      middleware: [...state.middleware],
      access: state.access,
      errors: definitionErrors,
      ...(typeof handler === "function" ? {} : { input: handler.input }),
    };
    routes.push(routeState);
    return createRouteBuilder(routeState);
  };
  const routeMethods = Object.fromEntries(
    methods.map((method) => [
      method,
      (path: string, handler: ApiHandler<Dependencies>) => route(method, path, handler),
    ]),
  ) as Pick<ApiGroup<Dependencies, Prefix>, (typeof methods)[number]>;
  group = {
    tags: (...values) => {
      state.tags.push(...values);
      return group;
    },
    use: (...middleware) => {
      state.middleware.push(...middleware);
      return group;
    },
    access: (requirement, security) => {
      state.access = { requirement, security };
      return group;
    },
    pathParam: (name, value, options) => parameter("path", name, value, options),
    queryParam: (name, value, options) => parameter("query", name, value, options),
    headerParam: (name, value, options) => parameter("header", name, value, options),
    cookieParam: (name, value, options) => parameter("cookie", name, value, options),
    group: <const Child extends string>(prefix: Child) =>
      createGroup<Dependencies, `${Prefix}${Child}`>(
        cloneGroup(state, prefix),
        routes,
        validateResponses,
      ),
    ...routeMethods,
  };
  return group;
}

export function createApi<Dependencies = undefined>(
  options: ApiOptions,
): ApiDefinition<Dependencies> {
  const routes: RouteState<Dependencies>[] = [];
  const schemas = new Map<string, JsonSchema>();
  const errors: string[] = [];
  const root = createGroup<Dependencies, "">(
    {
      prefix: "",
      tags: [],
      parameters: [],
      middleware: [],
    },
    routes,
    options.validateResponses,
  );
  return Object.assign(root, {
    schema<const Value extends Schema>(name: string, value: Value): Value {
      if (schemas.has(name)) errors.push(`duplicate schema component ${name}`);
      schemas.set(name, value.jsonSchema);
      return {
        jsonSchema: { $ref: `#/components/schemas/${name}` },
        safeParse: (input: unknown) => value.safeParse(input),
        ...("kind" in value ? { kind: value.kind } : {}),
      } as unknown as Value;
    },
    createRouter(dependencies?: Dependencies) {
      createDocument(routes, schemas, options, errors);
      const router = createRouter();
      for (const route of routes) {
        router.route(
          route.method,
          route.path,
          async (context) => {
            const requestId =
              typeof context.state.requestId === "string" ? context.state.requestId : undefined;
            const traceId =
              typeof context.state.traceId === "string"
                ? context.state.traceId
                : context.telemetry?.traceId();
            const operation = route.operationId ?? `${route.method} ${route.path}`;
            const fields = { requestId, traceId, route: route.path, operation };
            const execute = () => route.handler(context, dependencies!);
            const response = await (context.telemetry
              ? context.telemetry.apiOperation(fields, execute)
              : execute());
            return response;
          },
          {
            auth: route.access?.requirement,
            middleware: route.middleware,
            maxRequestBytes: route.maxRequestBytes,
          },
        );
      }
      return router;
    },
    toOpenApiDocument() {
      return createDocument(routes, schemas, options, errors);
    },
  });
}
