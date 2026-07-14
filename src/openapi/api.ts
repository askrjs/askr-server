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
import type {
  ApiHandler,
  ApiOptions,
  GroupState,
  JsonSchema,
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

function createGroup<Dependencies>(
  state: GroupState,
  routes: RouteState<Dependencies>[],
): ApiGroup<Dependencies> {
  let group: ApiGroup<Dependencies>;
  const parameter = (location: ParameterLocation, name: string, value: Schema, options?: ParameterOptions) => {
    addGroupParameter(state, location, name, value, options);
    return group;
  };
  const route = (
    method: string,
    path: string,
    handler: ApiHandler<Dependencies>,
  ): RouteBuilder<Dependencies> => {
    const routeState: RouteState<Dependencies> = {
      method: method.toUpperCase(),
      path: joinPath(state.prefix, path),
      handler,
      tags: [...state.tags],
      parameters: [...state.parameters],
      bodies: [],
      responses: [],
      middleware: [...state.middleware],
      access: state.access,
      errors: [],
    };
    routes.push(routeState);
    return createRouteBuilder(routeState);
  };
  const routeMethods = Object.fromEntries(
    methods.map((method) => [method, (path: string, handler: ApiHandler<Dependencies>) => route(method, path, handler)]),
  ) as Pick<ApiGroup<Dependencies>, (typeof methods)[number]>;
  group = {
    tags: (...values) => { state.tags.push(...values); return group; },
    use: (...middleware) => { state.middleware.push(...middleware); return group; },
    access: (requirement, security) => { state.access = { requirement, security }; return group; },
    pathParam: (name, value, options) => parameter("path", name, value, options),
    queryParam: (name, value, options) => parameter("query", name, value, options),
    headerParam: (name, value, options) => parameter("header", name, value, options),
    cookieParam: (name, value, options) => parameter("cookie", name, value, options),
    group: (prefix) => createGroup(cloneGroup(state, prefix), routes),
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
  const root = createGroup<Dependencies>({
    prefix: "",
    tags: [],
    parameters: [],
    middleware: [],
  }, routes);
  return Object.assign(root, {
    schema<T>(name: string, value: Schema<T>): Schema<T> {
      if (schemas.has(name)) errors.push(`duplicate schema component ${name}`);
      schemas.set(name, value.value);
      return { value: { $ref: `#/components/schemas/${name}` } };
    },
    createRouter(dependencies?: Dependencies) {
      createDocument(routes, schemas, options, errors);
      const router = createRouter();
      for (const route of routes) {
        router.route(route.method, route.path, (context) => route.handler(context, dependencies as Dependencies), {
          auth: route.access?.requirement,
          middleware: route.middleware,
        });
      }
      return router;
    },
    toOpenApiDocument() {
      return createDocument(routes, schemas, options, errors);
    },
  });
}
