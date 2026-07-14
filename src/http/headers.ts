export function copyHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (init instanceof Headers && typeof init.getSetCookie === "function") {
    const cookies = init.getSetCookie();
    if (cookies.length) {
      headers.delete("set-cookie");
      for (const cookie of cookies) headers.append("set-cookie", cookie);
    }
  }
  return headers;
}

export function cloneResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: copyHeaders(response.headers),
  });
}

export function addHeaders(response: Response, additions: HeadersInit): Response {
  const next = cloneResponse(response);
  new Headers(additions).forEach((value, key) => next.headers.set(key, value));
  return next;
}
