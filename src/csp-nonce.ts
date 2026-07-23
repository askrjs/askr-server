import type { ServerContext } from "./contracts";

export type CspNonceProvider = (context: ServerContext) => string;

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
