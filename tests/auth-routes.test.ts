import { describe, expect, it, vi } from "vitest";
import { registerAuthRoutes } from "../src/auth";
import { createServerApp } from "../src/application";
import { createApi, schema } from "../src/openapi";

function authApplication() {
  const issue = vi.fn(async () => "token");
  const revoke = vi.fn(async () => undefined);
  const register = vi.fn(async (_context, credentials: { email: string; password: string }) => ({
    id: "user-1",
    email: credentials.email,
  }));
  const authenticate = vi.fn(
    async (_context, credentials: { email: string; password: string }) => ({
      id: "user-1",
      email: credentials.email,
    }),
  );
  const api = createApi({ info: { title: "Authentication", version: "1" } });
  registerAuthRoutes(api, {
    issuer: { issue },
    cookie: { name: "session" },
    principalSchema: schema.object({ id: schema.string(), email: schema.email() }),
    register,
    authenticate,
    allowAttempt: async () => true,
    revoke,
    redirect: () => "/account",
  });
  return { api, app: createServerApp(api.createRouter()), register, authenticate, issue, revoke };
}

function login(body?: unknown, accept = "application/json"): Request {
  return new Request("https://example.test/auth/v1/session", {
    method: "POST",
    headers: {
      accept,
      origin: "https://example.test",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("authentication routes", () => {
  it("should read credentials only from the declared JSON body", async () => {
    const { app, authenticate } = authApplication();
    const response = await app.fetch(
      new Request(
        "https://example.test/auth/v1/session?email=user%40example.test&password=secret",
        { method: "POST", headers: { origin: "https://example.test" } },
      ),
    );
    expect(response.status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("should document and return the successful authentication envelope", async () => {
    const { api, app, issue } = authApplication();
    const response = await app.fetch(login({ email: "User@Example.test", password: "secret" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      principal: { id: "user-1", email: "user@example.test" },
      session: null,
      tenant: null,
    });
    expect(response.headers.get("set-cookie")).toContain("session=token");
    expect(issue).toHaveBeenCalledWith({ email: "user@example.test", subject: "user-1" });
    expect(
      api.toOpenApiDocument().paths["/auth/v1/session"].post?.responses["200"].content?.[
        "application/json"
      ]?.schema,
    ).toMatchObject({
      required: ["authenticated", "principal", "session", "tenant"],
      properties: { principal: { required: ["id", "email"] } },
    });
  });

  it("should reject credential fields outside the documented schema", async () => {
    const { app, authenticate } = authApplication();
    const response = await app.fetch(
      login({ email: "user@example.test", password: "secret", admin: true }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      issues: [{ path: ["body", "admin"], code: "unrecognized_key" }],
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("should honor explicit Accept exclusions before redirecting", async () => {
    const { app } = authApplication();
    const excluded = await app.fetch(
      login({ email: "user@example.test", password: "secret" }, "text/html;q=0, */*;q=1"),
    );
    expect(excluded.status).toBe(200);
    expect(excluded.headers.get("location")).toBeNull();

    const accepted = await app.fetch(
      login({ email: "user@example.test", password: "secret" }, "Text/HTML"),
    );
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/account");
  });

  it("should revoke the server session before clearing its cookie", async () => {
    const { app, revoke } = authApplication();
    const response = await app.fetch(
      new Request("https://example.test/auth/v1/session", {
        method: "DELETE",
        headers: { origin: "https://example.test" },
      }),
    );
    expect(response.status).toBe(204);
    expect(revoke).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
