import { schema } from "@askrjs/schema";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server";

const anonymous = { authenticated: false, principal: null, session: null, tenant: null } as const;
const environment = {
  dependencies: { prefix: "hello" },
  auth: anonymous,
  transport: "stdio" as const,
};
const request = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});

describe("MCP server", () => {
  it("should negotiate both supported revisions and derive push capabilities", async () => {
    const server = createMcpServer({ name: "test", version: "1.0.0" });
    for (const protocolVersion of ["2025-11-25", "2025-06-18"]) {
      const result = (await server.handle(
        request(1, "initialize", {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "client", version: "1" },
        }),
        environment,
      )) as any;
      expect(result.result.protocolVersion).toBe(protocolVersion);
      expect(result.result.capabilities.tools.listChanged).toBe(false);
    }
    const pushed = (await server.handle(
      request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "client", version: "1" },
      }),
      { ...environment, supportsPush: true },
    )) as any;
    expect(pushed.result.capabilities.tools.listChanged).toBe(true);
  });

  it("should validate tools and separate tool failures from protocol failures", async () => {
    const server = createMcpServer<typeof environment.dependencies>({ name: "test", version: "1" })
      .tool(
        "greet",
        {
          input: schema.object({ name: schema.string() }),
          output: schema.object({ greeting: schema.string() }),
        },
        (context, input) => ({
          content: [{ type: "text", text: `${context.dependencies.prefix} ${input.name}` }],
          structuredContent: { greeting: input.name },
        }),
      )
      .tool("explode", { input: schema.object({}) }, () => {
        throw new Error("boom");
      });
    const invalid = (await server.handle(
      request(2, "tools/call", { name: "greet", arguments: {} }),
      environment,
    )) as any;
    expect(invalid.error.code).toBe(-32602);
    const failed = (await server.handle(
      request(3, "tools/call", { name: "explode" }),
      environment,
    )) as any;
    expect(failed.result).toMatchObject({ isError: true, content: [{ text: "boom" }] });
  });

  it("should paginate and filter listings using primitive authorization", async () => {
    const server = createMcpServer({ name: "test", version: "1", pageSize: 1 })
      .tool("visible", { input: schema.object({}) }, () => ({ content: [] }))
      .tool(
        "hidden",
        { input: schema.object({}), auth: () => ({ allowed: false, reason: "forbidden" }) },
        () => ({ content: [] }),
      );
    const result = (await server.handle(request(1, "tools/list"), environment)) as any;
    expect(result.result.tools.map((tool: any) => tool.name)).toEqual(["visible"]);
    expect(result.result.nextCursor).toBeUndefined();
  });

  it("should deliver progress and list change notifications", async () => {
    const messages: unknown[] = [];
    const server = createMcpServer({ name: "test", version: "1" }).tool(
      "work",
      { input: schema.object({}) },
      async (context) => {
        await context.progress(1, 2, "half");
        return { content: [] };
      },
    );
    const stateful = {
      ...environment,
      sessionId: "session",
      supportsPush: true,
      send: (message: unknown) => {
        messages.push(message);
      },
    };
    await server.handle(
      request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "client", version: "1" },
      }),
      stateful,
    );
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, stateful);
    await server.handle(
      request(2, "tools/call", { name: "work", arguments: {}, _meta: { progressToken: "p" } }),
      stateful,
    );
    await server.notifyToolsChanged();
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "p", progress: 1, total: 2, message: "half" },
      },
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    ]);
  });
});
