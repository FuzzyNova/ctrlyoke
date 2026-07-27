/**
 * Retry utility for operations that may need multiple attempts with backoff
 *
 * Common use cases:
 * - Waiting for files to be created (CLI log files)
 * - Polling for resources that may not be immediately available
 * - Network requests with transient failures
 */

/**
 * Error class to signal permanent failure (stops retries immediately)
 *
 * Throw this error from your operation to indicate that retrying won't help
 * and the operation should fail immediately.
 *
 * @example
 * ```typescript
 * await retryWithBackoff(async () => {
 *   if (fileExistsButCorrupted()) {
 *     throw new PermanentFailureError("File is corrupted");
 *   }
 *   return checkCondition();
 * });
 * ```
 */
export class PermanentFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentFailureError";
  }
}

/**
 * Options for retry with backoff
 */
export interface RetryOptions {
  /**
   * Maximum number of attempts (including the initial attempt)
   * @default 60
   */
  maxAttempts?: number;

  /**
   * Delay in milliseconds between retry attempts (after the first attempt)
   * Can be:
   * - A single number: Fixed delay between all retries
   * - An array: Custom delays for each retry. If array is shorter than maxAttempts,
   *   the last delay value is repeated for remaining attempts.
   *
   * Note: First attempt is always immediate (no delay).
   *
   * @default [0, 100, 200, 300, 500, 1000] (total ~10s with maxAttempts=15)
   *
   * @example
   * ```typescript
   * // With maxAttempts=15 and delays=[50, 100, 1000]:
   * // Attempt 1: immediate
   * // Attempt 2: wait 50ms
   * // Attempt 3: wait 100ms
   * // Attempts 4-15: wait 1000ms (last value repeats)
   * ```
   */
  delays?: number | number[];

  /**
   * Optional callback called before each retry attempt
   * Useful for logging or debugging
   *
   * @param attempt - Current attempt number (1-indexed)
   * @param maxAttempts - Total number of attempts
   * @param delay - Delay in ms before this attempt (0 for first attempt)
   */
  onRetry?: (attempt: number, maxAttempts: number, delay: number) => void;

  /**
   * Optional cancellation signal.
   *
   * When aborted, retrying stops and the function returns undefined. Backoff
   * delays are interrupted immediately. The signal is also passed to the
   * operation so callers can cancel any operation-specific async work.
   */
  signal?: AbortSignal;
}

async function waitForRetryDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return true;
  }

  if (signal.aborted) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const finish = (completed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      signal.removeEventListener("abort", handleAbort);
      resolve(completed);
    };

    const handleAbort = () => finish(false);

    signal.addEventListener("abort", handleAbort, { once: true });
    timeoutHandle = setTimeout(() => finish(true), delayMs);

    // Guard the narrow race between the initial check and listener setup.
    if (signal.aborted) {
      handleAbort();
    }
  });
}

/**
 * Retry an async operation with exponential backoff
 *
 * @param operation - Async function to retry. Should return a truthy value on success, falsy on failure.
 * @param options - Retry configuration options
 * @returns The result from the operation if successful, or undefined if all retries exhausted
 *
 * @remarks
 * **Retry Strategy:**
 * - First attempt is always immediate (no delay)
 * - Subsequent attempts wait according to the delays array
 * - If delays array is shorter than needed, the last delay value repeats
 * - If operation returns truthy value, retries stop and value is returned
 * - If all attempts fail, returns undefined
 *
 * **Use Cases:**
 * - **File creation timing**: Wait for CLI to create log files
 * - **Resource polling**: Wait for resources to become available
 * - **Transient failures**: Retry operations that may fail temporarily
 *
 * @example
 * ```typescript
 * // Wait for a file to be created with custom delays
 * const filePath = await retryWithBackoff(
 *   async () => {
 *     if (fs.existsSync(logPath)) {
 *       return logPath;
 *     }
 *     return null;
 *   },
 *   {
 *     onRetry: (attempt, max, delay) => {
 *       console.log(`Attempt ${attempt}/${max} (delay: ${delay}ms)`);
 *     }
 *   }
 * );
 * ```
 *
 * @example
 * ```typescript
 * // Fixed delay between retries
 * const result = await retryWithBackoff(
 *   async () => checkCondition(),
 *   { maxAttempts: 3, delays: 100 }
 * );
 * ```
 */
export async function retryWithBackoff<T>(
  operation: (signal?: AbortSignal) => Promise<T | null | undefined>,
  options: RetryOptions = {}
): Promise<T | undefined> {
  const {
    maxAttempts = 60,
    delays = [100, 200, 500, 1000, 1500],
    onRetry,
    signal,
  } = options;

  // Normalize delays to array
  // If delays is a number, create array filled with that delay
  const delayArray = Array.isArray(delays)
    ? delays
    : Array(maxAttempts - 1).fill(delays);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      return undefined;
    }

    // First attempt is always immediate (0 delay)
    // Subsequent attempts use delays array, repeating last value if array is too short
    let delay = 0;
    if (attempt > 0 && delayArray.length > 0) {
      const delayIndex = attempt - 1;
      // Use delay at index, or repeat last value if we've exceeded array length
      delay = delayArray[Math.min(delayIndex, delayArray.length - 1)];
    }

    // Wait before retry (skip wait on first attempt)
    if (delay > 0) {
      const delayCompleted = await waitForRetryDelay(delay, signal);
      if (!delayCompleted) {
        return undefined;
      }
    }

    if (signal?.aborted) {
      return undefined;
    }

    // Notify callback (if provided)
    if (onRetry) {
      onRetry(attempt + 1, maxAttempts, delay);
    }

    if (signal?.aborted) {
      return undefined;
    }

    // Execute operation
    try {
      const result = await operation(signal);

      if (signal?.aborted) {
        return undefined;
      }

      // Success - return result
      if (result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      if (signal?.aborted) {
        return undefined;
      }

      // Check if this is a permanent failure (stop retrying immediately)
      if (error instanceof PermanentFailureError) {
        return undefined;
      }
      // Other errors: continue to next retry
      // (Caller can handle errors by catching them in the operation function)
    }
  }

  // All attempts exhausted
  return undefined;
}
