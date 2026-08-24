import { describe, expect, it } from "vitest";
import type { ApiRoute } from "../src/contracts";
import { createMatcher } from "../src/router/matcher";

const route = (path: string, method: string, label: string): ApiRoute => ({
  path,
  method,
  handler: () => new Response(label),
});

describe("compiled route matcher", () => {
  it("should prefer static then parameter then wildcard routes", () => {
    const wildcard = route("/objects/{*key}", "GET", "wildcard");
    const parameter = route("/objects/{id}", "GET", "parameter");
    const exact = route("/objects/current", "GET", "exact");
    const matcher = createMatcher([wildcard, parameter, exact]);

    expect(matcher.match("/objects/current", "GET").match?.route).toBe(exact);
    expect(matcher.match("/objects/42", "GET").match).toMatchObject({
      route: parameter,
      params: { id: "42" },
    });
    expect(matcher.match("/objects/a/b", "GET").match).toMatchObject({
      route: wildcard,
      params: { key: "a/b" },
    });
  });

  it("should defer an empty nested wildcard behind an exact parameter leaf", () => {
    const wildcard = route("/files/{category}/{*rest}", "GET", "wildcard");
    const exact = route("/files/{category}", "GET", "exact");
    const matcher = createMatcher([wildcard, exact]);

    expect(matcher.match("/files/docs", "GET").match).toMatchObject({
      route: exact,
      params: { category: "docs" },
    });
    expect(matcher.match("/files/docs/readme", "GET").match).toMatchObject({
      route: wildcard,
      params: { category: "docs", rest: "readme" },
    });
  });

  it("should aggregate allowed methods across every matching path shape", () => {
    const matcher = createMatcher([
      route("/items/fixed", "GET", "get"),
      route("/items/{id}", "PURGE", "purge"),
      route("/items/{*path}", "POST", "post"),
    ]);

    expect(matcher.match("/items/fixed", "DELETE")).toEqual({
      allowed: ["GET", "HEAD", "PURGE", "POST"],
    });
  });

  it.each([
    ["/", true],
    ["/items", true],
    ["/items/", true],
    ["//", false],
    ["/items//current", false],
    ["items", false],
  ] as const)("should preserve request path boundaries for %s", (path, matched) => {
    const matcher = createMatcher([route("/", "GET", "root"), route("/items", "GET", "items")]);
    expect(Boolean(matcher.match(path, "GET").match)).toBe(matched);
  });
});
