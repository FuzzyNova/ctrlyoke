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
   * @default 5
   */
  maxAttempts?: number;

  /**
   * Delay in milliseconds between attempts
   * Can be:
   * - A single number: Fixed delay between all attempts
   * - An array: Custom delays for each retry (index 0 = delay before 2nd attempt)
   *
   * @default [0, 50, 100, 150, 200]
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
 * - First attempt has no delay (immediate execution)
 * - Subsequent attempts wait according to the delays array
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
 *     maxAttempts: 5,
 *     delays: [0, 50, 100, 150, 200],
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
  operation: () => Promise<T | null | undefined>,
  options: RetryOptions = {}
): Promise<T | undefined> {
  const {
    maxAttempts = 5,
    delays = [0, 50, 100, 150, 200],
    onRetry,
  } = options;

  // Normalize delays to array
  // If delays is a number, create array with 0 for first attempt, then the delay for remaining attempts
  const delayArray = Array.isArray(delays)
    ? delays
    : [0, ...Array(maxAttempts - 1).fill(delays)];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Get delay for this attempt from delays array
    const delay = delayArray[attempt] || 0;

    // Wait before retry (skip wait on first attempt if delay is 0)
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Notify callback (if provided)
    if (onRetry) {
      onRetry(attempt + 1, maxAttempts, delay);
    }

    // Execute operation
    try {
      const result = await operation();

      // Success - return result
      if (result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
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
