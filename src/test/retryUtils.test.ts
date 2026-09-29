import * as assert from "assert";
import {
  retryWithBackoff,
  PermanentFailureError,
  stopRetrying,
} from "../utils/RetryUtils";

/**
 * Unit tests for RetryUtils
 *
 * Tests retry logic with exponential backoff, including:
 * - Successful retries
 * - Exhausted retries
 * - Permanent failures
 * - Custom delays
 * - Retry callbacks
 */

suite("RetryUtils", () => {
  suite("retryWithBackoff", () => {
    test("should return result on first successful attempt", async () => {
      let attempts = 0;
      const result = await retryWithBackoff(async () => {
        attempts++;
        return "success";
      });

      assert.strictEqual(result, "success");
      assert.strictEqual(attempts, 1);
    });

    test("should retry until success", async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts < 3) {
            return null; // Fail first 2 attempts
          }
          return "success";
        },
        { maxAttempts: 5, delays: [0, 10, 10, 10, 10] }
      );

      assert.strictEqual(result, "success");
      assert.strictEqual(attempts, 3);
    });

    test("should return undefined after exhausting retries", async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          return null; // Always fail
        },
        { maxAttempts: 3, delays: [0, 10, 10] }
      );

      assert.strictEqual(result, undefined);
      assert.strictEqual(attempts, 3);
    });

    test("should handle errors and continue retrying", async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error("Temporary failure");
          }
          return "success";
        },
        { maxAttempts: 5, delays: [0, 10, 10, 10, 10] }
      );

      assert.strictEqual(result, "success");
      assert.strictEqual(attempts, 3);
    });

    test("should stop immediately on PermanentFailureError", async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts === 2) {
            throw new PermanentFailureError("Cannot continue");
          }
          return null; // Fail first attempt
        },
        { maxAttempts: 5, delays: [0, 10, 10, 10, 10] }
      );

      assert.strictEqual(result, undefined);
      assert.strictEqual(attempts, 2); // Should stop at attempt 2
    });

    test("should stop and propagate the original non-retryable error", async () => {
      let attempts = 0;
      const originalError = new Error("CLI executable was not found");

      await assert.rejects(
        retryWithBackoff(
          async () => {
            attempts++;
            stopRetrying(originalError);
          },
          { maxAttempts: 4, delays: [0, 10, 10] }
        ),
        (error: unknown) => error === originalError
      );

      assert.strictEqual(attempts, 1);
    });

    test("should keep retrying file-lock errors when the caller marks them transient", async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          try {
            if (attempts === 1) {
              throw new Error("being used by another process");
            }
            return "success";
          } catch (error) {
            if (String(error).includes("being used by another process")) {
              return null;
            }
            stopRetrying(error);
          }
        },
        { maxAttempts: 4, delays: [0, 0, 0] }
      );

      assert.strictEqual(result, "success");
      assert.strictEqual(attempts, 2);
    });

    test("should use custom delays array", async () => {
      const delays: number[] = [];
      let attempts = 0;

      await retryWithBackoff(
        async () => {
          attempts++;
          return null; // Always fail to test all delays
        },
        {
          maxAttempts: 4,
          delays: [0, 100, 200, 300],
          onRetry: (_attempt, _max, delay) => {
            delays.push(delay);
          },
        }
      );

      assert.strictEqual(attempts, 4);
      // First attempt is always 0, then uses delays[0], delays[1], delays[2]
      assert.deepStrictEqual(delays, [0, 0, 100, 200]);
    });

    test("should use fixed delay when number is provided", async () => {
      const delays: number[] = [];
      let attempts = 0;

      await retryWithBackoff(
        async () => {
          attempts++;
          return null; // Always fail
        },
        {
          maxAttempts: 3,
          delays: 50, // Fixed delay
          onRetry: (_attempt, _max, delay) => {
            delays.push(delay);
          },
        }
      );

      assert.strictEqual(attempts, 3);
      assert.deepStrictEqual(delays, [0, 50, 50]); // First attempt always has 0 delay
    });

    test("should call onRetry callback with correct parameters", async () => {
      const retryLog: Array<{
        attempt: number;
        max: number;
        delay: number;
      }> = [];

      await retryWithBackoff(
        async () => null, // Always fail
        {
          maxAttempts: 3,
          delays: [0, 10, 20],
          onRetry: (attempt, max, delay) => {
            retryLog.push({ attempt, max, delay });
          },
        }
      );

      assert.strictEqual(retryLog.length, 3);
      // First attempt always 0, then uses delays[0], delays[1]
      assert.deepStrictEqual(retryLog, [
        { attempt: 1, max: 3, delay: 0 },
        { attempt: 2, max: 3, delay: 0 },
        { attempt: 3, max: 3, delay: 10 },
      ]);
    });

    test("should handle undefined return values", async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          return undefined; // Treat as failure
        },
        { maxAttempts: 5, delays: [0, 10, 10, 10, 10] }
      );

      assert.strictEqual(result, undefined);
      assert.strictEqual(attempts, 5);
    });

    test("should treat empty string as success (neither null nor undefined)", async () => {
      let attempts = 0;
      const result = await retryWithBackoff(async () => {
        attempts++;
        if (attempts < 2) {
          return null; // Fail first attempt
        }
        return ""; // Empty string is neither null nor undefined, so retryWithBackoff returns it as a valid result
      });

      assert.strictEqual(result, "");
      assert.strictEqual(attempts, 2);
    });

    test("should use default options when not provided", async () => {
      let attempts = 0;
      const result = await retryWithBackoff(async () => {
        attempts++;
        if (attempts < 3) {
          return null;
        }
        return "success";
      });

      assert.strictEqual(result, "success");
      assert.strictEqual(attempts, 3);
    });

    test("should handle async operations that take time", async () => {
      let attempts = 0;
      const startTime = Date.now();

      const result = await retryWithBackoff(
        async () => {
          attempts++;
          await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate async work
          if (attempts < 2) {
            return null;
          }
          return "success";
        },
        { maxAttempts: 3, delays: [0, 5, 5] }
      );

      const elapsed = Date.now() - startTime;

      assert.strictEqual(result, "success");
      assert.strictEqual(attempts, 2);
      assert.ok(elapsed >= 15); // At least 10ms work + 5ms delay
    });

    test("should handle zero delay", async () => {
      let attempts = 0;
      const delays: number[] = [];

      await retryWithBackoff(
        async () => {
          attempts++;
          return null;
        },
        {
          maxAttempts: 2,
          delays: [0, 0],
          onRetry: (_attempt, _max, delay) => {
            delays.push(delay);
          },
        }
      );

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(delays, [0, 0]);
    });

    test("should not start when the abort signal is already aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();
      let attempts = 0;

      const result = await retryWithBackoff(
        async (signal) => {
          attempts++;
          assert.strictEqual(signal, abortController.signal);
          return "unexpected";
        },
        { signal: abortController.signal }
      );

      assert.strictEqual(result, undefined);
      assert.strictEqual(attempts, 0);
    });

    test("should interrupt an active backoff delay when aborted", async () => {
      const abortController = new AbortController();
      let attempts = 0;
      const startTime = Date.now();

      const result = await retryWithBackoff(
        async (signal) => {
          attempts++;
          assert.strictEqual(signal, abortController.signal);
          setTimeout(() => abortController.abort(), 10);
          return null;
        },
        {
          maxAttempts: 60,
          delays: 10_000,
          signal: abortController.signal,
        }
      );

      assert.strictEqual(result, undefined);
      assert.strictEqual(attempts, 1);
      // Generous against the 10s backoff it must *not* wait out: the margin is
      // what keeps this measuring the abort rather than the host's scheduler
      // under full-suite load.
      assert.ok(
        Date.now() - startTime < 5_000,
        "abort should end the active backoff without waiting for its timer"
      );
    });
  });

  suite("PermanentFailureError", () => {
    test("should be instanceof Error", () => {
      const error = new PermanentFailureError("test");
      assert.ok(error instanceof Error);
      assert.ok(error instanceof PermanentFailureError);
    });

    test("should have correct name property", () => {
      const error = new PermanentFailureError("test");
      assert.strictEqual(error.name, "PermanentFailureError");
    });

    test("should preserve error message", () => {
      const error = new PermanentFailureError("Custom error message");
      assert.strictEqual(error.message, "Custom error message");
    });
  });

  suite("Real-world scenarios", () => {
    test("should simulate waiting for file creation", async () => {
      let fileExists = false;
      let attempts = 0;

      // Simulate file being created after 3 attempts
      setTimeout(() => {
        fileExists = true;
      }, 25);

      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (fileExists) {
            return "/path/to/file.log";
          }
          return null;
        },
        {
          maxAttempts: 5,
          delays: [0, 10, 20, 30, 40],
        }
      );

      assert.strictEqual(result, "/path/to/file.log");
      assert.ok(attempts >= 2); // Should take at least 2 attempts
    });

    test("should handle permanent failure correctly", async () => {
      let attempts = 0;

      const result = await retryWithBackoff(
        async () => {
          attempts++;
          // Simulate a permanent failure on second attempt
          if (attempts === 2) {
            throw new PermanentFailureError("Unrecoverable error");
          }
          return null; // Fail to trigger retry
        },
        {
          maxAttempts: 5,
          delays: [0, 10, 20, 30, 40],
        }
      );

      assert.strictEqual(result, undefined);
      assert.strictEqual(attempts, 2); // Should stop at second attempt
    });
  });
});
