import type { SecurityRequirement, SecurityScheme } from "./types";

/**
 * Helpers for building OpenAPI security schemes and requirements, used with
 * `ApiGroup.access`/`RouteBuilder.access` to describe an operation's authentication needs.
 */
export const security = Object.freeze({
  /** Builds an HTTP Bearer (`Authorization: Bearer ...`) security scheme. */
  httpBearer(options: { bearerFormat?: string; description?: string } = {}): SecurityScheme {
    return { type: "http", scheme: "bearer", ...options };
  },
  /** Builds an HTTP Basic security scheme. */
  httpBasic(options: { description?: string } = {}): SecurityScheme {
    return { type: "http", scheme: "basic", ...options };
  },
  /** Builds an API key security scheme, read from a header, query parameter, or cookie. */
  apiKey(
    name: string,
    location: "header" | "query" | "cookie" = "header",
    options: { description?: string } = {},
  ): SecurityScheme {
    return { type: "apiKey", name, in: location, ...options };
  },
  /** Builds an OAuth2 security scheme with the given flow definitions. */
  oauth2(flows: Record<string, unknown>, description?: string): SecurityScheme {
    return { type: "oauth2", flows, ...(description ? { description } : {}) };
  },
  /** Builds an OpenID Connect security scheme pointing at a discovery URL. */
  openIdConnect(openIdConnectUrl: string, description?: string): SecurityScheme {
    return { type: "openIdConnect", openIdConnectUrl, ...(description ? { description } : {}) };
  },
  /** Builds a security requirement referencing a named scheme, optionally with scopes. */
  require(name: string, scopes: readonly string[] = []): SecurityRequirement {
    return [{ [name]: [...scopes] }];
  },
  /** Combines multiple security requirements into an "any of" requirement. */
  any(...requirements: readonly SecurityRequirement[]): SecurityRequirement {
    return requirements.flat();
  },
  /** Builds an empty security requirement, indicating no authentication is required. */
  none(): SecurityRequirement {
    return [];
  },
});
