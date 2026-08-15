import type { ServerApp } from "../contracts";

/** Stable diagnostic codes produced by {@link runAdapterConformance}. */
export type AdapterConformanceErrorCode =
  | "STREAM_EXERCISE_FAILED"
  | "STREAM_EXERCISE_TIMEOUT"
  | "STREAM_CANCELLATION_TIMEOUT"
  | "REQUEST_TIMEOUT_EXERCISE_FAILED"
  | "REQUEST_TIMEOUT_ENFORCEMENT_TIMEOUT";

/** A failed adapter-conformance guarantee with a stable machine-readable {@link code}. */
export class AdapterConformanceError extends Error {
  override readonly name = "AdapterConformanceError";

  constructor(
    readonly code: AdapterConformanceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Real-transport exercises supplied by an adapter's integration test. */
export interface AdapterConformanceExercises {
  /**
   * Write the supplied infinite response through the real adapter, observe a client chunk,
   * then close/reset the client. Resolve after the transport disconnect is observed.
   */
  abortStreamingResponse(response: Response, cleanup: AbortSignal): Promise<void>;
  /**
   * Run the supplied body-reading app through the real adapter with finite request/header
   * timeouts, send an incomplete request, and resolve after the transport terminates it.
   */
  enforceRequestTimeout(app: ServerApp, cleanup: AbortSignal): Promise<void>;
}

/** Options for {@link runAdapterConformance}. */
export interface AdapterConformanceOptions {
  /** Per-exercise deadline in milliseconds. Defaults to 1,000. */
  deadlineMs?: number;
}

/** Frozen success result returned by {@link runAdapterConformance}. */
export interface AdapterConformanceReport {
  readonly streamingResponseCancellation: "passed";
  readonly incompleteRequestTimeout: "passed";
}

function deadline(
  operation: Promise<void>,
  deadlineMs: number,
  controller: AbortController,
  code: AdapterConformanceErrorCode,
  message: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new AdapterConformanceError(code, message));
    }, deadlineMs);
    operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function verifyStreamingCancellation(
  exercise: AdapterConformanceExercises["abortStreamingResponse"],
  deadlineMs: number,
): Promise<void> {
  const cleanup = new AbortController();
  let cancelled = false;
  let resolveCancelled!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1_024));
      },
      cancel() {
        cancelled = true;
        resolveCancelled();
      },
    },
    { highWaterMark: 1 },
  );
  const response = new Response(body, {
    headers: { "content-type": "application/octet-stream" },
  });
  try {
    try {
      await deadline(
        Promise.resolve().then(() => exercise(response, cleanup.signal)),
        deadlineMs,
        cleanup,
        "STREAM_EXERCISE_TIMEOUT",
        "The streaming-response abort exercise did not settle before the conformance deadline.",
      );
    } catch (error) {
      if (error instanceof AdapterConformanceError) throw error;
      throw new AdapterConformanceError(
        "STREAM_EXERCISE_FAILED",
        "The streaming-response abort exercise failed.",
        { cause: error },
      );
    }
    await deadline(
      cancellation,
      deadlineMs,
      cleanup,
      "STREAM_CANCELLATION_TIMEOUT",
      "The adapter did not cancel the Web response body after the client disconnected.",
    );
  } finally {
    cleanup.abort();
    if (!cancelled) void body.cancel("Adapter conformance cleanup").catch(() => undefined);
  }
}

async function verifyRequestTimeout(
  exercise: AdapterConformanceExercises["enforceRequestTimeout"],
  deadlineMs: number,
): Promise<void> {
  const cleanup = new AbortController();
  const app: ServerApp = {
    async fetch(request) {
      try {
        await request.arrayBuffer();
        return new Response("Request body completed before the adapter timeout.", { status: 409 });
      } catch {
        return new Response(null, { status: 408 });
      }
    },
  };
  try {
    try {
      await deadline(
        Promise.resolve().then(() => exercise(app, cleanup.signal)),
        deadlineMs,
        cleanup,
        "REQUEST_TIMEOUT_ENFORCEMENT_TIMEOUT",
        "The adapter did not terminate the incomplete request before the conformance deadline.",
      );
    } catch (error) {
      if (error instanceof AdapterConformanceError) throw error;
      throw new AdapterConformanceError(
        "REQUEST_TIMEOUT_EXERCISE_FAILED",
        "The incomplete-request timeout exercise failed.",
        { cause: error },
      );
    }
  } finally {
    cleanup.abort();
  }
}

/**
 * Runs reusable adapter guardrails against real-transport exercises supplied by the adapter.
 * Validation errors throw synchronously; runtime failures reject with {@link AdapterConformanceError}.
 * Exercise callbacks must honor the cleanup signal and close any sockets/servers they own.
 */
export function runAdapterConformance(
  exercises: AdapterConformanceExercises,
  options: AdapterConformanceOptions = {},
): Promise<Readonly<AdapterConformanceReport>> {
  if (!exercises || typeof exercises !== "object") {
    throw new TypeError("runAdapterConformance requires an exercises object.");
  }
  if (typeof exercises.abortStreamingResponse !== "function") {
    throw new TypeError("exercises.abortStreamingResponse must be a function.");
  }
  if (typeof exercises.enforceRequestTimeout !== "function") {
    throw new TypeError("exercises.enforceRequestTimeout must be a function.");
  }
  const deadlineMs = options.deadlineMs ?? 1_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new TypeError("Adapter conformance deadlineMs must be a positive safe integer.");
  }
  return (async () => {
    await verifyStreamingCancellation(exercises.abortStreamingResponse, deadlineMs);
    await verifyRequestTimeout(exercises.enforceRequestTimeout, deadlineMs);
    return Object.freeze({
      streamingResponseCancellation: "passed",
      incompleteRequestTimeout: "passed",
    });
  })();
}
