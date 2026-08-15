import type { AuthContext } from "@askrjs/auth";
import type { ActionDescriptor } from "@askrjs/askr/actions";
import type { RoutePolicy } from "@askrjs/askr/router";
import type { Issue } from "@askrjs/schema";
import type { CookieOptions, Params, ServerContext } from "../contracts";
import type { ActionRegistryOptions } from "./action-options";

export type { ActionRegistryOptions } from "./action-options";

/** A cookie to set or clear as part of an {@link ActionOutcome}. */
export type ActionCookieInstruction =
  | {
      readonly name: string;
      readonly value: string;
      readonly clear?: false;
      readonly options?: CookieOptions;
    }
  | {
      readonly name: string;
      readonly clear: true;
      readonly value?: never;
      readonly options?: CookieOptions;
    };

/** The result of a successful {@link ActionHandler} invocation: an optional redirect, result payload, and cookies. */
export interface ActionOutcome<Result = unknown> {
  readonly redirect?: string;
  readonly result?: Result;
  readonly cookies?: readonly ActionCookieInstruction[];
}

/** Request-derived context passed to an {@link ActionHandler}. */
export interface ActionHandlerContext {
  readonly request: Request;
  readonly url: URL;
  readonly params: Params;
  readonly auth: AuthContext;
  readonly policies: readonly RoutePolicy[];
  readonly signal: AbortSignal;
}

/** A server action's business logic: validated `input` in, an {@link ActionOutcome} out. */
export type ActionHandler<
  Dependencies,
  Input extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
> = (
  context: ActionHandlerContext,
  input: Input,
  dependencies: Dependencies,
) => ActionOutcome<Result> | Promise<ActionOutcome<Result>>;

/** Options passed to {@link ActionRegistry.execute} describing the current page's allowed actions. */
export interface ActionExecutionOptions {
  readonly authorized: readonly ActionDescriptor[];
  readonly params: Params;
  readonly policies: readonly RoutePolicy[];
  readonly allowsRedirect: (location: URL) => boolean;
}

/** Result of {@link ActionRegistry.execute}: either a final response, or invalid-input details to re-render the page with. */
export type ActionExecution =
  | { readonly kind: "response"; readonly response: Response }
  | {
      readonly kind: "invalid";
      readonly action: string;
      readonly values: Readonly<Record<string, unknown>>;
      readonly issues: readonly Issue[];
      readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
    };

/** A registry of server actions, as created by {@link defineServerActions}, used by {@link createAskrPageHandler}. */
export interface ActionRegistry {
  readonly entries: readonly Readonly<{ descriptor: ActionDescriptor }>[];
  csrfToken(context: ServerContext): Promise<string | undefined>;
  execute(
    context: ServerContext,
    options: ActionExecutionOptions,
  ): Promise<ActionExecution | undefined>;
}

/** A registered action: its descriptor (schema/id) paired with its handler, as produced by {@link handleAction}. */
export interface ActionEntry<
  Dependencies,
  Input extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
> {
  readonly descriptor: ActionDescriptor<Input>;
  readonly handler: ActionHandler<Dependencies, Input, Result>;
}

/** A type-erased {@link ActionEntry}, as accepted by {@link defineServerActions}. */
export interface ActionRegistration<Dependencies> {
  readonly descriptor: ActionDescriptor;
  readonly handler: (
    context: ActionHandlerContext,
    input: never,
    dependencies: Dependencies,
  ) => ActionOutcome<unknown> | Promise<ActionOutcome<unknown>>;
}

/** Options for {@link defineServerActions}. */
export interface ServerActionsOptions<Dependencies> extends ActionRegistryOptions {
  readonly dependencies: Dependencies;
}
