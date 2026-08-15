/** Default maximum request body size, in bytes (1 MiB), used when no limit is configured. */
export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;

const limits = new WeakMap<Request, number>();
const bodies = new WeakMap<Request, Promise<Uint8Array>>();
const decoder = new TextDecoder();

export function hasBufferedRequestBody(request: Request): boolean {
  return bodies.has(request);
}

/** Error thrown when a request body exceeds the configured maximum size. */
export class PayloadTooLargeError extends Error {
  readonly status = 413;

  constructor(message = "Request body exceeds the configured maximum size.") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

export function validateMaxRequestBytes(value: number, label = "maxRequestBytes"): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function configureRequestLimit(request: Request, maximum: number): void {
  limits.set(request, maximum);
}

export function requestLimit(request: Request): number {
  return limits.get(request) ?? DEFAULT_MAX_REQUEST_BYTES;
}

export function rejectOversizedContentLength(
  request: Request,
  maximum = requestLimit(request),
): void {
  const header = request.headers.get("content-length");
  if (header === null) return;
  const length = Number(header);
  if (Number.isFinite(length) && length > maximum) throw new PayloadTooLargeError();
}

/**
 * Reads a request body into memory as raw bytes, enforcing a maximum size. The result is
 * cached per-request so subsequent reads (e.g. for JSON, text, or form data) reuse the same
 * buffered bytes instead of re-reading the stream.
 *
 * @param request - The request whose body to read.
 * @param maximum - Maximum allowed size in bytes; defaults to the request's configured limit.
 * @returns The full body as a `Uint8Array`.
 * @throws {PayloadTooLargeError} If the body exceeds `maximum`.
 */
export function readRequestBytes(
  request: Request,
  maximum = requestLimit(request),
): Promise<Uint8Array> {
  rejectOversizedContentLength(request, maximum);
  const existing = bodies.get(request);
  if (existing) return existing;
  if (request.bodyUsed)
    return Promise.reject(new TypeError("Request body has already been consumed."));
  const pending = (async () => {
    if (!request.body) return new Uint8Array();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximum) {
          await reader.cancel().catch(() => undefined);
          throw new PayloadTooLargeError();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (chunks.length === 1) return chunks[0]!;
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  })();
  bodies.set(request, pending);
  return pending;
}

/**
 * Reads and decodes a request body as UTF-8 text, enforcing a maximum size.
 *
 * @param request - The request whose body to read.
 * @param maximum - Maximum allowed size in bytes; defaults to the request's configured limit.
 * @throws {PayloadTooLargeError} If the body exceeds `maximum`.
 */
export async function readRequestText(
  request: Request,
  maximum = requestLimit(request),
): Promise<string> {
  return decoder.decode(await readRequestBytes(request, maximum));
}

/**
 * Reads a request body and parses it as `multipart/form-data`, enforcing a maximum size.
 *
 * @param request - The request whose body to read.
 * @param maximum - Maximum allowed size in bytes; defaults to the request's configured limit.
 * @returns The parsed form data.
 * @throws {PayloadTooLargeError} If the body exceeds `maximum`.
 */
export async function readRequestFormData(
  request: Request,
  maximum = requestLimit(request),
): Promise<FormData> {
  const bytes = await readRequestBytes(request, maximum);
  const copy = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes.slice().buffer as ArrayBuffer,
  });
  return copy.formData();
}
