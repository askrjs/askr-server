import type { Middleware } from "../contracts";
import { readRequestFormData } from "../body-limit";

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

export async function createCsrfToken(secret: string, sessionId: string): Promise<string> {
  return signature(secret, sessionId);
}

export function csrf(options: CsrfOptions): Middleware {
  if (!options.secret) throw new Error("csrf requires a non-empty secret.");
  const header = options.header ?? "x-askr-csrf-token";
  const field = options.formField ?? "_csrf";
  return async (context, next) => {
    if (["GET", "HEAD", "OPTIONS", "TRACE"].includes(context.request.method)) return next();
    const session = options.sessionId?.(context) ?? context.auth.session?.id;
    if (!session) return context.forbidden("A session is required for this request.");
    let supplied = context.headers.get(header);
    if (
      !supplied &&
      /^(?:application\/x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(
        context.request.headers.get("content-type") ?? "",
      )
    ) {
      const values = await readRequestFormData(context.request);
      const value = values.get(field);
      supplied = typeof value === "string" ? value : null;
    }
    if (!supplied || !(await verifyCsrfToken(options.secret, session, supplied))) {
      return context.forbidden("CSRF token validation failed.");
    }
    return next();
  };
}
