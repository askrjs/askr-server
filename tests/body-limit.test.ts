import { describe, expect, it, vi } from "vitest";
import { PayloadTooLargeError, readRequestBytes } from "../src/body-limit";

describe("request body limits", () => {
  it("should handle a cached body rejection before a caller awaits it", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const request = new Request("https://example.test/upload", {
        method: "POST",
        body: "too large",
      });

      const pending = readRequestBytes(request, 1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
      await expect(pending).rejects.toBeInstanceOf(PayloadTooLargeError);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
