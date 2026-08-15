import { describe, expect, it, vi } from "vitest";
import { createEventStream, formatServerSentEvent } from "../src/http/event-stream";

describe("server-sent events", () => {
  it("should frame fields and multiline data exactly", () => {
    expect(formatServerSentEvent({ event: "update", id: "7", retry: 2500, data: "one\ntwo" })).toBe(
      "event: update\nid: 7\nretry: 2500\ndata: one\ndata: two\n\n",
    );
  });

  it("should reject unsafe fields and retry values", () => {
    expect(() => formatServerSentEvent({ id: "bad\nid" })).toThrow(/line break/);
    expect(() => formatServerSentEvent({ event: "bad\0event" })).toThrow(/NUL/);
    expect(() => formatServerSentEvent({ retry: -1 })).toThrow(/non-negative/);
  });

  it("should expose streaming headers and preserve write order", async () => {
    const events = createEventStream();
    expect(events.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(events.response.headers.get("cache-control")).toBe("no-cache, no-transform");
    const reader = events.response.body!.getReader();
    await Promise.all([
      events.send({ data: "first" }),
      events.comment("between"),
      events.send({ data: "last" }),
    ]);
    await events.close();
    let output = "";
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      output += new TextDecoder().decode(value.value);
    }
    expect(output).toBe("data: first\n\n: between\n\ndata: last\n\n");
    await expect(events.send({ data: "late" })).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    await events.close();
  });

  it("should close on abort and emit optional heartbeats", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const events = createEventStream({ signal: controller.signal, heartbeatInterval: 100 });
    const reader = events.response.body!.getReader();
    await vi.advanceTimersByTimeAsync(100);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    controller.abort();
    await events.closed;
    expect((await reader.read()).done).toBe(true);
    vi.useRealTimers();
  });

  it("should avoid heartbeat leaks given an already-aborted signal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const events = createEventStream({ signal: controller.signal, heartbeatInterval: 100 });
    await events.closed;
    expect(vi.getTimerCount()).toBe(0);
    expect((await events.response.body!.getReader().read()).done).toBe(true);
    vi.useRealTimers();
  });

  it("should reject invalid construction options before allocating timers", () => {
    vi.useFakeTimers();
    expect(() => createEventStream({ heartbeatInterval: 0 })).toThrow(/heartbeatInterval/);
    expect(() => createEventStream({ highWaterMark: 0, heartbeatInterval: 100 })).toThrow(
      /highWaterMark/,
    );
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("should bound many unawaited writes before retaining or formatting payloads", async () => {
    const events = createEventStream({ highWaterMark: 2 });
    let serializations = 0;
    const writes = Array.from({ length: 100 }, (_, index) =>
      events.send({
        data: {
          toJSON() {
            serializations += 1;
            return { index, payload: "x".repeat(100_000) };
          },
        },
      }),
    );

    expect(serializations).toBe(0);
    const results = await Promise.allSettled(writes);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(98);
    for (const result of rejected) {
      expect(result).toMatchObject({
        reason: { name: "QuotaExceededError" },
      });
    }
    expect(serializations).toBe(2);

    let recoveredSerializations = 0;
    const blocked = [0, 1].map((index) =>
      events.send({
        data: {
          toJSON() {
            recoveredSerializations += 1;
            return { index };
          },
        },
      }),
    );
    await Promise.resolve();
    expect(recoveredSerializations).toBe(0);
    await expect(events.send({ data: "overflow" })).rejects.toMatchObject({
      name: "QuotaExceededError",
    });

    const reader = events.response.body!.getReader();
    await reader.read();
    await blocked[0];
    expect(recoveredSerializations).toBe(1);
    await reader.read();
    await blocked[1];
    expect(recoveredSerializations).toBe(2);
    await events.close();
  });
});
