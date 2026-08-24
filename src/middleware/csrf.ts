import type { Middleware } from "../contracts";
import { readRequestFormData } from "../body-limit";

/** Options for {@link csrf}. */
export interface CsrfOptions {
  readonly secret: string;
  readonly sessionId?: (context: Parameters<Middleware>[0]) => string | undefined;
  readonly header?: string;
  readonly formField?: string;
}

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signature(secret: string, session: string): Promise<string> {
  const key = await hmacKey(secret);
  return encode(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(session))),
  );
}

/**
 * Verifies a CSRF token against a session ID using an HMAC-SHA256 signature.
 *
 * @param secret - The HMAC secret used to sign tokens.
 * @param sessionId - The session ID the token should be bound to.
 * @param token - The base64url-encoded token to verify.
 * @returns `true` if the token is a valid signature of `sessionId` under `secret`.
 */
export async function verifyCsrfToken(
  secret: string,
  sessionId: string,
  token: string,
): Promise<boolean> {
  const bytes = decode(token);
  return (
    bytes !== undefined &&
    crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, new TextEncoder().encode(sessionId))
  );
}

/**
 * Creates a CSRF token bound to a session ID, as an HMAC-SHA256 signature encoded base64url.
 *
 * @param secret - The HMAC secret; must match what {@link verifyCsrfToken} uses.
 * @param sessionId - The session ID to bind the token to.
 */
export async function createCsrfToken(secret: string, sessionId: string): Promise<string> {
  return signature(secret, sessionId);
}

type CsrfValidationOptions = {
  readonly secret: string;
  readonly sessionId: (context: Parameters<Middleware>[0]) => string | undefined;
  readonly token: (
    context: Parameters<Middleware>[0],
  ) => string | undefined | Promise<string | undefined>;
  readonly missingSessionMessage: string;
};

export async function csrfValidationFailure(
  context: Parameters<Middleware>[0],
  options: CsrfValidationOptions,
): Promise<Response | undefined> {
  const session = options.sessionId(context);
  if (!session) return context.forbidden(options.missingSessionMessage);
  const token = await options.token(context);
  if (!token || !(await verifyCsrfToken(options.secret, session, token)))
    return context.forbidden("CSRF token validation failed.");
  return undefined;
}

/**
 * Creates middleware that enforces CSRF protection on state-changing requests (all methods
 * except `GET`/`HEAD`/`OPTIONS`/`TRACE`) by requiring a valid token bound to the current
 * session, supplied via a request header or (for form-encoded bodies) a form field.
 *
 * @param options - HMAC secret, session ID resolver, and header/form field names.
 * @throws {Error} If `options.secret` is empty.
 */
export function csrf(options: CsrfOptions): Middleware {
  if (!options.secret) throw new Error("csrf requires a non-empty secret.");
  const header = options.header ?? "x-askr-csrf-token";
  const field = options.formField ?? "_csrf";
  return async (context, next) => {
    if (["GET", "HEAD", "OPTIONS", "TRACE"].includes(context.request.method)) return next();
    const failure = await csrfValidationFailure(context, {
      secret: options.secret,
      sessionId: (value) => options.sessionId?.(value) ?? value.auth.session?.id,
      missingSessionMessage: "A session is required for this request.",
      token: async (value) => {
        const supplied = value.headers.get(header);
        if (supplied) return supplied;
        if (
          !/^(?:application\/x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(
            value.request.headers.get("content-type") ?? "",
          )
        )
          return undefined;
        const values = await readRequestFormData(value.request);
        const token = values.get(field);
        return typeof token === "string" ? token : undefined;
      },
    });
    if (failure) return failure;
    return next();
  };
}
