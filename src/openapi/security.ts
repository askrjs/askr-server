import type { SecurityRequirement, SecurityScheme } from "./types";

export const security = Object.freeze({
  httpBearer(options: { bearerFormat?: string; description?: string } = {}): SecurityScheme {
    return { type: "http", scheme: "bearer", ...options };
  },
  httpBasic(options: { description?: string } = {}): SecurityScheme {
    return { type: "http", scheme: "basic", ...options };
  },
  apiKey(
    name: string,
    location: "header" | "query" | "cookie" = "header",
    options: { description?: string } = {},
  ): SecurityScheme {
    return { type: "apiKey", name, in: location, ...options };
  },
  oauth2(flows: Record<string, unknown>, description?: string): SecurityScheme {
    return { type: "oauth2", flows, ...(description ? { description } : {}) };
  },
  openIdConnect(openIdConnectUrl: string, description?: string): SecurityScheme {
    return { type: "openIdConnect", openIdConnectUrl, ...(description ? { description } : {}) };
  },
  require(name: string, scopes: readonly string[] = []): SecurityRequirement {
    return [{ [name]: [...scopes] }];
  },
  any(...requirements: readonly SecurityRequirement[]): SecurityRequirement {
    return requirements.flat();
  },
  none(): SecurityRequirement {
    return [];
  },
});
