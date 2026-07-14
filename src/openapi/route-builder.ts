import type { Middleware } from "../contracts";
import type {
  BodyOptions,
  ParameterLocation,
  ParameterOptions,
  ResponseOptions,
  RouteBuilder,
} from "./public";
import type { RouteState, Schema } from "./types";

const problem = (): Schema => ({ value: { $ref: "#/components/schemas/Problem" } });

const responseDescriptions: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "204": "No Content",
  "301": "Moved Permanently",
  "302": "Found",
  "303": "See Other",
  "307": "Temporary Redirect",
  "308": "Permanent Redirect",
  "400": "Bad Request",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "409": "Conflict",
  "422": "Unprocessable Entity",
  "429": "Too Many Requests",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "503": "Service Unavailable",
};

function addParameter<Dependencies>(
  state: RouteState<Dependencies>,
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

function addBody<Dependencies>(
  state: RouteState<Dependencies>,
  mediaType: string,
  value: Schema,
  options: BodyOptions = {},
): void {
  const existing = state.bodies.find((body) => body.mediaType === mediaType);
  if (existing) state.errors.push(`duplicate request body media type ${mediaType}`);
  state.bodies.push({ mediaType, schema: value, ...options });
}

function addResponse<Dependencies>(
  state: RouteState<Dependencies>,
  status: number | string,
  value?: Schema,
  options: ResponseOptions = {},
): void {
  const key = String(status);
  if (state.responses.some((response) => response.status === key && response.explicit)) {
    state.errors.push(`duplicate explicit response ${key}`);
  }
  state.responses.push({
    status: key,
    description: options.description ?? responseDescriptions[key] ?? "Response",
    schema: value,
    mediaType: options.mediaType ?? (value ? "application/json" : undefined),
    headers: options.headers,
    examples: options.examples,
    explicit: true,
  });
}

function problemResponse<Dependencies>(
  state: RouteState<Dependencies>,
  status: number,
  value: Schema | undefined,
  options: ResponseOptions,
): void {
  addResponse(state, status, value ?? problem(), {
    mediaType: "application/problem+json",
    ...options,
  });
}

export function createRouteBuilder<Dependencies>(
  state: RouteState<Dependencies>,
): RouteBuilder<Dependencies> {
  let builder: RouteBuilder<Dependencies>;
  const parameter = (location: ParameterLocation, name: string, value: Schema, options?: ParameterOptions) => {
    addParameter(state, location, name, value, options);
    return builder;
  };
  const body = (mediaType: string, value: Schema, options?: BodyOptions) => {
    addBody(state, mediaType, value, options);
    return builder;
  };
  const response = (status: number | string, value?: Schema, options?: ResponseOptions) => {
    addResponse(state, status, value, options);
    return builder;
  };
  const errorResponse = (status: number, value?: Schema, options: ResponseOptions = {}) => {
    problemResponse(state, status, value, options);
    return builder;
  };
  builder = {
    operationId: (value) => { state.operationId = value; return builder; },
    summary: (value) => { state.summary = value; return builder; },
    description: (value) => { state.description = value; return builder; },
    tags: (...values) => { state.tags.push(...values); return builder; },
    deprecated: (value = true) => { state.deprecated = value; return builder; },
    externalDocs: (url, description) => {
      state.externalDocs = { url, ...(description ? { description } : {}) };
      return builder;
    },
    use: (...values: Middleware[]) => { state.middleware.push(...values); return builder; },
    access: (requirement, security) => { state.access = { requirement, security }; return builder; },
    pathParam: (name, value, options) => parameter("path", name, value, options),
    queryParam: (name, value, options) => parameter("query", name, value, options),
    headerParam: (name, value, options) => parameter("header", name, value, options),
    cookieParam: (name, value, options) => parameter("cookie", name, value, options),
    jsonBody: (value, options) => body("application/json", value, options),
    formBody: (value, options) => body("application/x-www-form-urlencoded", value, options),
    multipartBody: (value, options) => body("multipart/form-data", value, options),
    body,
    response,
    ok: (value, options) => response(200, value, options),
    created: (value, options) => response(201, value, options),
    accepted: (value, options) => response(202, value, options),
    noContent: (options) => response(204, undefined, options),
    movedPermanently: (value, options) => response(301, value, options),
    found: (value, options) => response(302, value, options),
    seeOther: (value, options) => response(303, value, options),
    temporaryRedirect: (value, options) => response(307, value, options),
    permanentRedirect: (value, options) => response(308, value, options),
    badRequest: (value, options) => errorResponse(400, value, options),
    unauthorized: (value, options) => errorResponse(401, value, options),
    forbidden: (value, options) => errorResponse(403, value, options),
    notFound: (value, options) => errorResponse(404, value, options),
    conflict: (value, options) => errorResponse(409, value, options),
    unprocessableEntity: (value, options) => errorResponse(422, value, options),
    tooManyRequests: (value, options) => errorResponse(429, value, options),
    methodNotAllowed: (value, options) => errorResponse(405, value, options),
    internalServerError: (value, options) => errorResponse(500, value, options),
    notImplemented: (value, options) => errorResponse(501, value, options),
    serviceUnavailable: (value, options) => errorResponse(503, value, options),
  };
  return builder;
}

export function addAutomaticAccessResponses<Dependencies>(state: RouteState<Dependencies>): void {
  if (!state.access || state.access.security.length === 0) return;
  for (const status of [401, 403]) {
    const key = String(status);
    if (!state.responses.some((response) => response.status === key)) {
      state.responses.push({
        status: key,
        description: responseDescriptions[key],
        schema: problem(),
        mediaType: "application/problem+json",
        explicit: false,
      });
    }
  }
}
