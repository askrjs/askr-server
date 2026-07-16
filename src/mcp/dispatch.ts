import type { McpContext, McpRequestEnvironment } from "./types";
import {
  errorCode,
  failure,
  object,
  page,
  success,
  templateMatch,
  visible,
  type Prompt,
  type RecordValue,
  type Registries,
  type Resource,
  type Template,
  type Tool,
} from "./internal";

async function allowed<T extends { options: any }, Dependencies>(
  values: readonly T[],
  environment: McpRequestEnvironment<Dependencies>,
): Promise<T[]> {
  return (
    await Promise.all(
      values.map(async (value) => ((await visible(value, environment.auth)) ? value : undefined)),
    )
  ).filter(Boolean) as T[];
}

async function dispatchTool<Dependencies>(
  id: unknown,
  params: RecordValue,
  context: McpContext<Dependencies>,
  environment: McpRequestEnvironment<Dependencies>,
  tools: Map<string, Tool>,
) {
  const value = typeof params.name === "string" ? tools.get(params.name) : undefined;
  if (!value || !(await visible(value, environment.auth)))
    return failure(id, errorCode.params, "Tool not found");
  const parsed = value.input.safeParse(params.arguments ?? {});
  if (!parsed.success)
    return failure(id, errorCode.params, "Invalid tool arguments", { issues: parsed.issues });
  try {
    const result = await value.handler(context, parsed.data);
    if (value.output && result.structuredContent !== undefined) {
      const output = value.output.safeParse(result.structuredContent);
      if (!output.success)
        return failure(id, errorCode.internal, "Tool returned invalid structured content", {
          issues: output.issues,
        });
    }
    return success(id, {
      content: result.content ?? [],
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      ...(result.isError ? { isError: true } : {}),
    });
  } catch (error) {
    return success(id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed" }],
      isError: true,
    });
  }
}

async function dispatchResources<Dependencies>(
  id: unknown,
  method: string,
  params: RecordValue,
  context: McpContext<Dependencies>,
  environment: McpRequestEnvironment<Dependencies>,
  registries: Registries,
) {
  if (method === "resources/list") {
    const result = page(
      await allowed([...registries.resources.values()], environment),
      params.cursor,
      registries.pageSize,
    );
    return success(id, {
      resources: result.values.map((value) => ({
        uri: value.uri,
        name: value.options.name ?? value.uri,
        ...value.options,
      })),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    });
  }
  if (method === "resources/templates/list") {
    const result = page(
      await allowed(registries.templates, environment),
      params.cursor,
      registries.pageSize,
    );
    return success(id, {
      resourceTemplates: result.values.map((value) => ({
        uriTemplate: value.template,
        name: value.options.name ?? value.template,
        ...value.options,
        complete: undefined,
      })),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    });
  }
  if (typeof params.uri !== "string")
    return failure(id, errorCode.params, "Resource URI is required");
  const exact = registries.resources.get(params.uri);
  const matched = registries.templates
    .map((value) => ({ value, variables: templateMatch(value.template, params.uri as string) }))
    .find((value) => value.variables);
  const entry: Resource | Template | undefined = exact ?? matched?.value;
  if (!entry || !(await visible(entry, environment.auth)))
    return failure(id, errorCode.params, "Resource not found");
  const result = await entry.handler(context, new URL(params.uri), matched?.variables ?? {});
  return success(id, { contents: Array.isArray(result) ? result : [result] });
}

async function dispatchPrompts<Dependencies>(
  id: unknown,
  method: string,
  params: RecordValue,
  context: McpContext<Dependencies>,
  environment: McpRequestEnvironment<Dependencies>,
  prompts: Map<string, Prompt>,
  pageSize: number,
) {
  if (method === "prompts/list") {
    const result = page(await allowed([...prompts.values()], environment), params.cursor, pageSize);
    return success(id, {
      prompts: result.values.map((value) => ({
        name: value.name,
        ...value.options,
        arguments: Object.entries((value.arguments.jsonSchema.properties ?? {}) as RecordValue).map(
          ([name, definition]) => ({
            name,
            ...(object(definition) && typeof definition.description === "string"
              ? { description: definition.description }
              : {}),
            required:
              Array.isArray(value.arguments.jsonSchema.required) &&
              value.arguments.jsonSchema.required.includes(name),
          }),
        ),
      })),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    });
  }
  const value = typeof params.name === "string" ? prompts.get(params.name) : undefined;
  if (!value || !(await visible(value, environment.auth)))
    return failure(id, errorCode.params, "Prompt not found");
  const parsed = value.arguments.safeParse(params.arguments ?? {});
  return parsed.success
    ? success(id, await value.handler(context, parsed.data))
    : failure(id, errorCode.params, "Invalid prompt arguments", { issues: parsed.issues });
}

export async function dispatchMethod<Dependencies>(
  id: unknown,
  method: string,
  params: RecordValue,
  context: McpContext<Dependencies>,
  environment: McpRequestEnvironment<Dependencies>,
  registries: Registries,
): Promise<unknown> {
  if (method === "ping" || method === "logging/setLevel") return success(id, {});
  if (method === "tools/list") {
    const result = page(
      await allowed([...registries.tools.values()], environment),
      params.cursor,
      registries.pageSize,
    );
    return success(id, {
      tools: result.values.map((value) => ({
        name: value.name,
        ...value.options,
        inputSchema: value.input.jsonSchema,
        ...(value.output ? { outputSchema: value.output.jsonSchema } : {}),
      })),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    });
  }
  if (method === "tools/call")
    return dispatchTool(id, params, context, environment, registries.tools);
  if (method.startsWith("resources/"))
    return dispatchResources(id, method, params, context, environment, registries);
  if (method.startsWith("prompts/"))
    return dispatchPrompts(
      id,
      method,
      params,
      context,
      environment,
      registries.prompts,
      registries.pageSize,
    );
  if (method === "completion/complete") {
    const reference = object(params.ref) ? params.ref : {};
    const argument = object(params.argument) ? params.argument : {};
    const value =
      reference.type === "ref/resource" && typeof reference.uri === "string"
        ? registries.templates.find((item) => item.template === reference.uri)
        : undefined;
    const values =
      value?.options.complete &&
      typeof argument.name === "string" &&
      typeof argument.value === "string"
        ? await value.options.complete(argument.name, argument.value)
        : [];
    return success(id, {
      completion: {
        values: [...values].slice(0, 100),
        total: values.length,
        hasMore: values.length > 100,
      },
    });
  }
  return failure(id, errorCode.method, "Method not found");
}
