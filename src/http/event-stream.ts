/** A single Server-Sent Event; `data` is JSON-serialized unless already a string. */
export interface ServerSentEvent {
  data?: unknown;
  event?: string;
  id?: string;
  retry?: number;
}

/** Options for {@link createEventStream}. */
export interface EventStreamOptions {
  /** Aborting this signal closes the stream. */
  signal?: AbortSignal;
  /** If set, sends a `heartbeat` comment on this interval (in ms) to keep the connection alive. */
  heartbeatInterval?: number;
  /** Backpressure threshold for the underlying `ReadableStream`. Defaults to 16. */
  highWaterMark?: number;
  headers?: HeadersInit;
}

/** A live Server-Sent Events stream, backed by a streaming `Response`. */
export interface EventStream {
  readonly response: Response;
  readonly closed: Promise<void>;
  send(event: ServerSentEvent): Promise<void>;
  comment(value: string): Promise<void>;
  close(): Promise<void>;
}

const encoder = new TextEncoder();

function safeField(value: string, name: string): void {
  if (value.includes("\r") || value.includes("\n") || value.includes("\0")) {
    throw new TypeError(`SSE ${name} must not contain a line break or NUL.`);
  }
}

function dataValue(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function formatLines(value: string, prefix: string): string {
  let output = "";
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    output += `${prefix}${value.slice(start, index)}\n`;
    if (code === 13 && value.charCodeAt(index + 1) === 10) index += 1;
    start = index + 1;
  }
  return `${output}${prefix}${value.slice(start)}`;
}

/**
 * Serializes a {@link ServerSentEvent} to the `text/event-stream` wire format, escaping
 * multi-line data/comment fields and validating that `event`/`id` contain no line breaks.
 *
 * @throws {TypeError} If `event`, `id`, or `retry` contain invalid characters/values.
 */
export function formatServerSentEvent(event: ServerSentEvent): string {
  let output = "";
  if (event.event !== undefined) {
    safeField(event.event, "event");
    output += `event: ${event.event}\n`;
  }
  if (event.id !== undefined) {
    safeField(event.id, "id");
    output += `id: ${event.id}\n`;
  }
  if (event.retry !== undefined) {
    if (!Number.isSafeInteger(event.retry) || event.retry < 0) {
      throw new TypeError("SSE retry must be a non-negative safe integer.");
    }
    output += `retry: ${event.retry}\n`;
  }
  if (event.data !== undefined) {
    output += `${formatLines(dataValue(event.data), "data: ")}\n`;
  }
  return output ? `${output}\n` : "\n\n";
}

/**
 * Creates a Server-Sent Events stream backed by a `text/event-stream` `Response`, with
 * backpressure-aware writes, optional heartbeat comments, and automatic closing when
 * `options.signal` aborts or `close()` is called.
 *
 * @param options - Stream configuration (abort signal, heartbeat interval, backpressure, headers).
 * @returns An {@link EventStream} exposing the response plus `send`/`comment`/`close` methods.
 * @throws {TypeError} If `highWaterMark` or `heartbeatInterval` are not positive safe integers.
 */
export function createEventStream(options: EventStreamOptions = {}): EventStream {
  const highWaterMark = options.highWaterMark ?? 16;
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) {
    throw new TypeError("SSE highWaterMark must be a positive safe integer.");
  }
  const heartbeatInterval = options.heartbeatInterval;
  if (
    heartbeatInterval !== undefined &&
    (!Number.isSafeInteger(heartbeatInterval) || heartbeatInterval <= 0)
  ) {
    throw new TypeError("SSE heartbeatInterval must be a positive safe integer.");
  }
  const signal = options.signal;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let settled = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let writes = Promise.resolve();
  const waiters: Array<() => void> = [];

  const finish = () => {
    if (settled) return;
    settled = true;
    if (heartbeat) clearInterval(heartbeat);
    signal?.removeEventListener("abort", finish);
    while (waiters.length) waiters.shift()?.();
    try {
      controller?.close();
    } catch {
      /* stream was already cancelled */
    }
    resolveClosed();
  };
  const write = (value: string): Promise<void> => {
    if (settled)
      return Promise.reject(new DOMException("The event stream is closed.", "InvalidStateError"));
    const operation = writes.then(async () => {
      if (settled) throw new DOMException("The event stream is closed.", "InvalidStateError");
      while ((controller?.desiredSize ?? 1) <= 0 && !settled) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      if (settled) throw new DOMException("The event stream is closed.", "InvalidStateError");
      controller?.enqueue(encoder.encode(value));
    });
    writes = operation.catch(() => undefined);
    return operation;
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        while (waiters.length) waiters.shift()?.();
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark },
  );
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/event-stream; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-cache, no-transform");
  if (!headers.has("connection")) headers.set("connection", "keep-alive");
  if (!headers.has("x-accel-buffering")) headers.set("x-accel-buffering", "no");
  const api: EventStream = {
    response: new Response(stream, { status: 200, headers }),
    closed,
    send: (event) => write(formatServerSentEvent(event)),
    comment(value) {
      if (value.includes("\0"))
        return Promise.reject(new TypeError("SSE comments must not contain NUL."));
      return write(`${formatLines(value, ": ")}\n\n`);
    },
    async close() {
      finish();
      await closed;
    },
  };
  if (heartbeatInterval !== undefined) {
    heartbeat = setInterval(() => {
      void api.comment("heartbeat").catch(() => undefined);
    }, heartbeatInterval);
  }
  if (signal?.aborted) finish();
  else signal?.addEventListener("abort", finish, { once: true });
  return api;
}
