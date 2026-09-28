/** Serializes async read-modify-write operations while keeping the queue usable after a failure. */
export class AsyncWriteQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = this.tail.then(write);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
