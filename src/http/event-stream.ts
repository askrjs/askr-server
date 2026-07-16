export interface ServerSentEvent {
  data?: unknown;
  event?: string;
  id?: string;
  retry?: number;
}

export interface EventStreamOptions {
  signal?: AbortSignal;
  heartbeatInterval?: number;
  highWaterMark?: number;
  headers?: HeadersInit;
}

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

export function formatServerSentEvent(event: ServerSentEvent): string {
  const fields: string[] = [];
  if (event.event !== undefined) {
    safeField(event.event, "event");
    fields.push(`event: ${event.event}`);
  }
  if (event.id !== undefined) {
    safeField(event.id, "id");
    fields.push(`id: ${event.id}`);
  }
  if (event.retry !== undefined) {
    if (!Number.isSafeInteger(event.retry) || event.retry < 0) {
      throw new TypeError("SSE retry must be a non-negative safe integer.");
    }
    fields.push(`retry: ${event.retry}`);
  }
  if (event.data !== undefined) {
    for (const line of dataValue(event.data).split(/\r\n|\r|\n/)) fields.push(`data: ${line}`);
  }
  return `${fields.join("\n")}\n\n`;
}

export function createEventStream(options: EventStreamOptions = {}): EventStream {
  const highWaterMark = options.highWaterMark ?? 16;
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) {
    throw new TypeError("SSE highWaterMark must be a positive safe integer.");
  }
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
      return write(
        `${value
          .split(/\r\n|\r|\n/)
          .map((line) => `: ${line}`)
          .join("\n")}\n\n`,
      );
    },
    async close() {
      finish();
      await closed;
    },
  };
  options.signal?.addEventListener("abort", finish, { once: true });
  if (options.signal?.aborted) finish();
  if (options.heartbeatInterval !== undefined) {
    if (!Number.isSafeInteger(options.heartbeatInterval) || options.heartbeatInterval <= 0) {
      throw new TypeError("SSE heartbeatInterval must be a positive safe integer.");
    }
    heartbeat = setInterval(() => {
      void api.comment("heartbeat").catch(() => undefined);
    }, options.heartbeatInterval);
  }
  return api;
}
