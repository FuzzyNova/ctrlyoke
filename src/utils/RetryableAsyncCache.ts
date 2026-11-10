/**
 * Shares successful asynchronous work while allowing failed operations to retry.
 * Concurrent callers with the same key receive the same in-flight promise.
 */
export class RetryableAsyncCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  async getOrRun(key: string, operation: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      return cached;
    }

    const result = operation();
    this.entries.set(key, result);

    try {
      return await result;
    } catch (error) {
      if (this.entries.get(key) === result) {
        this.entries.delete(key);
      }
      throw error;
    }
  }
}
