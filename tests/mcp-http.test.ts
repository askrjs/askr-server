import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/application";
import { registerMcpRoutes } from "../src/mcp/http";
import { createMcpServer } from "../src/mcp/server";
import { createRouter } from "../src/router/router";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

function application(stateful = false) {
  const router = createRouter();
  registerMcpRoutes(router, "/mcp", createMcpServer({ name: "http", version: "1" }), {
    dependencies: undefined,
    stateful,
    allowedOrigins: ["https://client.example"],
    allowedHosts: ["server.example"],
    resource: "https://server.example/mcp",
    heartbeatInterval: 60_000,
  });
  return createServerApp(router);
}

function post(body: unknown, headers: HeadersInit = {}) {
  return new Request("https://server.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: "https://client.example",
      host: "server.example",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("MCP Streamable HTTP", () => {
  it("should enforce negotiation, request limits, Origin, and Host", async () => {
    const app = application();
    expect(
      (
        await app.fetch(
          new Request("https://server.example/mcp", { headers: { host: "server.example" } }),
        )
      ).status,
    ).toBe(405);
    expect((await app.fetch(post(initialize, { origin: "https://evil.example" }))).status).toBe(
      403,
    );
    expect((await app.fetch(post(initialize, { "content-type": "text/plain" }))).status).toBe(415);
    expect(
      (await app.fetch(post(initialize, { "mcp-protocol-version": "2099-01-01" }))).status,
    ).toBe(400);
    const response = await app.fetch(post(initialize));
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).result.protocolVersion).toBe("2025-11-25");
  });

  it("should create, stream, and delete stateful sessions", async () => {
    const app = application(true);
    const initialized = await app.fetch(post(initialize));
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const sessionHeaders = { "mcp-session-id": sessionId!, "mcp-protocol-version": "2025-11-25" };
    const stream = await app.fetch(
      new Request("https://server.example/mcp", {
        headers: { accept: "text/event-stream", host: "server.example", ...sessionHeaders },
      }),
    );
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
    await reader.cancel();
    const removed = await app.fetch(
      new Request("https://server.example/mcp", {
        method: "DELETE",
        headers: { host: "server.example", ...sessionHeaders },
      }),
    );
    expect(removed.status).toBe(204);
    expect(
      (
        await app.fetch(
          new Request("https://server.example/mcp", {
            method: "DELETE",
            headers: { host: "server.example", ...sessionHeaders },
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("should publish RFC 9728 protected-resource metadata", async () => {
    const response = await application().fetch(
      new Request("https://server.example/.well-known/oauth-protected-resource"),
    );
    expect(await response.json()).toMatchObject({
      resource: "https://server.example/mcp",
      bearer_methods_supported: ["header"],
    });
  });
});
