import type {
  ChallengeOptions,
  CookieOptions,
  JsonValue,
  Problem,
  ProblemOptions,
} from "../contracts";
import { cloneResponse, copyHeaders } from "./headers";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" } as const;
const textHeaders = { "content-type": "text/plain; charset=utf-8" } as const;
const problemHeaders = { "content-type": "application/problem+json" } as const;

function responseHeaders(init: ResponseInit | undefined, contentType?: string): Headers {
  const headers = copyHeaders(init?.headers);
  if (contentType && !headers.has("content-type")) headers.set("content-type", contentType);
  return headers;
}

/** Builds a `200 OK`-shaped JSON response, serializing `value` and setting the JSON content type. */
export function json(value: JsonValue, init?: ResponseInit): Response {
  if (!init) return new Response(JSON.stringify(value), { headers: jsonHeaders });
  return new Response(JSON.stringify(value), {
    ...init,
    headers: responseHeaders(init, "application/json; charset=utf-8"),
  });
}

/** Builds a plain-text response, setting the `text/plain; charset=utf-8` content type. */
export function text(value: string, init?: ResponseInit): Response {
  if (!init) return new Response(value, { headers: textHeaders });
  return new Response(value, {
    ...init,
    headers: responseHeaders(init, "text/plain; charset=utf-8"),
  });
}

/** Builds a redirect response with an empty body and a `Location` header. Defaults to `302 Found`. */
export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
  return new Response(null, { status, headers: { location } });
}

const statusTitles: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  503: "Service Unavailable",
};

/**
 * Builds an RFC 9457 `application/problem+json` response, defaulting `type` to `about:blank`
 * and `title` to a standard reason phrase for the given `status` (falling back to "HTTP Error").
 */
export function problem(
  status: number,
  detail?: string,
  options: ProblemOptions & { init?: ResponseInit } = {},
): Response {
  const { init, extensions, ...fields } = options;
  const value: Problem = {
    type: fields.type ?? "about:blank",
    title: fields.title ?? statusTitles[status] ?? "HTTP Error",
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(fields.instance === undefined ? {} : { instance: fields.instance }),
    ...extensions,
  };
  return new Response(
    JSON.stringify(value),
    init
      ? { ...init, status, headers: responseHeaders(init, "application/problem+json") }
      : { status, headers: problemHeaders },
  );
}

function withStatus(status: number, value?: JsonValue, init?: ResponseInit): Response {
  if (!init) {
    return value === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(value), { status, headers: jsonHeaders });
  }
  return value === undefined
    ? new Response(null, { ...init, status, headers: responseHeaders(init) })
    : json(value, { ...init, status });
}

function message(status: number, detail: string, init?: ResponseInit): Response {
  return problem(status, detail, { init });
}

/** Builds a `200 OK` response; JSON-serializes `value` if given, otherwise an empty body. */
export const ok = (value?: JsonValue, init?: ResponseInit) => withStatus(200, value, init);
/** Builds a `201 Created` response; JSON-serializes `value` if given, otherwise an empty body. */
export const created = (value?: JsonValue, init?: ResponseInit) => withStatus(201, value, init);
/** Builds a `202 Accepted` response; JSON-serializes `value` if given, otherwise an empty body. */
export const accepted = (value?: JsonValue, init?: ResponseInit) => withStatus(202, value, init);
/** Builds a `204 No Content` response with an empty body. */
export const noContent = (init?: ResponseInit) => withStatus(204, undefined, init);
/** Builds a `400 Bad Request` Problem Details response. */
export const badRequest = (detail = "Bad Request", init?: ResponseInit) =>
  message(400, detail, init);
/** Alias for {@link badRequest}. */
export const bad = badRequest;
/** Builds a `401 Unauthorized` Problem Details response. */
export const unauthorized = (detail = "Unauthorized", init?: ResponseInit) =>
  message(401, detail, init);
/** Builds a `403 Forbidden` Problem Details response. */
export const forbidden = (detail = "Forbidden", init?: ResponseInit) => message(403, detail, init);
/** Builds a `404 Not Found` Problem Details response. */
export const notFound = (detail = "Not Found", init?: ResponseInit) => message(404, detail, init);
/** Builds a `409 Conflict` Problem Details response. */
export const conflict = (detail = "Conflict", init?: ResponseInit) => message(409, detail, init);
/** Builds a `422 Unprocessable Entity` Problem Details response. */
export const unprocessableEntity = (detail = "Unprocessable Entity", init?: ResponseInit) =>
  message(422, detail, init);
/** Builds a `429 Too Many Requests` Problem Details response. */
export const tooManyRequests = (detail = "Too Many Requests", init?: ResponseInit) =>
  message(429, detail, init);
/** Builds a `501 Not Implemented` Problem Details response. */
export const notImplemented = (detail = "Not Implemented", init?: ResponseInit) =>
  message(501, detail, init);
/** Builds a `503 Service Unavailable` Problem Details response. */
export const serviceUnavailable = (detail = "Service Unavailable", init?: ResponseInit) =>
  message(503, detail, init);
/** Builds a Problem Details error response with a configurable status (default `500`). */
export const error = (status = 500, detail = "Internal Server Error", init?: ResponseInit) =>
  message(status, detail, init);
/** Builds a `500 Internal Server Error` Problem Details response. */
export const internalServerError = (detail = "Internal Server Error", init?: ResponseInit) =>
  error(500, detail, init);
/** Alias for {@link internalServerError}. */
export const serverError = internalServerError;

/** Builds a `405 Method Not Allowed` Problem Details response, setting the `Allow` header if given. */
export function methodNotAllowed(
  allow?: string | readonly string[],
  init?: ResponseInit,
): Response {
  const headers = responseHeaders(init);
  if (allow) headers.set("allow", typeof allow === "string" ? allow : allow.join(", "));
  return problem(405, undefined, { init: { ...init, headers } });
}

const cookieDomain = /^[A-Za-z0-9.-]+$/u;
const cookiePath = /^[\u0020-\u003A\u003C-\u007E]*$/u;

function cookieAttribute(name: "domain" | "path", value: string): string {
  const valid = name === "domain" ? cookieDomain.test(value) : cookiePath.test(value);
  if (!valid) throw new TypeError(`Cookie ${name} contains invalid characters.`);
  return value;
}

function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.domain) parts.push(`Domain=${cookieAttribute("domain", options.domain)}`);
  if (options.path) parts.push(`Path=${cookieAttribute("path", options.path)}`);
  if (options.sameSite)
    parts.push(`SameSite=${options.sameSite[0].toUpperCase()}${options.sameSite.slice(1)}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Returns a clone of `response` with an additional `Set-Cookie` header appended, serialized
 * from `name`, `value`, and `options`.
 * @throws {TypeError} If the cookie domain or path contains invalid attribute characters.
 */
export function setCookie(
  response: Response,
  name: string,
  value: string,
  options?: CookieOptions,
): Response {
  const next = cloneResponse(response);
  next.headers.append("set-cookie", serializeCookie(name, value, options));
  return next;
}

/**
 * Returns a clone of `response` with a `Set-Cookie` header that expires and clears `name`.
 * @throws {TypeError} If the cookie domain or path contains invalid attribute characters.
 */
export function clearCookie(
  response: Response,
  name: string,
  options: CookieOptions = {},
): Response {
  return setCookie(response, name, "", { ...options, expires: new Date(0), maxAge: 0 });
}

/**
 * Builds a `401`/`407` Problem Details response with a `WWW-Authenticate` (or
 * `Proxy-Authenticate` for `407`) challenge header.
 */
export function challenge(options: ChallengeOptions = {}): Response {
  const status = options.status ?? 401;
  const scheme = options.scheme ?? "Bearer";
  const realm = options.realm ? ` realm="${options.realm.replaceAll('"', '\\"')}"` : "";
  const headers = responseHeaders(options.init);
  headers.set(status === 407 ? "proxy-authenticate" : "www-authenticate", `${scheme}${realm}`);
  return problem(status, options.detail, { init: { ...options.init, headers } });
}
