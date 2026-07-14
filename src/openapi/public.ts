import type { AuthRequirement } from "@askrjs/auth";
import type { Middleware, Router } from "../contracts";
import type {
  ApiHandler,
  OpenApiDocument,
  ParameterDefinition,
  Schema,
  SecurityRequirement,
} from "./types";

export interface ParameterOptions {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  example?: unknown;
}

export interface BodyOptions {
  required?: boolean;
  description?: string;
  examples?: Record<string, unknown>;
}

export interface ResponseOptions {
  description?: string;
  mediaType?: string;
  headers?: Record<string, unknown>;
  examples?: Record<string, unknown>;
}

export interface RouteBuilder<Dependencies> {
  operationId(value: string): RouteBuilder<Dependencies>;
  summary(value: string): RouteBuilder<Dependencies>;
  description(value: string): RouteBuilder<Dependencies>;
  tags(...values: string[]): RouteBuilder<Dependencies>;
  deprecated(value?: boolean): RouteBuilder<Dependencies>;
  externalDocs(url: string, description?: string): RouteBuilder<Dependencies>;
  use(...middleware: Middleware[]): RouteBuilder<Dependencies>;
  access(requirement: AuthRequirement, security: SecurityRequirement): RouteBuilder<Dependencies>;
  pathParam(name: string, value: Schema, options?: ParameterOptions): RouteBuilder<Dependencies>;
  queryParam(name: string, value: Schema, options?: ParameterOptions): RouteBuilder<Dependencies>;
  headerParam(name: string, value: Schema, options?: ParameterOptions): RouteBuilder<Dependencies>;
  cookieParam(name: string, value: Schema, options?: ParameterOptions): RouteBuilder<Dependencies>;
  jsonBody(value: Schema, options?: BodyOptions): RouteBuilder<Dependencies>;
  formBody(value: Schema, options?: BodyOptions): RouteBuilder<Dependencies>;
  multipartBody(value: Schema, options?: BodyOptions): RouteBuilder<Dependencies>;
  body(mediaType: string, value: Schema, options?: BodyOptions): RouteBuilder<Dependencies>;
  response(status: number | string, value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  ok(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  created(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  accepted(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  noContent(options?: ResponseOptions): RouteBuilder<Dependencies>;
  movedPermanently(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  found(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  seeOther(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  temporaryRedirect(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  permanentRedirect(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  badRequest(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  unauthorized(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  forbidden(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  notFound(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  conflict(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  unprocessableEntity(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  tooManyRequests(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  methodNotAllowed(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  internalServerError(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  notImplemented(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
  serviceUnavailable(value?: Schema, options?: ResponseOptions): RouteBuilder<Dependencies>;
}

export interface ApiGroup<Dependencies> {
  tags(...values: string[]): ApiGroup<Dependencies>;
  use(...middleware: Middleware[]): ApiGroup<Dependencies>;
  access(requirement: AuthRequirement, security: SecurityRequirement): ApiGroup<Dependencies>;
  pathParam(name: string, value: Schema, options?: ParameterOptions): ApiGroup<Dependencies>;
  queryParam(name: string, value: Schema, options?: ParameterOptions): ApiGroup<Dependencies>;
  headerParam(name: string, value: Schema, options?: ParameterOptions): ApiGroup<Dependencies>;
  cookieParam(name: string, value: Schema, options?: ParameterOptions): ApiGroup<Dependencies>;
  group(prefix: string): ApiGroup<Dependencies>;
  get(path: string, handler: ApiHandler<Dependencies>): RouteBuilder<Dependencies>;
  post(path: string, handler: ApiHandler<Dependencies>): RouteBuilder<Dependencies>;
  put(path: string, handler: ApiHandler<Dependencies>): RouteBuilder<Dependencies>;
  patch(path: string, handler: ApiHandler<Dependencies>): RouteBuilder<Dependencies>;
  delete(path: string, handler: ApiHandler<Dependencies>): RouteBuilder<Dependencies>;
  options(path: string, handler: ApiHandler<Dependencies>): RouteBuilder<Dependencies>;
  head(path: string, handler: ApiHandler<Dependencies>): RouteBuilder<Dependencies>;
  trace(path: string, handler: ApiHandler<Dependencies>): RouteBuilder<Dependencies>;
}

export interface ApiDefinition<Dependencies> extends ApiGroup<Dependencies> {
  schema<T>(name: string, value: Schema<T>): Schema<T>;
  createRouter(dependencies?: Dependencies): Router;
  toOpenApiDocument(): OpenApiDocument;
}

export type ParameterLocation = ParameterDefinition["in"];
