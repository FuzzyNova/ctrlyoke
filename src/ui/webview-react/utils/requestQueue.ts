/** Shared immutable FIFO operations for transient user-interaction requests. */
export function enqueueRequest<T>(queue: readonly T[], request: T): T[] {
  return [...queue, request];
}

export function dequeueRequest<T>(queue: readonly T[]): T[] {
  return queue.slice(1);
}
