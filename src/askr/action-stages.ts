import type { ActionDescriptor } from "@askrjs/askr/actions";
import type { Issue } from "@askrjs/schema";
import type { ServerContext } from "../contracts";
import { verifyCsrfToken } from "../middleware/csrf";
import type {
  ActionExecution,
  ActionExecutionOptions,
  ActionHandler,
  ActionHandlerContext,
  ActionOutcome,
} from "./actions";

export type Submission = {
  readonly id: string;
  readonly csrf?: string;
  readonly values: Record<string, unknown>;
};

export type CsrfConfiguration =
  | false
  | {
      readonly secret: string;
      readonly sessionId: (context: ServerContext) => string | undefined;
      readonly header: string;
      readonly formField: string;
    };

export type RegisteredAction<Dependencies> = {
  readonly descriptor: ActionDescriptor;
  readonly handler: ActionHandler<Dependencies>;
};

function errorsByField(issues: readonly Issue[]): Readonly<Record<string, readonly string[]>> {
  const output: Record<string, string[]> = {};
  for (const issue of issues) {
    const field = issue.path.join(".") || "_form";
    (output[field] ??= []).push(issue.message);
  }
  return Object.freeze(
    Object.fromEntries(Object.entries(output).map(([key, value]) => [key, Object.freeze(value)])),
  );
}

export function authorizedAction<Dependencies>(
  handlers: ReadonlyMap<string, RegisteredAction<Dependencies>>,
  authorized: readonly ActionDescriptor[],
  id: string,
): RegisteredAction<Dependencies> | undefined {
  if (!authorized.some((descriptor) => descriptor.id === id)) return undefined;
  return handlers.get(id);
}

export async function csrfFailure(
  context: ServerContext,
  csrf: CsrfConfiguration,
  token: string | undefined,
): Promise<Response | undefined> {
  if (!csrf) return undefined;
  const session = csrf.sessionId(context);
  if (!session) return context.forbidden("A session is required for this action.");
  if (!token || !(await verifyCsrfToken(csrf.secret, session, token))) {
    return context.forbidden("CSRF token validation failed.");
  }
  return undefined;
}

export function invalidAction(
  submission: Submission,
  issues: readonly Issue[],
): Extract<ActionExecution, { kind: "invalid" }> {
  return Object.freeze({
    kind: "invalid" as const,
    action: submission.id,
    values: Object.freeze({ ...submission.values }),
    issues,
    fieldErrors: errorsByField(issues),
  });
}

export function handlerContext(
  context: ServerContext,
  options: ActionExecutionOptions,
): ActionHandlerContext {
  return Object.freeze({
    request: context.request,
    url: context.url,
    params: options.params,
    auth: context.auth,
    policies: options.policies,
    signal: context.signal,
  });
}

export function negotiateActionOutcome(
  context: ServerContext,
  options: ActionExecutionOptions,
  descriptor: ActionDescriptor,
  outcome: ActionOutcome,
  enhanced: boolean,
): ActionExecution {
  const location = outcome.redirect
    ? new URL(outcome.redirect, context.url)
    : enhanced
      ? undefined
      : new URL(`${context.url.pathname}${context.url.search}`, context.url);
  if (
    location &&
    (location.origin !== context.url.origin || !options.allowsRedirect(location))
  ) {
    return {
      kind: "response",
      response: context.problem(500, "Action returned an invalid route redirect."),
    };
  }
  let response = enhanced
    ? context.json({
        version: 1,
        ok: true,
        result: outcome.result,
        invalidates: descriptor.invalidates,
        ...(location
          ? { redirect: `${location.pathname}${location.search}${location.hash}` }
          : {}),
      })
    : context.redirect(`${location!.pathname}${location!.search}${location!.hash}`, 303);
  for (const instruction of outcome.cookies ?? []) {
    response = instruction.clear
      ? context.clearCookie(response, instruction.name, instruction.options)
      : context.setCookie(response, instruction.name, instruction.value, instruction.options);
  }
  return { kind: "response", response };
}
