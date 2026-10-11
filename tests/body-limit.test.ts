import { describe, expect, it, vi } from "vite-plus/test";
import { PayloadTooLargeError, readRequestBytes } from "../src/body-limit";

describe("request body limits", () => {
  it("should handle a cached rejection on a repeated read before a caller awaits it", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let repeated: Promise<Uint8Array> | undefined;
    try {
      const request = new Request("https://example.test/upload", {
        method: "POST",
        body: "too large",
      });
      await expect(readRequestBytes(request, 1)).rejects.toBeInstanceOf(PayloadTooLargeError);
      repeated = readRequestBytes(request, 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(repeated).rejects.toBeInstanceOf(PayloadTooLargeError);
    } finally {
      await repeated?.catch(() => undefined);
      process.off("unhandledRejection", unhandled);
    }
  });

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
