import type { ServerContext } from "./contracts";

/** A function that returns a CSP nonce for a given request context, stable across calls for the same context. */
export type CspNonceProvider = (context: ServerContext) => string;

/**
 * Creates a {@link CspNonceProvider} that lazily generates a cryptographically random,
 * URL-safe base64 nonce per {@link ServerContext} and caches it for the lifetime of that
 * context, so repeated calls within the same request return the same value.
 *
 * @returns A provider function `(context) => nonce`.
 */
export function createCspNonce(): CspNonceProvider {
  const values = new WeakMap<ServerContext, string>();
  return (context) => {
    let value = values.get(context);
    if (value === undefined) {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const generated = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      values.set(context, generated);
      value = generated;
    }
    return value;
  };
}
