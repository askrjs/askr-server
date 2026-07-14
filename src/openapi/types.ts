import type { AuthRequirement } from "@askrjs/auth";
import type { Middleware, ServerContext } from "../contracts";

export type JsonSchema = Record<string, unknown>;

export interface Schema<T = unknown> {
  readonly value: JsonSchema;
  readonly __type?: T;
}

export type InferSchema<T> = T extends Schema<infer Value> ? Value : never;

export interface ApiInfo {
  title: string;
  version: string;
  description?: string;
  termsOfService?: string;
  contact?: Record<string, string>;
  license?: Record<string, string>;
}

export interface ApiOptions {
  info: ApiInfo;
  servers?: readonly Record<string, unknown>[];
  externalDocs?: Record<string, unknown>;
  securitySchemes?: Record<string, SecurityScheme>;
}

export type SecurityScheme = Record<string, unknown>;
export type SecurityRequirement = readonly Record<string, readonly string[]>[];

export type ApiHandler<Dependencies> = (
  context: ServerContext,
  dependencies: Dependencies,
) => Response | Promise<Response>;

export interface ParameterDefinition {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  schema: Schema;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  example?: unknown;
}

export interface BodyDefinition {
  mediaType: string;
  schema: Schema;
  required?: boolean;
  description?: string;
  examples?: Record<string, unknown>;
}

export interface ResponseDefinition {
  status: string;
  description: string;
  schema?: Schema;
  mediaType?: string;
  headers?: Record<string, unknown>;
  examples?: Record<string, unknown>;
  explicit: boolean;
}

export interface AccessDefinition {
  requirement: AuthRequirement;
  security: SecurityRequirement;
}

export interface RouteState<Dependencies> {
  method: string;
  path: string;
  handler: ApiHandler<Dependencies>;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: ParameterDefinition[];
  bodies: BodyDefinition[];
  responses: ResponseDefinition[];
  middleware: Middleware[];
  access?: AccessDefinition;
  deprecated?: boolean;
  externalDocs?: Record<string, unknown>;
  errors: string[];
}

export interface GroupState {
  prefix: string;
  tags: string[];
  parameters: ParameterDefinition[];
  middleware: Middleware[];
  access?: AccessDefinition;
}

export type OpenApiDocument = Readonly<Record<string, unknown>>;
