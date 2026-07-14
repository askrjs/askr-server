import type { InferSchema, JsonSchema, OptionalSchema, Schema } from "./types";

type CommonOptions = {
  description?: string;
  title?: string;
  examples?: readonly unknown[];
  default?: unknown;
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
};

type StringOptions = CommonOptions & {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
};

type NumberOptions = CommonOptions & {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
};

type ArrayOptions = CommonOptions & {
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
};

type ObjectOptions = CommonOptions & {
  additionalProperties?: boolean | Schema;
  minProperties?: number;
  maxProperties?: number;
};

const optionalSchemas = new WeakSet<Schema>();

function make<T>(value: JsonSchema, optional = false): Schema<T> {
  const result = { value: Object.freeze(value) };
  if (optional) optionalSchemas.add(result);
  return Object.freeze(result);
}

function common(type: string, options: CommonOptions = {}): JsonSchema {
  return { type, ...options };
}

function stringFormat(format: string, options: StringOptions = {}): Schema<string> {
  return make<string>({ type: "string", ...options, format });
}

type OptionalKeys<T extends Record<string, Schema>> = {
  [Key in keyof T]-?: T[Key] extends OptionalSchema<unknown> ? Key : never;
}[keyof T];

type ObjectValue<T extends Record<string, Schema>> =
  { [Key in Exclude<keyof T, OptionalKeys<T>>]: InferSchema<T[Key]> } &
  { [Key in OptionalKeys<T>]?: InferSchema<T[Key]> };

type UnionOf<T extends readonly Schema[]> = InferSchema<T[number]>;
type IntersectionOf<T extends readonly Schema[]> =
  T extends readonly [infer Head extends Schema, ...infer Rest extends readonly Schema[]]
    ? InferSchema<Head> & IntersectionOf<Rest>
    : unknown;

function object<T extends Record<string, Schema>>(
  properties: T,
  options: ObjectOptions = {},
): Schema<ObjectValue<T>> {
  const required = Object.entries(properties)
    .filter(([, value]) => !optionalSchemas.has(value))
    .map(([name]) => name);
  const normalized = Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [name, value.value]),
  );
  const additional = options.additionalProperties;
  const { additionalProperties: _ignored, ...rest } = options;
  return make({
    ...common("object", rest),
    properties: normalized,
    ...(required.length ? { required } : {}),
    ...(additional === undefined
      ? { additionalProperties: false }
      : { additionalProperties: typeof additional === "boolean" ? additional : additional.value }),
  });
}

export const schema = Object.freeze({
  string: (options: StringOptions = {}) => make<string>(common("string", options)),
  uuid: (options: StringOptions = {}) => stringFormat("uuid", options),
  email: (options: StringOptions = {}) => stringFormat("email", options),
  uri: (options: StringOptions = {}) => stringFormat("uri", options),
  date: (options: StringOptions = {}) => stringFormat("date", options),
  dateTime: (options: StringOptions = {}) => stringFormat("date-time", options),
  byte: (options: StringOptions = {}) => stringFormat("byte", options),
  binary: (options: StringOptions = {}) => stringFormat("binary", options),
  number: (options: NumberOptions = {}) => make<number>(common("number", options)),
  integer: (options: NumberOptions = {}) => make<number>(common("integer", options)),
  boolean: (options: CommonOptions = {}) => make<boolean>(common("boolean", options)),
  null: (options: CommonOptions = {}) => make<null>(common("null", options)),
  object,
  array: <T>(items: Schema<T>, options: ArrayOptions = {}) =>
    make<T[]>({ ...common("array", options), items: items.value }),
  record: <T>(values: Schema<T>, options: CommonOptions = {}) =>
    make<Record<string, T>>({ ...common("object", options), additionalProperties: values.value }),
  enum: <const T extends readonly (string | number | boolean)[]>(values: T, options: CommonOptions = {}) =>
    make<T[number]>({ ...options, enum: [...values] }),
  literal: <const T extends string | number | boolean | null>(value: T, options: CommonOptions = {}) =>
    make<T>({ ...options, const: value }),
  optional: <T>(value: Schema<T>): OptionalSchema<T> =>
    make<T>(value.value, true) as OptionalSchema<T>,
  nullable: <T>(value: Schema<T>) => make<T | null>({ anyOf: [value.value, { type: "null" }] }),
  oneOf: <const T extends readonly Schema[]>(...values: T) =>
    make<UnionOf<T>>({ oneOf: values.map((value) => value.value) }),
  anyOf: <const T extends readonly Schema[]>(...values: T) =>
    make<UnionOf<T>>({ anyOf: values.map((value) => value.value) }),
  allOf: <const T extends readonly Schema[]>(...values: T) =>
    make<IntersectionOf<T>>({ allOf: values.map((value) => value.value) }),
  raw: <T = unknown>(value: JsonSchema) => make<T>({ ...value }),
  ref: <T = unknown>(name: string) => make<T>({ $ref: `#/components/schemas/${name}` }),
});
