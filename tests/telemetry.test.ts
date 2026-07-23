import { createRouteRegistry, route } from "@askrjs/askr/router";
import { defineServerQueries, defineQuery, serveQuery } from "@askrjs/askr/data";
import { schema } from "@askrjs/schema";
import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/application";
import { defineServerActions, handleAction } from "../src/askr/actions";
import { createAskrPageHandler } from "../src/askr/page-handler";
import type {
  ServerTelemetry,
  ServerTelemetryFields,
  ServerTelemetryOperation,
} from "../src/contracts";
import { createApi } from "../src/openapi";

interface TelemetryRecord {
  readonly kind: "start" | "end" | "log";
  readonly operation: ServerTelemetryOperation;
  readonly fields: Readonly<ServerTelemetryFields>;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

function responseStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("status" in value)) return undefined;
  const status = value.status;
  return typeof status === "number" ? status : undefined;
}

function createTelemetryRecorder(): {
  readonly telemetry: ServerTelemetry;
  readonly records: TelemetryRecord[];
} {
  const records: TelemetryRecord[] = [];
  let activeTraceId: string | undefined;
  const wrap =
    (operation: ServerTelemetryOperation) =>
    <T>(fields: ServerTelemetryFields, work: () => T): T => {
      records.push({ kind: "start", operation, fields: { ...fields } });
      const result = work();
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then((value) => {
          records.push({
            kind: "end",
            operation,
            fields: { ...fields, status: responseStatus(value) ?? fields.status },
          });
          return value;
        }) as T;
      }
      records.push({
        kind: "end",
        operation,
        fields: { ...fields, status: responseStatus(result) ?? fields.status },
      });
      return result;
    };
  const telemetry: ServerTelemetry = {
    request: wrap("askr.request"),
    routeMatch: wrap("askr.route.match"),
    loader: wrap("askr.loader"),
    action: wrap("askr.action"),
    apiOperation: wrap("askr.api.operation"),
    queryPrefetch: wrap("askr.query.prefetch"),
    ssrRender: wrap("askr.ssr.render"),
    log: (_level, operation, fields = {}) => {
      records.push({ kind: "log", operation, fields: { ...fields } });
    },
    traceId: () => activeTraceId,
    extract: (headers, getter) => ({
      traceparent: getter.get(headers, "traceparent"),
    }),
    withContext: (value, work) => {
      const previous = activeTraceId;
      activeTraceId = (value as { traceparent?: string }).traceparent
        ? "trace-from-parent"
        : undefined;
      try {
        return work();
      } finally {
        activeTraceId = previous;
      }
    },
  };
  return { telemetry, records };
}

function lifecycle(records: readonly TelemetryRecord[]): string[] {
  return records
    .filter((record) => record.kind !== "log")
    .map((record) => `${record.kind}:${record.operation}`);
}

describe("server telemetry", () => {
  it("should use an inferred operation ID for both the document and telemetry", async () => {
    const recorder = createTelemetryRecorder();
    const api = createApi({ info: { title: "Telemetry", version: "1" } });
    api.get("/users/{id}", (context) => context.ok()).pathParam("id", schema.string());
    const documented = api.toOpenApiDocument().paths["/users/{id}"].get?.operationId;
    await createServerApp({ router: api.createRouter(), telemetry: recorder.telemetry }).fetch(
      new Request("http://example.test/users/42"),
    );
    expect(documented).toBe("getUsersById");
    expect(recorder.records).toContainEqual(
      expect.objectContaining({
        operation: "askr.api.operation",
        fields: expect.objectContaining({ operation: documented }),
      }),
    );
    expect(recorder.records).toContainEqual(
      expect.objectContaining({
        operation: "askr.route.match",
        fields: expect.objectContaining({ route: "/users/{id}" }),
      }),
    );
    expect(JSON.stringify(recorder.records)).not.toContain("/users/42");
  });

  it("should nest API execution under the request and record response status", async () => {
    const recorder = createTelemetryRecorder();
    const api = createApi({ info: { title: "Telemetry", version: "1" } });
    api
      .post("/items", {
        input: {
          body: {
            schema: schema.object({ name: schema.string() }),
            mediaTypes: ["application/json"],
          },
        },
        handler: (context) => context.created({ ok: true }),
      })
      .operationId("createItem")
      .summary("Create an item")
      .created(schema.object({ ok: schema.boolean() }));
    const response = await createServerApp({
      router: api.createRouter(),
      telemetry: recorder.telemetry,
    }).fetch(
      new Request("http://example.test/items", {
        method: "POST",
        headers: {
          authorization: "Bearer private-token",
          cookie: "session=private-cookie",
          "content-type": "application/json",
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
          "x-request-id": "request-1",
        },
        body: JSON.stringify({ name: "private-name" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(lifecycle(recorder.records)).toEqual([
      "start:askr.request",
      "start:askr.route.match",
      "end:askr.route.match",
      "start:askr.api.operation",
      "end:askr.api.operation",
      "end:askr.request",
    ]);
    expect(recorder.records).toContainEqual(
      expect.objectContaining({
        kind: "end",
        operation: "askr.api.operation",
        fields: expect.objectContaining({
          requestId: "request-1",
          traceId: "trace-from-parent",
          route: "/items",
          operation: "createItem",
          status: 201,
        }),
      }),
    );
  });

  it("should instrument authorized actions without exposing submitted or credential data", async () => {
    const recorder = createTelemetryRecorder();
    const descriptor = Object.freeze({
      id: "save-item",
      input: schema.object({ name: schema.string() }),
      invalidates: Object.freeze(["items"]),
    });
    const actions = defineServerActions(
      { dependencies: {}, csrf: false },
      handleAction(descriptor, () => ({ result: { saved: true } })),
    );
    const registry = createRouteRegistry(() => {
      route("/items/{id}", () => "item", { actions: [descriptor] });
    });
    const response = await createServerApp({
      telemetry: recorder.telemetry,
      fallback: createAskrPageHandler({ registry, actions }),
    }).fetch(
      new Request("http://example.test/items/42", {
        method: "POST",
        headers: {
          accept: "application/vnd.askr.action+json;v=1",
          authorization: "Bearer action-token",
          cookie: "session=action-cookie",
          "content-type": "application/json",
          "x-askr-action": descriptor.id,
        },
        body: JSON.stringify({ name: "submitted-private-name" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(lifecycle(recorder.records)).toEqual([
      "start:askr.request",
      "start:askr.route.match",
      "end:askr.route.match",
      "start:askr.route.match",
      "end:askr.route.match",
      "start:askr.action",
      "end:askr.action",
      "end:askr.request",
    ]);
    expect(recorder.records).toContainEqual(
      expect.objectContaining({
        kind: "end",
        operation: "askr.action",
        fields: expect.objectContaining({ action: "save-item", status: 200 }),
      }),
    );
    const recorded = JSON.stringify(recorder.records);
    expect(recorded).not.toContain("submitted-private-name");
    expect(recorded).not.toContain("action-token");
    expect(recorded).not.toContain("action-cookie");
    for (const record of recorder.records) {
      expect(
        Object.keys(record.fields).every((key) =>
          ["requestId", "traceId", "route", "action", "operation", "status", "durationMs"].includes(
            key,
          ),
        ),
      ).toBe(true);
    }
  });

  it("should forward one telemetry service through SSR loader and query work", async () => {
    const recorder = createTelemetryRecorder();
    const query = defineQuery({
      key: () => "catalog",
      fetch: async () => ({ title: "catalog" }),
    });
    const queryRegistry = defineServerQueries(
      serveQuery(query, async () => ({ title: "catalog" })),
    );
    const registry = createRouteRegistry(() => {
      route("/catalog/{id}", ({ id }) => `catalog:${id}`, {
        preload: ({ data }) => data.prefetch(query, {}),
        loader: async () => ({ ready: true }),
      });
    });
    const response = await createServerApp({
      telemetry: recorder.telemetry,
      fallback: createAskrPageHandler({ registry, queryRegistry }),
    }).fetch(new Request("http://example.test/catalog/42"));

    expect(response.status).toBe(200);
    expect(lifecycle(recorder.records)).toEqual([
      "start:askr.request",
      "start:askr.route.match",
      "end:askr.route.match",
      "start:askr.ssr.render",
      "start:askr.route.match",
      "start:askr.query.prefetch",
      "end:askr.query.prefetch",
      "start:askr.loader",
      "end:askr.loader",
      "end:askr.route.match",
      "end:askr.ssr.render",
      "end:askr.request",
    ]);
  });
});
