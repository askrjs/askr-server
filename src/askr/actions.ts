import type { ActionDescriptor } from "@askrjs/askr/actions";
import type { ServerContext } from "../contracts";
import { createCsrfToken } from "../middleware/csrf";
import { readRequestFormData, readRequestText } from "../body-limit";
import { contentType, explicitlyAccepts } from "../http/media-types";
import {
  authorizedAction,
  csrfFailure,
  handlerContext,
  invalidAction,
  negotiateActionOutcome,
  type RegisteredAction,
  type Submission,
} from "./action-stages";
import type {
  ActionEntry,
  ActionExecution,
  ActionHandler,
  ActionRegistration,
  ActionRegistry,
  ServerActionsOptions,
} from "./action-types";

export type {
  ActionCookieInstruction,
  ActionEntry,
  ActionExecution,
  ActionExecutionOptions,
  ActionHandler,
  ActionHandlerContext,
  ActionOutcome,
  ActionRegistration,
  ActionRegistry,
  ActionRegistryOptions,
  ServerActionsOptions,
} from "./action-types";

/**
 * Pairs an action descriptor (its ID and input schema) with a typed handler, ready to pass to
 * {@link defineServerActions}.
 */
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
  const value = context.headers.get("accept");
  return value !== null && explicitlyAccepts(value, "application/vnd.askr.action+json");
}

function appendValue(output: Record<string, unknown>, key: string, value: unknown): void {
  if (!Object.hasOwn(output, key)) {
    output[key] = value;
    return;
  }
  const previous = output[key];
  if (Array.isArray(previous)) previous.push(value);
  else output[key] = [previous, value];
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
  const type = contentType(context.headers.get("content-type"));
  const idHeader = context.headers.get("x-askr-action") ?? undefined;
  const csrfHeaderValue = context.headers.get(csrfHeader) ?? undefined;
  try {
    if (type === "application/json" || type?.endsWith("+json")) {
      const source = await readRequestText(context.request);
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
      for (const [key, value] of (await readRequestFormData(context.request)).entries()) {
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
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 413)
      throw error;
    return {
      success: false,
      response: context.badRequest("Action request body could not be read."),
    };
  }
}

/**
 * Builds an {@link ActionRegistry} from a set of {@link ActionEntry}s (via {@link handleAction}),
 * wiring up CSRF token issuance/verification (unless `options.csrf` is `false`), submission
 * parsing (JSON or form-encoded), input validation, telemetry, and response negotiation
 * (redirect vs. JSON envelope) for each action invocation.
 *
 * @param options - Dependencies to inject into handlers, plus CSRF configuration.
 * @param entries - The registered actions.
 * @throws {Error} If two entries share the same action ID.
 */
export function defineServerActions<Dependencies>(
  options: ServerActionsOptions<Dependencies>,
  ...entries: readonly ActionRegistration<Dependencies>[]
): ActionRegistry {
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
    handlers.set(entry.descriptor.id, entry as unknown as RegisteredAction<Dependencies>);
  }

  const registry: ActionRegistry = {
    entries: Object.freeze([...entries]),
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
