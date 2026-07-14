import type { JsonSchema, Schema } from "./types";

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

function make<T>(value: JsonSchema): Schema<T> {
  return Object.freeze({ value: Object.freeze(value) });
}

function common(type: string, options: CommonOptions = {}): JsonSchema {
  return { type, ...options };
}

function stringFormat(format: string, options: StringOptions = {}): Schema<string> {
  return make<string>({ type: "string", ...options, format });
}

function object<T extends Record<string, Schema>>(
  properties: T,
  options: ObjectOptions = {},
): Schema<{ [K in keyof T]: T[K] extends Schema<infer V> ? V : never }> {
  const required = Object.entries(properties)
    .filter(([, value]) => value.value["x-askr-optional"] !== true)
    .map(([name]) => name);
  const normalized = Object.fromEntries(
    Object.entries(properties).map(([name, value]) => {
      const { ["x-askr-optional"]: _optional, ...schemaValue } = value.value;
      return [name, schemaValue];
    }),
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
  optional: <T>(value: Schema<T>) => make<T | undefined>({ ...value.value, "x-askr-optional": true }),
  nullable: <T>(value: Schema<T>) => make<T | null>({ anyOf: [value.value, { type: "null" }] }),
  oneOf: <T>(...values: readonly Schema<T>[]) => make<T>({ oneOf: values.map((value) => value.value) }),
  anyOf: <T>(...values: readonly Schema<T>[]) => make<T>({ anyOf: values.map((value) => value.value) }),
  allOf: <T>(...values: readonly Schema[]) => make<T>({ allOf: values.map((value) => value.value) }),
  raw: <T = unknown>(value: JsonSchema) => make<T>({ ...value }),
  ref: <T = unknown>(name: string) => make<T>({ $ref: `#/components/schemas/${name}` }),
});
