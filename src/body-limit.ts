export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;

const limits = new WeakMap<Request, number>();
const bodies = new WeakMap<Request, Promise<Uint8Array>>();

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
  limits.set(request, validateMaxRequestBytes(maximum));
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

export async function readRequestText(
  request: Request,
  maximum = requestLimit(request),
): Promise<string> {
  return new TextDecoder().decode(await readRequestBytes(request, maximum));
}

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
