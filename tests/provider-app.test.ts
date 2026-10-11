import { Buffer } from "node:buffer";
import { requireUser, type AuthContext } from "@askrjs/auth";
import { createOidcProvider } from "@askrjs/auth/server";
import { createRouteRegistry, currentAuth, route } from "@askrjs/askr/router";
import { describe, expect, it } from "vite-plus/test";
import { createAskrApp } from "../src/askr";
import type { ServerContext } from "../src/contracts";

const origin = "https://app.test";
const issuer = "https://issuer.test";
const clientSecret = "CLIENT_SECRET_CANARY";
const sessionSecret = Buffer.from(new Uint8Array(32).fill(42)).toString("base64url");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

// This HTTP simulation signs real JWTs and checks real PKCE. The cookie jar is a
// server integration harness; native cookie/SameSite proof belongs to Examples.
async function fixture(
  responseMode: "query" | "form_post" = "query",
  settings: {
    readonly close?: () => void | Promise<void>;
    readonly tokenInLoader?: boolean;
  } = {},
) {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "simulation",
    alg: "RS256",
    use: "sig",
  };
  const codes = new Map<string, { nonce: string; challenge: string; scopes: string }>();
  let clock = Date.now();
  let exchanges = 0;
  let renewals = 0;
  let identityFailure: "nonce" | "signature" | "expired" | undefined;
  const failures: unknown[] = [];
  const observed: Partial<Record<"policy" | "preload" | "loader" | "render", AuthContext>> = {};
  const providerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === `${issuer}/.well-known/openid-configuration`)
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.href === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    if (url.href !== `${issuer}/token`) throw new Error("Unexpected simulation endpoint");
    const fields = new URLSearchParams(await request.text());
    expect(fields.get("client_id")).toBe("client");
    expect(fields.get("client_secret")).toBe(clientSecret);
    if (fields.get("grant_type") === "refresh_token") {
      expect(fields.get("refresh_token")).toBe("REFRESH_TOKEN_CANARY");
      renewals += 1;
      return Response.json({
        token_type: "Bearer",
        access_token: "RENEWED_ACCESS_TOKEN_CANARY",
        expires_in: 300,
        refresh_token: "ROTATED_REFRESH_TOKEN_CANARY",
        scope: "openid profile read",
      });
    }
    expect(fields.get("grant_type")).toBe("authorization_code");
    const code = fields.get("code")!;
    const flow = codes.get(code);
    if (!flow)
      return Response.json(
        { error: "invalid_grant", error_description: "PRIVATE_UPSTREAM_CANARY" },
        { status: 400 },
      );
    codes.delete(code);
    exchanges += 1;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(fields.get("code_verifier")!),
    );
    expect(Buffer.from(digest).toString("base64url")).toBe(flow.challenge);
    expect(fields.get("redirect_uri")).toBe(`${origin}/auth/callback/test`);
    const seconds = Math.floor(clock / 1000);
    const unsigned = `${encode({ alg: "RS256", kid: "simulation" })}.${encode({
      iss: issuer,
      sub: "account",
      aud: "client",
      iat: seconds,
      exp: seconds + (identityFailure === "expired" ? -1 : 3600),
      nonce: identityFailure === "nonce" ? "WRONG_NONCE_CANARY" : flow.nonce,
      email: "private@example.test",
      access_token: "CLAIM_TOKEN_CANARY",
    })}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        new TextEncoder().encode(unsigned),
      ),
    );
    if (identityFailure === "signature") signature[0] ^= 1;
    return Response.json({
      token_type: "Bearer",
      access_token: "ACCESS_TOKEN_CANARY",
      expires_in: 300,
      refresh_token: "REFRESH_TOKEN_CANARY",
      scope: flow.scopes,
      id_token: `${unsigned}.${Buffer.from(signature).toString("base64url")}`,
    });
  };
  const definition = createOidcProvider({
    id: "test",
    issuer,
    clientId: "client",
    responseMode,
    clientAuthentication: { method: "client_secret_post", secret: clientSecret },
    identityScopes: ["openid", "profile"],
    capabilities: {
      renewal: "refresh",
      incrementalConsent: true,
      resources: [{ resource: "calendar", scopes: ["read"] }],
    },
  });
  const app = createAskrApp({
    name: "Signed simulated provider",
    version: "1",
    dependencies: {},
    pages: createRouteRegistry(() =>
      route(
        "/private",
        () => {
          observed.render = currentAuth();
          return "private page";
        },
        {
          auth: (context) => {
            observed.policy = context;
            return requireUser()(context);
          },
          preload: ({ auth }) => {
            observed.preload = auth;
          },
          loader: async ({ auth }) => {
            observed.loader = auth;
            if (settings.tokenInLoader)
              expect(
                await (auth as ServerContext["auth"]).token("test", {
                  resource: "calendar",
                  scopes: ["read"],
                }),
              ).toBe("ACCESS_TOKEN_CANARY");
            return null;
          },
        },
      ),
    ),
    auth: {
      origin,
      providers: [definition],
      session: { secrets: [sessionSecret] },
      fetch: providerFetch,
      clock: () => clock,
    },
    api: {
      define(api) {
        api
          .get("/token", async (context) => {
            const token = await context.auth.token("test", {
              resource: "calendar",
              scopes: ["read"],
            });
            expect(token).toBe("ACCESS_TOKEN_CANARY");
            return new Response(null, {
              status: 204,
              headers: { "set-cookie": "preferences=kept; Path=/" },
            });
          })
          .noContent();
        api
          .get("/failure", async (context) => {
            await context.auth.token("test", { resource: "calendar", scopes: ["read"] });
            throw new Error("APPLICATION_PRIVATE_CANARY");
          })
          .noContent();
      },
    },
    close: settings.close,
    onError: (error) => {
      failures.push(error);
      return new Response("Application error", {
        status: 500,
        headers: { "set-cookie": "preferences=kept; Path=/" },
      });
    },
  });
  const jar = new Map<string, string>();
  const makeRequest = (
    path: string,
    init: RequestInit = {},
    cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
  ) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    return new Request(new URL(path, origin), { ...init, headers });
  };
  const acceptCookies = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const position = pair.indexOf("=");
      const name = pair.slice(0, position),
        value = pair.slice(position + 1);
      if (/;\s*Max-Age=0(?:;|$)/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  };
  const login = async (query = "") => {
    const response = await app.fetch(makeRequest(`/auth/login/test${query}`));
    expect(response.status).toBe(303);
    acceptCookies(response);
    const authorization = new URL(response.headers.get("location")!);
    expect(authorization.origin).toBe(issuer);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const code = crypto.randomUUID();
    codes.set(code, {
      nonce: authorization.searchParams.get("nonce")!,
      challenge: authorization.searchParams.get("code_challenge")!,
      scopes: authorization.searchParams.get("scope")!,
    });
    return new URLSearchParams({ code, state: authorization.searchParams.get("state")! });
  };
  const callback = (fields: URLSearchParams, extra: RequestInit = {}, cookie?: string) =>
    responseMode === "query"
      ? makeRequest(`/auth/callback/test?${fields}`, extra, cookie)
      : makeRequest("/auth/callback/test", { method: "POST", body: fields, ...extra }, cookie);
  return {
    app,
    jar,
    login,
    callback,
    makeRequest,
    acceptCookies,
    exchanges: () => exchanges,
    renewals: () => renewals,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    observed,
    failures: () =>
      failures.map((error) => (error instanceof Error ? error.message : String(error))).join("\n"),
    failIdentity: (failure: typeof identityFailure) => {
      identityFailure = failure;
    },
  };
}

describe("provider createAskrApp signed HTTP integration", () => {
  it.each(["query", "form_post"] as const)(
    "runs %s login, session, SSR policy and local logout",
    async (mode) => {
      const test = await fixture(mode);
      try {
        const fields = await test.login(`?returnTo=${encodeURIComponent("/private?a=1#x")}`);
        const response = await test.app.fetch(test.callback(fields));
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(`${origin}/private?a=1#x`);
        test.acceptCookies(response);
        const session = await test.app.fetch(test.makeRequest("/auth/session"));
        expect(session.headers.get("cache-control")).toBe("no-store");
        const snapshot = await session.text();
        const identity = JSON.parse(snapshot);
        expect(identity).toMatchObject({
          authenticated: true,
          principal: { subject: "account" },
          scopes: ["openid", "profile"],
        });
        expect(snapshot).not.toMatch(/CANARY|private@example|session|roles|permissions/);
        const page = await test.app.fetch(test.makeRequest("/private"));
        expect(page.status, test.failures()).toBe(200);
        const html = await page.text();
        expect(html).not.toMatch(/CANARY|private@example/);
        const hydration = html.match(
          /<script\b[^>]*data-askr-render-data="true"[^>]*>([\s\S]*?)<\/script>/,
        );
        expect(hydration).not.toBeNull();
        expect(JSON.parse(hydration![1]).framework.au).toEqual(identity);
        const logout = await test.app.fetch(
          test.makeRequest("/auth/logout", { method: "POST", headers: { origin } }),
        );
        expect(logout.status).toBe(204);
        const copied = [...test.jar].map(([name, value]) => `${name}=${value}`).join("; ");
        test.acceptCookies(logout);
        expect((await test.app.fetch(test.makeRequest("/private"))).status).toBe(302);
        expect((await test.app.fetch(test.makeRequest("/private", {}, copied))).status).toBe(302);
        expect(test.exchanges()).toBe(1);
      } finally {
        await test.app.close();
      }
    },
  );

  it("returns a typed consent interaction without leaking provider data", async () => {
    const test = await fixture();
    try {
      const response = await test.app.fetch(test.callback(await test.login()));
      test.acceptCookies(response);
      const token = await test.app.fetch(test.makeRequest("/api/token"));
      expect(token.status).toBe(401);
      expect(token.headers.get("content-type")).toContain("application/problem+json");
      const body = await token.text();
      expect(JSON.parse(body)).toMatchObject({
        code: "interaction-required",
        reason: "consent",
        provider: "test",
        resource: "calendar",
        scopes: ["read"],
      });
      expect(body).not.toMatch(/CANARY|private@example/);
    } finally {
      await test.app.close();
    }
  });

  it("exposes an explicitly consented resource only through the server token capability", async () => {
    const test = await fixture();
    try {
      const response = await test.app.fetch(
        test.callback(await test.login("?resource=calendar&scope=read")),
      );
      expect(response.status).toBe(303);
      test.acceptCookies(response);
      const token = await test.app.fetch(test.makeRequest("/api/token"));
      expect(token.status).toBe(204);
      expect(token.headers.getSetCookie()).toContain("preferences=kept; Path=/");
      expect(await token.text()).toBe("");
      const session = await test.app.fetch(test.makeRequest("/auth/session"));
      expect(await session.json()).toMatchObject({ scopes: ["openid", "profile"] });
      expect(test.exchanges()).toBe(1);
    } finally {
      await test.app.close();
    }
  });

  it("shares the request-bound token context through SSR and preserves unrelated cookies on application errors", async () => {
    const test = await fixture("query", { tokenInLoader: true });
    try {
      test.acceptCookies(
        await test.app.fetch(test.callback(await test.login("?resource=calendar&scope=read"))),
      );
      const page = await test.app.fetch(test.makeRequest("/private"));
      expect(page.status, test.failures()).toBe(200);
      expect(test.observed.policy).toBe(test.observed.preload);
      expect(test.observed.loader).toBe(test.observed.preload);
      expect(test.observed.render).toBe(test.observed.preload);
      expect(Object.keys(test.observed.loader!)).not.toContain("token");
      expect(await page.text()).not.toMatch(/CANARY|private@example/);
      const failure = await test.app.fetch(test.makeRequest("/api/failure"));
      expect(failure.status).toBe(500);
      expect(failure.headers.getSetCookie()).toContain("preferences=kept; Path=/");
      expect(await failure.text()).toBe("Application error");
    } finally {
      await test.app.close();
    }
  });

  it("finalizes a staged renewal cookie after an application error and preserves unrelated cookies", async () => {
    const test = await fixture();
    try {
      test.acceptCookies(
        await test.app.fetch(test.callback(await test.login("?resource=calendar&scope=read"))),
      );
      test.advance(301_000);
      const response = await test.app.fetch(test.makeRequest("/api/failure"));
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.getSetCookie()).toContain("preferences=kept; Path=/");
      expect(
        response.headers.getSetCookie().some((line) => line.startsWith("__Host-askr-session=")),
      ).toBe(true);
      expect(await response.text()).toBe("Application error");
      expect(test.renewals()).toBe(1);
      expect(test.exchanges()).toBe(1);
      test.acceptCookies(response);
      const session = await test.app.fetch(test.makeRequest("/auth/session"));
      const body = await session.text();
      expect(JSON.parse(body)).toMatchObject({
        authenticated: true,
        scopes: ["openid", "profile"],
      });
      expect(body).not.toMatch(/CANARY|private@example/);
    } finally {
      await test.app.close();
    }
  });

  it("accepts a cross-site form callback with only its None transaction cookie", async () => {
    const test = await fixture("form_post");
    try {
      const fields = await test.login();
      const cookie = [...test.jar]
        .filter(([name]) => name.startsWith("__Host-askr-txn-"))
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
      const response = await test.app.fetch(
        test.callback(
          fields,
          {
            headers: {
              origin: issuer,
              "content-type": "application/x-www-form-urlencoded",
            },
          },
          cookie,
        ),
      );
      expect(response.status).toBe(303);
      test.acceptCookies(response);
      expect(await (await test.app.fetch(test.makeRequest("/auth/session"))).json()).toMatchObject({
        authenticated: true,
      });
    } finally {
      await test.app.close();
    }
  });

  it("atomically consumes concurrent copied callbacks through the application", async () => {
    const test = await fixture();
    try {
      const fields = await test.login();
      const cookie = [...test.jar].map(([name, value]) => `${name}=${value}`).join("; ");
      const responses = await Promise.all([
        test.app.fetch(test.callback(fields, {}, cookie)),
        test.app.fetch(test.callback(fields, {}, cookie)),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([303, 400]);
      const rejected = responses.find((response) => response.status === 400)!;
      expect(await rejected.json()).toMatchObject({ code: "invalid-transaction" });
      expect(test.exchanges()).toBe(1);
    } finally {
      await test.app.close();
    }
  });

  it("maps anonymous token requests to a safe login interaction with the canonical resource", async () => {
    const test = await fixture();
    try {
      const response = await test.app.fetch(test.makeRequest("/api/token"));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "interaction-required",
        reason: "login",
        provider: "test",
        resource: "calendar",
        scopes: ["read"],
      });
      expect(test.exchanges()).toBe(0);
    } finally {
      await test.app.close();
    }
  });

  it.each(["nonce", "signature", "expired"] as const)(
    "rejects %s identity failures and consumes their transactions",
    async (failure) => {
      const test = await fixture();
      try {
        const fields = await test.login();
        const cookie = [...test.jar].map(([name, value]) => `${name}=${value}`).join("; ");
        test.failIdentity(failure);
        const response = await test.app.fetch(test.callback(fields, {}, cookie));
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.text();
        expect(JSON.parse(body)).toMatchObject({ code: "invalid-callback" });
        expect(body).not.toMatch(/CANARY|private@example|cause|stack/);
        test.acceptCookies(response);
        expect(
          await (await test.app.fetch(test.makeRequest("/auth/session"))).json(),
        ).toMatchObject({ authenticated: false });
        const replay = await test.app.fetch(test.callback(fields, {}, cookie));
        expect(replay.status).toBe(400);
        expect(await replay.json()).toMatchObject({ code: "invalid-transaction" });
        expect(test.exchanges()).toBe(1);
      } finally {
        await test.app.close();
      }
    },
  );

  it("closes the provider engine idempotently and rejects later provider work safely", async () => {
    const test = await fixture();
    await test.app.close();
    await test.app.close();
    const response = await test.app.fetch(test.makeRequest("/auth/login/test"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "closed" });
    expect(test.exchanges()).toBe(0);
  });

  it("closes the provider engine even when the application's close hook rejects", async () => {
    const failure = new Error("APP_CLOSE_CANARY");
    let closes = 0;
    const test = await fixture("query", {
      close: () => {
        closes += 1;
        throw failure;
      },
    });
    const first = test.app.close();
    expect(test.app.close()).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(closes).toBe(1);
    const response = await test.app.fetch(test.makeRequest("/auth/login/test"));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: "closed" });
    expect(body).not.toContain("CANARY");
  });

  it("consumes oversized declared callbacks before reading or exchanging and rejects copied-cookie replay", async () => {
    const test = await fixture("form_post");
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reads += 1;
          throw new Error("BODY_READ_CANARY");
        },
      },
      { highWaterMark: 0 },
    );
    try {
      const fields = await test.login();
      const cookie = [...test.jar].map(([name, value]) => `${name}=${value}`).join("; ");
      const ingress: RequestInit & { duplex: "half" } = {
        body,
        duplex: "half",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "32769",
        },
      };
      const response = await test.app.fetch(test.callback(fields, ingress, cookie));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid-callback" });
      expect(
        response.headers
          .getSetCookie()
          .some((line) => line.startsWith("__Host-askr-txn-test=") && line.includes("Max-Age=0")),
      ).toBe(true);
      expect(test.exchanges()).toBe(0);
      expect(reads).toBe(0);
      const replay = await test.app.fetch(test.callback(fields, {}, cookie));
      expect(replay.status).toBe(400);
      expect(await replay.json()).toMatchObject({ code: "invalid-transaction" });
      expect(test.exchanges()).toBe(0);
    } finally {
      // A failed read can error this stream; cleanup must preserve that assertion.
      await body.cancel().catch(() => undefined);
      await test.app.close();
    }
  });

  it("does not consume a query callback on HEAD and rejects authenticated cross-site mutations", async () => {
    const test = await fixture();
    try {
      const fields = await test.login();
      expect((await test.app.fetch(test.callback(fields, { method: "HEAD" }))).status).toBe(405);
      const response = await test.app.fetch(test.callback(fields));
      expect(response.status).toBe(303);
      test.acceptCookies(response);
      const csrf = await test.app.fetch(
        test.makeRequest("/auth/logout", {
          method: "POST",
          headers: { origin: "https://evil.test" },
        }),
      );
      expect(csrf.status).toBe(403);
      expect(await (await test.app.fetch(test.makeRequest("/auth/session"))).json()).toMatchObject({
        authenticated: true,
      });
      expect(
        (
          await test.app.fetch(
            test.makeRequest("/auth/missing", { method: "POST", headers: { origin } }),
          )
        ).status,
      ).toBe(404);
    } finally {
      await test.app.close();
    }
  });
});
