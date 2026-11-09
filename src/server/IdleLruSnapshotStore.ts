import { randomUUID } from "crypto";

export interface IdleLruSnapshotStoreOptions<
  T extends { lastAccessedAt: number },
> {
  ttlMs: number;
  maxCount: number;
  onEvict?: (snapshot: T) => void;
  refreshOnAccess?: (snapshot: T, now: number) => T;
}

/** An insertion-ordered snapshot store with idle expiry and least-recently-used eviction. */
export class IdleLruSnapshotStore<T extends { lastAccessedAt: number }> {
  private readonly snapshots = new Map<string, T>();

  constructor(private readonly options: IdleLruSnapshotStoreOptions<T>) {}

  createId(): string {
    let id = randomUUID();
    while (this.snapshots.has(id)) id = randomUUID();
    return id;
  }

  get(id: string, now = Date.now()): T | undefined {
    for (const [snapshotId, snapshot] of this.snapshots) {
      if (now - snapshot.lastAccessedAt >= this.options.ttlMs) {
        this.snapshots.delete(snapshotId);
        this.options.onEvict?.(snapshot);
      }
    }

    const snapshot = this.snapshots.get(id);
    if (!snapshot) return undefined;

    const refreshed = this.options.refreshOnAccess
      ? this.options.refreshOnAccess(snapshot, now)
      : Object.assign(snapshot, { lastAccessedAt: now });
    this.snapshots.delete(id);
    this.snapshots.set(id, refreshed);
    return refreshed;
  }

  set(id: string, snapshot: T): void {
    this.snapshots.set(id, snapshot);
    while (this.snapshots.size > this.options.maxCount) {
      const oldestId = this.snapshots.keys().next().value;
      if (oldestId === undefined) return;
      const oldest = this.snapshots.get(oldestId);
      this.snapshots.delete(oldestId);
      if (oldest) this.options.onEvict?.(oldest);
    }
  }

  delete(id: string): boolean {
    return this.snapshots.delete(id);
  }

  clear(): void {
    this.snapshots.clear();
  }

  values(): IterableIterator<T> {
    return this.snapshots.values();
  }
}
