import { EventEmitter } from "events";
import type * as fs from "fs";

/** fs.FSWatcher-compatible handle backed by a polling interval. */
export class PollingFsWatcher extends EventEmitter implements fs.FSWatcher {
  private closed = false;

  constructor(private readonly interval: NodeJS.Timeout) {
    super();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.interval);
    this.emit("close");
  }

  ref(): this {
    this.interval.ref();
    return this;
  }

  unref(): this {
    this.interval.unref();
    return this;
  }
}

/** One fs.FSWatcher-compatible close lifecycle spanning several watchers. */
export class CompositeFsWatcher extends EventEmitter implements fs.FSWatcher {
  private closed = false;

  constructor(private readonly watchers: readonly fs.FSWatcher[]) {
    super();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.emit("close");
  }

  ref(): this {
    for (const watcher of this.watchers) {
      watcher.ref();
    }
    return this;
  }

  unref(): this {
    for (const watcher of this.watchers) {
      watcher.unref();
    }
    return this;
  }
}
