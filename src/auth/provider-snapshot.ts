import type { AuthContext } from "@askrjs/auth";

/** The one identity-only projection used by provider session JSON and SSR. */
export function providerSnapshot(auth: AuthContext) {
  if (!auth.authenticated || !auth.principal) {
    return { authenticated: false, principal: null, tenant: null, scopes: [] as string[] };
  }
  return {
    authenticated: true,
    principal: {
      id: auth.principal.id,
      ...(auth.principal.subject === undefined ? {} : { subject: auth.principal.subject }),
    },
    tenant: auth.tenant,
    scopes: [...new Set(auth.scopes ?? [])].sort(),
  };
}
