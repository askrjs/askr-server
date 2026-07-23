import { describe, expect, it } from "vite-plus/test";
import { createCspNonce } from "../src/csp-nonce";
import { securityHeaders } from "../src/middleware/security-headers";
import type { ServerContext } from "../src/contracts";

const context = () => ({}) as ServerContext;

describe("CSP nonce", () => {
  it("should memoize 192-bit base64url values per request", () => {
    const nonce = createCspNonce();
    const first = context();
    const second = context();
    expect(nonce(first)).toBe(nonce(first));
    expect(nonce(second)).not.toBe(nonce(first));
    expect(Buffer.from(nonce(first), "base64url")).toHaveLength(24);
  });

  it("should support context-based and static CSP policies", async () => {
    const nonce = createCspNonce();
    const request = context();
    const dynamic = securityHeaders({
      contentSecurityPolicy: (ctx) => `style-src 'nonce-${nonce(ctx)}'`,
    });
    const response = await dynamic(request, async () => new Response("ok"));
    expect(response.headers.get("content-security-policy")).toBe(
      `style-src 'nonce-${nonce(request)}'`,
    );

    const fixed = securityHeaders({ contentSecurityPolicy: "default-src 'self'" });
    const fixedResponse = await fixed(context(), async () => new Response("ok"));
    expect(fixedResponse.headers.get("content-security-policy")).toBe("default-src 'self'");
  });
});
