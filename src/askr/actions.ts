import type { AuthContext } from "@askrjs/auth";
import type { ActionDescriptor } from "@askrjs/askr/actions";
import type { RoutePolicy } from "@askrjs/askr/router";
import type { Issue } from "@askrjs/schema";
import type { Params, ServerContext } from "../contracts";
import { createCsrfToken } from "../middleware/csrf";
import {
  authorizedAction,
  csrfFailure,
  handlerContext,
  invalidAction,
  negotiateActionOutcome,
  type RegisteredAction,
  type Submission,
} from "./action-stages";

export interface ActionOutcome<Result = unknown> {
  readonly redirect?: string;
  readonly result?: Result;
}

export interface ActionHandlerContext {
  readonly request: Request;
  readonly url: URL;
  readonly params: Params;
  readonly auth: AuthContext;
  readonly policies: readonly RoutePolicy[];
  readonly signal: AbortSignal;
}

export type ActionHandler<
  Dependencies,
  Input extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
> = (
  context: ActionHandlerContext,
  input: Input,
  dependencies: Dependencies,
) => ActionOutcome<Result> | Promise<ActionOutcome<Result>>;

export interface ActionRegistryOptions {
  /** Page actions are protected by default. Set false only for an intentional non-session flow. */
  readonly csrf?:
    | false
    | {
        readonly secret?: string;
        readonly sessionId?: (context: ServerContext) => string | undefined;
        readonly header?: string;
        readonly formField?: string;
      };
  readonly randomSecret?: () => string;
}

export interface ActionExecutionOptions {
  readonly authorized: readonly ActionDescriptor[];
  readonly params: Params;
  readonly policies: readonly RoutePolicy[];
  readonly allowsRedirect: (location: URL) => boolean;
}

export type ActionExecution =
  | { readonly kind: "response"; readonly response: Response }
  | {
      readonly kind: "invalid";
      readonly action: string;
      readonly values: Readonly<Record<string, unknown>>;
      readonly issues: readonly Issue[];
      readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
    };

export interface ActionRegistry<Dependencies> {
  readonly entries: readonly ActionEntry<Dependencies>[];
  csrfToken(context: ServerContext): Promise<string | undefined>;
  execute(
    context: ServerContext,
    options: ActionExecutionOptions,
  ): Promise<ActionExecution | undefined>;
}

export interface ActionEntry<
  Dependencies,
  Input extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
> {
  readonly descriptor: ActionDescriptor<Input>;
  readonly handler: ActionHandler<Dependencies, Input, Result>;
}

export interface ServerActionsOptions<Dependencies> extends ActionRegistryOptions {
  readonly dependencies: Dependencies;
}

export function handleAction<Dependencies, Input extends Record<string, unknown>, Result = unknown>(
  descriptor: ActionDescriptor<Input>,
  handler: ActionHandler<Dependencies, Input, Result>,
): ActionEntry<Dependencies, Input, Result> {
  return Object.freeze({ descriptor, handler });
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

function requestAcceptsEnvelope(context: ServerContext): boolean {
  return (
    context.headers
      .get("accept")
      ?.split(",")
      .some((value) => value.trim().toLowerCase().startsWith("application/vnd.askr.action+json")) ??
    false
  );
}

function appendValue(output: Record<string, unknown>, key: string, value: unknown): void {
  if (!Object.hasOwn(output, key)) {
    output[key] = value;
    return;
  }
  const previous = output[key];
  output[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
}

async function readSubmission(
  context: ServerContext,
  csrfHeader: string,
  csrfField: string,
): Promise<
  | {
      readonly success: true;
      readonly id?: string;
      readonly csrf?: string;
      readonly values: Record<string, unknown>;
    }
  | { readonly success: false; readonly response: Response }
> {
  const type = context.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const idHeader = context.headers.get("x-askr-action") ?? undefined;
  const csrfHeaderValue = context.headers.get(csrfHeader) ?? undefined;
  try {
    if (type === "application/json" || type?.endsWith("+json")) {
      const source = await context.request.clone().text();
      if (!source.trim())
        return {
          success: false,
          response: context.badRequest("Action request contains empty JSON."),
        };
      const value = JSON.parse(source) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
          success: false,
          response: context.badRequest("Action request body must be an object."),
        };
      }
      return {
        success: true,
        id: idHeader,
        csrf: csrfHeaderValue,
        values: value as Record<string, unknown>,
      };
    }
    if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") {
      const values: Record<string, unknown> = {};
      for (const [key, value] of (await context.request.clone().formData()).entries()) {
        appendValue(values, key, value);
      }
      const id =
        idHeader ?? (typeof values._askr_action === "string" ? values._askr_action : undefined);
      const token =
        csrfHeaderValue ?? (typeof values[csrfField] === "string" ? values[csrfField] : undefined);
      delete values._askr_action;
      delete values[csrfField];
      return { success: true, id, csrf: token, values };
    }
    return {
      success: false,
      response: context.badRequest("Action request has an unsupported content type."),
    };
  } catch {
    return {
      success: false,
      response: context.badRequest("Action request body could not be read."),
    };
  }
}

export function defineServerActions<Dependencies>(
  options: ServerActionsOptions<Dependencies>,
  ...entries: readonly ActionEntry<Dependencies, any, any>[]
): ActionRegistry<Dependencies> {
  const { dependencies } = options;
  const csrf =
    options.csrf === false
      ? false
      : {
          secret: options.csrf?.secret ?? (options.randomSecret ?? randomSecret)(),
          sessionId:
            options.csrf?.sessionId ?? ((context: ServerContext) => context.auth.session?.id),
          header: options.csrf?.header ?? "x-askr-csrf-token",
          formField: options.csrf?.formField ?? "_csrf",
        };
  const handlers = new Map<string, RegisteredAction<Dependencies>>();
  for (const entry of entries) {
    if (handlers.has(entry.descriptor.id))
      throw new Error(`Duplicate action ${entry.descriptor.id}.`);
    handlers.set(entry.descriptor.id, entry as RegisteredAction<Dependencies>);
  }

  const registry: ActionRegistry<Dependencies> = {
    entries: Object.freeze([...entries]) as readonly ActionEntry<Dependencies>[],
    async csrfToken(context) {
      if (!csrf) return undefined;
      const session = csrf.sessionId(context);
      return session ? createCsrfToken(csrf.secret, session) : undefined;
    },
    async execute(context, executionOptions) {
      const submission = await readSubmission(
        context,
        csrf ? csrf.header : "x-askr-csrf-token",
        csrf ? csrf.formField : "_csrf",
      );
      if (!submission.success) return { kind: "response", response: submission.response };
      if (!submission.id) return undefined;
      const normalizedSubmission: Submission = { ...submission, id: submission.id };
      const enhanced = requestAcceptsEnvelope(context);
      const entry = authorizedAction(handlers, executionOptions.authorized, submission.id);
      if (!entry) return { kind: "response", response: context.notFound() };
      const requestId =
        typeof context.state.requestId === "string" ? context.state.requestId : undefined;
      const traceId =
        typeof context.state.traceId === "string"
          ? context.state.traceId
          : context.telemetry?.traceId();
      const fields = {
        requestId,
        traceId,
        route: context.url.pathname,
        action: entry.descriptor.id,
      };
      const run = async (): Promise<ActionExecution> => {
        const csrfResponse = await csrfFailure(context, csrf, normalizedSubmission.csrf);
        if (csrfResponse) return { kind: "response", response: csrfResponse };
        const input = entry.descriptor.input.safeParse(normalizedSubmission.values);
        if (!input.success) {
          const invalid = invalidAction(normalizedSubmission, input.issues);
          if (!enhanced) return invalid;
          return {
            kind: "response",
            response: context.json({ version: 1, ok: false, ...invalid }, { status: 422 }),
          };
        }
        const outcome = await entry.handler(
          handlerContext(context, executionOptions),
          input.data,
          dependencies,
        );
        return negotiateActionOutcome(
          context,
          executionOptions,
          entry.descriptor,
          outcome,
          enhanced,
        );
      };
      let result: ActionExecution | undefined;
      if (context.telemetry) {
        await context.telemetry.action(fields, async () => {
          result = await run();
          return result.kind === "response" ? result.response : new Response(null, { status: 422 });
        });
      } else {
        result = await run();
      }
      if (!result) throw new Error("Action execution did not produce a result.");
      return result;
    },
  };
  return Object.freeze(registry);
}
