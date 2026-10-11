import { describe, expect, it } from "vite-plus/test";
import { providerErrorResponse } from "../src/auth/provider-errors";

const providers = [
  {
    id: "google",
    identityScopes: ["openid"],
    capabilities: {
      resources: [{ resource: "calendar", scopes: ["read", "write"] }],
    },
  },
];
const failure = (fields: object) =>
  Object.assign(new Error("SECRET_UPSTREAM_BODY"), fields, {
    cause: "SECRET_TOKEN",
    upstreamBody: "SECRET_CLIENT_SECRET",
  });

describe("provider problem responses", () => {
  it("serializes only a configured interaction target and canonical scopes", async () => {
    const response = providerErrorResponse(
      failure({
        code: "interaction-required",
        reason: "consent",
        provider: "google",
        resource: "calendar",
        scopes: ["write", "read", "read"],
      }),
      providers,
    )!;
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      code: "interaction-required",
      reason: "consent",
      provider: "google",
      resource: "calendar",
      scopes: ["read", "write"],
    });
    expect(body).not.toMatch(/SECRET|cause|upstream/);
  });

  it.each([
    { provider: "unknown", resource: "calendar", scopes: ["read"] },
    { provider: "google", resource: "SECRET_RESOURCE", scopes: ["read"] },
    { provider: "google", resource: "calendar", scopes: ["SECRET_SCOPE"] },
    { provider: "google", scopes: ["read"] },
  ])("fails safely for an interaction outside configured provider policy: %j", async (fields) => {
    const response = providerErrorResponse(
      failure({ code: "interaction-required", reason: "consent", ...fields }),
      providers,
    )!;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/SECRET|unknown|calendar|read/);
  });

  it.each([
    ["invalid-callback", 400],
    ["invalid-transaction", 400],
    ["configuration", 500],
    ["session-oversize", 500],
    ["capacity", 503],
    ["store-unavailable", 503],
    ["provider-unavailable", 503],
    ["closed", 503],
  ])(
    "keeps %s distinct from interaction and suppresses provider messages",
    async (code, status) => {
      const response = providerErrorResponse(failure({ code }), providers)!;
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ code });
      expect(body).not.toMatch(/SECRET|interaction-required/);
    },
  );

  it("leaves unrelated application errors to the application's error handler", () => {
    expect(providerErrorResponse(new Error("application"), providers)).toBeUndefined();
    expect(providerErrorResponse(null, providers)).toBeUndefined();
  });
});
