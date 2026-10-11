import { problem } from "../http/responses";

interface ProviderPolicy {
  readonly id: string;
  readonly identityScopes: readonly string[];
  readonly capabilities: {
    readonly resources: readonly {
      readonly resource: string;
      readonly scopes: readonly string[];
    }[];
  };
}

const failures = {
  "invalid-callback": [400, "The provider callback is invalid. Start sign-in again."],
  "invalid-transaction": [400, "The sign-in transaction is invalid. Start sign-in again."],
  configuration: [500, "Provider session configuration requires correction."],
  "session-oversize": [500, "Configure a provider session store for this session size."],
  capacity: [503, "Provider session capacity is unavailable."],
  "store-unavailable": [503, "The provider session store is unavailable."],
  "provider-unavailable": [503, "The identity provider is unavailable."],
  closed: [503, "The provider session service is closed."],
} as const;

function response(status: number, detail: string, extensions?: Record<string, unknown>): Response {
  return problem(status, detail, {
    init: { headers: { "cache-control": "no-store" } },
    extensions,
  });
}

/** Map only known safe categories and configured interaction targets, never error text. */
export function providerErrorResponse(
  error: unknown,
  providers: readonly ProviderPolicy[],
): Response | undefined {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return;
  const code = error.code;
  if (code === "interaction-required") {
    const details = error as Error & {
      reason?: unknown;
      provider?: unknown;
      resource?: unknown;
      scopes?: unknown;
    };
    const provider = providers.find((candidate) => candidate.id === details.provider);
    const allowed =
      details.resource === undefined
        ? provider?.identityScopes
        : provider?.capabilities.resources.find((item) => item.resource === details.resource)
            ?.scopes;
    if (
      !provider ||
      !allowed ||
      (details.reason !== "login" && details.reason !== "consent") ||
      !Array.isArray(details.scopes) ||
      details.scopes.length > 128 ||
      !details.scopes.every((scope) => typeof scope === "string" && allowed.includes(scope))
    ) {
      return response(500, "The provider interaction response is invalid.");
    }
    return response(401, "Provider sign-in or consent is required.", {
      code,
      reason: details.reason,
      provider: provider.id,
      ...(details.resource === undefined ? {} : { resource: details.resource }),
      scopes: [...new Set(details.scopes as string[])].sort(),
    });
  }
  if (!Object.hasOwn(failures, code)) return;
  const [status, detail] = failures[code as keyof typeof failures];
  return response(status, detail, { code });
}
