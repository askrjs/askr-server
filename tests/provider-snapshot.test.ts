import type { AuthContext } from "@askrjs/auth";
import { describe, expect, it } from "vite-plus/test";
import { providerSnapshot } from "../src/auth/provider-snapshot";

describe("provider identity snapshot", () => {
  it("constructs the same minimal identity for session JSON and SSR hydration", () => {
    const auth: AuthContext = {
      authenticated: true,
      principal: {
        id: "https://issuer.test|account",
        subject: "account",
        email: "private@example.test",
        roles: ["administrator"],
        permissions: ["delete"],
        access_token: "ACCESS_TOKEN_CANARY",
      },
      session: { id: "SESSION_CANARY", subject: "account", expiresAt: 1234 },
      tenant: "tenant",
      scopes: ["profile", "openid", "profile"],
    };
    Object.defineProperty(auth, "token", { value: () => "TOKEN_FUNCTION_CANARY" });
    const snapshot = providerSnapshot(auth);
    expect(snapshot).toEqual({
      authenticated: true,
      principal: { id: "https://issuer.test|account", subject: "account" },
      tenant: "tenant",
      scopes: ["openid", "profile"],
    });
    expect(snapshot.principal).not.toBe(auth.principal);
    expect(snapshot.scopes).not.toBe(auth.scopes);
    expect(JSON.stringify(snapshot)).not.toMatch(/CANARY|administrator|private@|delete/);
    expect(auth.scopes).toEqual(["profile", "openid", "profile"]);
  });

  it("does not carry identity or policy fields from an anonymous context", () => {
    expect(
      providerSnapshot({
        authenticated: false,
        principal: { id: "stale" },
        session: null,
        tenant: "stale tenant",
        scopes: ["stale.scope"],
      }),
    ).toEqual({ authenticated: false, principal: null, tenant: null, scopes: [] });
  });

  it("treats a missing principal as anonymous and omits an absent subject", () => {
    const context: AuthContext = {
      authenticated: true,
      principal: null,
      session: null,
      tenant: null,
    };
    expect(providerSnapshot(context)).toEqual({
      authenticated: false,
      principal: null,
      tenant: null,
      scopes: [],
    });
    expect(providerSnapshot({ ...context, principal: { id: "account" } })).toEqual({
      authenticated: true,
      principal: { id: "account" },
      tenant: null,
      scopes: [],
    });
  });
});
