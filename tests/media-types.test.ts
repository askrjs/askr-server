import { describe, expect, it } from "vitest";
import { accepts, contentType, explicitlyAccepts } from "../src/http";

describe("public media-type helpers", () => {
  it("should normalize content types without retaining parameters", () => {
    expect(contentType(" Text/HTML ; charset=utf-8")).toBe("text/html");
    expect(contentType("application/problem+json")).toBe("application/problem+json");
    expect(contentType(" ; charset=utf-8")).toBeUndefined();
    expect(contentType(null)).toBeUndefined();
  });

  it("should honor specificity and quality when matching accepted media types", () => {
    expect(accepts("text/*;q=0.5, text/html;q=0.8", "text/html")).toBe(true);
    expect(accepts("text/html;q=0, */*;q=1", "text/html")).toBe(false);
    expect(accepts("application/json", "text/html")).toBe(false);
  });

  it("should require an explicit media range when requested", () => {
    expect(explicitlyAccepts("application/json, text/html;q=0.5", "text/html")).toBe(true);
    expect(explicitlyAccepts("text/*", "text/html")).toBe(false);
    expect(explicitlyAccepts("text/html;q=0", "text/html")).toBe(false);
  });
});
