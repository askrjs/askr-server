import type { ServerContext } from "../contracts";

export interface ActionRegistryOptions {
  /**
   * Page actions are protected by session-bound CSRF by default.
   *
   * The default identity is `context.auth.session?.id`, so anonymous pages do
   * not receive a token and their submissions are rejected. Pre-authentication
   * forms such as login, signup, and password reset must establish an opaque
   * guest session before rendering and return its stable identity from
   * `sessionId`. The resolver identifies an existing session; it does not
   * create or persist one.
   *
   * Set this to `false` only when the complete flow intentionally uses another
   * CSRF defense.
   */
  readonly csrf?:
    | false
    | {
        /** HMAC secret. A process-local random secret is generated when omitted. */
        readonly secret?: string;
        /**
         * Resolves the authenticated or pre-authentication session identity
         * used to issue and verify tokens. Returning `undefined` means no token
         * is rendered and action submissions fail with `403`.
         */
        readonly sessionId?: (context: ServerContext) => string | undefined;
        /** Enhanced-submission token header. Defaults to `x-askr-csrf-token`. */
        readonly header?: string;
        /** Native-form token field. Defaults to `_csrf`. */
        readonly formField?: string;
      };
  readonly randomSecret?: () => string;
}
