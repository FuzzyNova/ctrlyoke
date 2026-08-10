import * as fs from "fs";
import * as path from "path";

const SNAPSHOT_POLL_INTERVAL_MS = 500;

export interface StatuslineSnapshotWatcherDeps<TSnapshot extends object> {
  snapshotPath: string;
  onSnapshot?: (snapshot: TSnapshot) => void;
}

/**
 * Provider-neutral watcher for a ctrlyoke statusline transport file.
 *
 * Providers own the statusline command and payload interpretation. This class
 * only owns the workspace-scoped file watcher, marker-based change detection,
 * serialized reads, and teardown.
 */
export class StatuslineSnapshotWatcher<TSnapshot extends object> {
  private readonly snapshotPath: string;
  private readonly snapshotDirectory: string;
  private readonly snapshotFileName: string;
  private readonly onSnapshot: ((snapshot: TSnapshot) => void) | undefined;
  private watcher?: fs.FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private readQueue = Promise.resolve();
  private stopped = false;
  private lastSnapshotMarker?: string;
  private latestSnapshot?: TSnapshot;

  constructor(deps: StatuslineSnapshotWatcherDeps<TSnapshot>) {
    this.snapshotPath = deps.snapshotPath;
    this.snapshotDirectory = path.dirname(deps.snapshotPath);
    this.snapshotFileName = path.basename(deps.snapshotPath);
    this.onSnapshot = deps.onSnapshot;

    this.startWatching();
    this.queueSnapshotRead();
  }

  getLatestSnapshot(): TSnapshot | undefined {
    return this.latestSnapshot;
  }

  async readLatestSnapshot(): Promise<TSnapshot | undefined> {
    this.queueSnapshotRead();
    await this.readQueue;
    return this.latestSnapshot;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private startWatching(): void {
    try {
      fs.mkdirSync(this.snapshotDirectory, { recursive: true });
      this.watcher = fs.watch(
        this.snapshotDirectory,
        (_eventType, fileName) => {
          if (
            this.stopped ||
            (fileName != null && fileName.toString() !== this.snapshotFileName)
          ) {
            return;
          }
          this.queueSnapshotRead();
        }
      );
      this.watcher.on("error", () => {
        // Polling remains active when a platform watcher becomes unreliable.
      });
    } catch {
      // Polling below still handles filesystems where fs.watch cannot start.
    }

    this.pollTimer = setInterval(
      () => this.queueSnapshotRead(),
      SNAPSHOT_POLL_INTERVAL_MS
    );
  }

  private queueSnapshotRead(): void {
    if (this.stopped) {
      return;
    }
    this.readQueue = this.readQueue
      .then(() => this.readSnapshot())
      .catch(() => {
        // Malformed or transient transport reads are provider-side best effort.
      });
  }

  private async readSnapshot(): Promise<void> {
    if (this.stopped) {
      return;
    }

    let snapshot: TSnapshot;
    try {
      const parsed: unknown = JSON.parse(
        await fs.promises.readFile(this.snapshotPath, "utf8")
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      snapshot = parsed as TSnapshot;
    } catch {
      return;
    }

    const marker = this.getSnapshotMarker(snapshot);
    if (!marker || marker === this.lastSnapshotMarker || this.stopped) {
      return;
    }

    this.lastSnapshotMarker = marker;
    this.latestSnapshot = snapshot;
    this.onSnapshot?.(snapshot);
  }

  private getSnapshotMarker(snapshot: TSnapshot): string | undefined {
    const metadata = (snapshot as { _ctrlyoke?: unknown })._ctrlyoke;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return undefined;
    }
    const sequence = this.asFiniteNumber(
      (metadata as { sequence?: unknown }).sequence
    );
    const writtenAt = this.asFiniteNumber(
      (metadata as { writtenAt?: unknown }).writtenAt
    );
    if (sequence === undefined && writtenAt === undefined) {
      return undefined;
    }
    return `${sequence ?? ""}:${writtenAt ?? ""}`;
  }

  private asFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }
}
