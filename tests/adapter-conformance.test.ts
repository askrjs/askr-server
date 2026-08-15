import { describe, expect, it, vi } from "vitest";
import {
  AdapterConformanceError,
  runAdapterConformance,
  type AdapterConformanceExercises,
} from "../src/testing/index";

function exercises(
  overrides: Partial<AdapterConformanceExercises> = {},
): AdapterConformanceExercises {
  return {
    async abortStreamingResponse(response) {
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel("client disconnected");
    },
    async enforceRequestTimeout() {},
    ...overrides,
  };
}

describe("adapter conformance runner", () => {
  it("should verify cancellation and timeout exercises exactly once", async () => {
    const abortStreamingResponse = vi.fn(exercises().abortStreamingResponse);
    const enforceRequestTimeout = vi.fn(exercises().enforceRequestTimeout);

    const report = await runAdapterConformance({
      abortStreamingResponse,
      enforceRequestTimeout,
    });

    expect(report).toEqual({
      streamingResponseCancellation: "passed",
      incompleteRequestTimeout: "passed",
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(abortStreamingResponse).toHaveBeenCalledOnce();
    expect(enforceRequestTimeout).toHaveBeenCalledOnce();
  });

  it.each([
    [undefined, "exercises"],
    [{ enforceRequestTimeout: async () => undefined }, "abortStreamingResponse"],
    [{ abortStreamingResponse: async () => undefined }, "enforceRequestTimeout"],
  ])("should reject invalid exercise input %# synchronously", (value, message) => {
    expect(() => runAdapterConformance(value as AdapterConformanceExercises)).toThrow(message);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "should reject invalid deadline %s synchronously",
    (deadlineMs) => {
      expect(() => runAdapterConformance(exercises(), { deadlineMs })).toThrow(/deadlineMs/);
    },
  );

  it("should diagnose an exercise that returns without cancelling the response body", async () => {
    await expect(
      runAdapterConformance(
        exercises({
          async abortStreamingResponse(response) {
            const reader = response.body!.getReader();
            await reader.read();
            reader.releaseLock();
          },
        }),
        { deadlineMs: 10 },
      ),
    ).rejects.toMatchObject({
      name: "AdapterConformanceError",
      code: "STREAM_CANCELLATION_TIMEOUT",
    });
  });

  it("should diagnose a timeout exercise that hangs and signal cleanup", async () => {
    let cleanupSignalled = false;
    await expect(
      runAdapterConformance(
        exercises({
          enforceRequestTimeout(_app, signal) {
            return new Promise<void>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  cleanupSignalled = true;
                  resolve();
                },
                { once: true },
              );
            });
          },
        }),
        { deadlineMs: 10 },
      ),
    ).rejects.toMatchObject({
      name: "AdapterConformanceError",
      code: "REQUEST_TIMEOUT_ENFORCEMENT_TIMEOUT",
    });
    expect(cleanupSignalled).toBe(true);
  });

  it("should preserve a thrown exercise as a stable conformance diagnostic", async () => {
    const failure = new Error("adapter failed");
    await expect(
      runAdapterConformance(
        exercises({
          abortStreamingResponse: async () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "AdapterConformanceError",
      code: "STREAM_EXERCISE_FAILED",
      cause: failure,
    });
    expect(AdapterConformanceError).toBeTypeOf("function");
  });
});
