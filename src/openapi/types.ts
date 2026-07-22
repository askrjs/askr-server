import type { AuthRequirement } from "@askrjs/auth";
import type { InferSchema, JsonSchema, ObjectSchema, Schema } from "@askrjs/schema";
import type { Middleware, Params, ServerContext } from "../contracts";

export type { InferSchema, JsonSchema, ObjectSchema, OptionalSchema, Schema } from "@askrjs/schema";

export interface ContactObject {
  readonly name?: string;
  readonly url?: string;
  readonly email?: string;
  readonly [extension: `x-${string}`]: unknown;
}

export interface LicenseObject {
  readonly name: string;
  readonly identifier?: string;
  readonly url?: string;
  readonly [extension: `x-${string}`]: unknown;
}

export interface ApiInfo {
  readonly title: string;
  readonly version: string;
  readonly summary?: string;
  readonly description?: string;
  readonly termsOfService?: string;
  readonly contact?: ContactObject;
  readonly license?: LicenseObject;
  readonly [extension: `x-${string}`]: unknown;
}

export interface ServerObject {
  readonly url: string;
  readonly description?: string;
  readonly variables?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly [extension: `x-${string}`]: unknown;
}

export interface ExternalDocumentationObject {
  readonly url: string;
  readonly description?: string;
  readonly [extension: `x-${string}`]: unknown;
}

export type SecurityScheme = Readonly<Record<string, unknown>>;
export type SecurityRequirementObject = Readonly<Record<string, readonly string[]>>;
export type SecurityRequirement = readonly SecurityRequirementObject[];

export interface ApiOptions {
  readonly info: ApiInfo;
  /** Infer registration-safe metadata, or require fully authored public contracts. */
  readonly metadata?: "inferred" | "authored";
  readonly servers?: readonly ServerObject[];
  readonly externalDocs?: ExternalDocumentationObject;
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>;
  /** Validate documented response bodies only when explicitly enabled outside production. */
  readonly validateResponses?: boolean;
  readonly [extension: `x-${string}`]: unknown;
}

export type ApiHandler<Dependencies, RouteParams extends Params = Params> = {
  bivarianceHack(
    context: ServerContext<RouteParams>,
    dependencies: Dependencies,
  ): Response | Promise<Response>;
}["bivarianceHack"];

export interface ApiInput {
  readonly params?: ObjectSchema;
  readonly query?: ObjectSchema;
  readonly headers?: ObjectSchema;
  readonly body?: ApiBodyInput;
}
export interface ApiBodyInput<BodySchema extends Schema = Schema> {
  readonly schema: BodySchema;
  readonly mediaTypes: readonly string[];
}
export type InferApiInput<T extends ApiInput> = {
  [Key in keyof T]: T[Key] extends Schema
    ? InferSchema<T[Key]>
    : T[Key] extends ApiBodyInput<infer BodySchema>
      ? InferSchema<BodySchema>
      : never;
};
export interface InputDocumentation {
  readonly params?: Readonly<Record<string, ParameterMetadata>>;
  readonly query?: Readonly<Record<string, ParameterMetadata>>;
  readonly headers?: Readonly<Record<string, ParameterMetadata>>;
  readonly body?: BodyMetadata;
}
export interface ParameterMetadata {
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly example?: unknown;
}
export interface BodyMetadata {
  readonly required?: boolean;
  readonly description?: string;
  readonly examples?: Record<string, unknown>;
}
export interface ApiOperation<
  Dependencies,
  Input extends ApiInput = ApiInput,
  RouteParams extends Params = Params,
> {
  readonly input?: Input;
  readonly documentation?: InputDocumentation;
  readonly handler: (
    context: ServerContext<RouteParams>,
    input: InferApiInput<Input>,
    dependencies: Dependencies,
  ) => Response | Promise<Response>;
}

export interface ParameterDefinition {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  schema: Pick<Schema, "jsonSchema">;
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
  operationIdExplicit?: boolean;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: ParameterDefinition[];
  bodies: BodyDefinition[];
  responses: ResponseDefinition[];
  middleware: Middleware[];
  maxRequestBytes?: number;
  access?: AccessDefinition;
  deprecated?: boolean;
  externalDocs?: ExternalDocumentationObject;
  errors: string[];
  input?: ApiInput;
}

export interface MediaTypeObject {
  readonly schema?: JsonSchema;
  readonly examples?: Readonly<Record<string, unknown>>;
  readonly [extension: `x-${string}`]: unknown;
}

export interface ParameterObject {
  readonly name: string;
  readonly in: ParameterDefinition["in"];
  readonly description?: string;
  readonly required?: boolean;
  readonly deprecated?: boolean;
  readonly schema: JsonSchema;
  readonly example?: unknown;
  readonly [extension: `x-${string}`]: unknown;
}

export interface RequestBodyObject {
  readonly description?: string;
  readonly required?: boolean;
  readonly content: Readonly<Record<string, MediaTypeObject>>;
  readonly [extension: `x-${string}`]: unknown;
}

export interface ResponseObject {
  readonly description: string;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly content?: Readonly<Record<string, MediaTypeObject>>;
  readonly [extension: `x-${string}`]: unknown;
}

export interface OperationObject {
  readonly tags?: readonly string[];
  readonly summary?: string;
  readonly description?: string;
  readonly operationId?: string;
  readonly parameters?: readonly ParameterObject[];
  readonly requestBody?: RequestBodyObject;
  readonly responses: Readonly<Record<string, ResponseObject>>;
  readonly security?: SecurityRequirement;
  readonly deprecated?: boolean;
  readonly externalDocs?: ExternalDocumentationObject;
  readonly [extension: `x-${string}`]: unknown;
}

export interface PathItemObject {
  readonly get?: OperationObject;
  readonly put?: OperationObject;
  readonly post?: OperationObject;
  readonly delete?: OperationObject;
  readonly options?: OperationObject;
  readonly head?: OperationObject;
  readonly patch?: OperationObject;
  readonly trace?: OperationObject;
  readonly [extension: `x-${string}`]: unknown;
}

export interface ComponentsObject {
  readonly schemas: Readonly<Record<string, JsonSchema>>;
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>;
  readonly [extension: `x-${string}`]: unknown;
}

export interface OpenApiDocument {
  readonly openapi: "3.1.2";
  readonly info: ApiInfo;
  readonly servers?: readonly ServerObject[];
  readonly paths: Readonly<Record<string, PathItemObject>>;
  readonly components: ComponentsObject;
  readonly externalDocs?: ExternalDocumentationObject;
  readonly [extension: `x-${string}`]: unknown;
}

export interface GroupState {
  prefix: string;
  tags: string[];
  parameters: ParameterDefinition[];
  middleware: Middleware[];
  access?: AccessDefinition;
}
