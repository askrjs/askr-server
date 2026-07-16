import type {
  ChallengeOptions,
  CookieOptions,
  JsonValue,
  Problem,
  ProblemOptions,
} from "../contracts";
import { cloneResponse, copyHeaders } from "./headers";

function responseHeaders(init: ResponseInit | undefined, contentType?: string): Headers {
  const headers = copyHeaders(init?.headers);
  if (contentType && !headers.has("content-type")) headers.set("content-type", contentType);
  return headers;
}

export function json(value: JsonValue, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: responseHeaders(init, "application/json; charset=utf-8"),
  });
}

export function text(value: string, init?: ResponseInit): Response {
  return new Response(value, {
    ...init,
    headers: responseHeaders(init, "text/plain; charset=utf-8"),
  });
}

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
  return new Response(JSON.stringify(value), {
    ...init,
    status,
    headers: responseHeaders(init, "application/problem+json"),
  });
}

function withStatus(status: number, value?: JsonValue, init?: ResponseInit): Response {
  return value === undefined
    ? new Response(null, { ...init, status, headers: responseHeaders(init) })
    : json(value, { ...init, status });
}

function message(status: number, detail: string, init?: ResponseInit): Response {
  return problem(status, detail, { init });
}

export const ok = (value?: JsonValue, init?: ResponseInit) => withStatus(200, value, init);
export const created = (value?: JsonValue, init?: ResponseInit) => withStatus(201, value, init);
export const accepted = (value?: JsonValue, init?: ResponseInit) => withStatus(202, value, init);
export const noContent = (init?: ResponseInit) => withStatus(204, undefined, init);
export const badRequest = (detail = "Bad Request", init?: ResponseInit) =>
  message(400, detail, init);
export const bad = badRequest;
export const unauthorized = (detail = "Unauthorized", init?: ResponseInit) =>
  message(401, detail, init);
export const forbidden = (detail = "Forbidden", init?: ResponseInit) => message(403, detail, init);
export const notFound = (detail = "Not Found", init?: ResponseInit) => message(404, detail, init);
export const conflict = (detail = "Conflict", init?: ResponseInit) => message(409, detail, init);
export const unprocessableEntity = (detail = "Unprocessable Entity", init?: ResponseInit) =>
  message(422, detail, init);
export const tooManyRequests = (detail = "Too Many Requests", init?: ResponseInit) =>
  message(429, detail, init);
export const notImplemented = (detail = "Not Implemented", init?: ResponseInit) =>
  message(501, detail, init);
export const serviceUnavailable = (detail = "Service Unavailable", init?: ResponseInit) =>
  message(503, detail, init);
export const error = (status = 500, detail = "Internal Server Error", init?: ResponseInit) =>
  message(status, detail, init);
export const internalServerError = (detail = "Internal Server Error", init?: ResponseInit) =>
  error(500, detail, init);
export const serverError = internalServerError;

export function methodNotAllowed(
  allow?: string | readonly string[],
  init?: ResponseInit,
): Response {
  const headers = responseHeaders(init);
  if (allow) headers.set("allow", typeof allow === "string" ? allow : allow.join(", "));
  return problem(405, undefined, { init: { ...init, headers } });
}

function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.sameSite)
    parts.push(`SameSite=${options.sameSite[0].toUpperCase()}${options.sameSite.slice(1)}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

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

export function clearCookie(
  response: Response,
  name: string,
  options: CookieOptions = {},
): Response {
  return setCookie(response, name, "", { ...options, expires: new Date(0), maxAge: 0 });
}

export function challenge(options: ChallengeOptions = {}): Response {
  const status = options.status ?? 401;
  const scheme = options.scheme ?? "Bearer";
  const realm = options.realm ? ` realm="${options.realm.replaceAll('"', '\\"')}"` : "";
  const headers = responseHeaders(options.init);
  headers.set(status === 407 ? "proxy-authenticate" : "www-authenticate", `${scheme}${realm}`);
  return problem(status, options.detail, { init: { ...options.init, headers } });
}
