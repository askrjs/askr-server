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
});
