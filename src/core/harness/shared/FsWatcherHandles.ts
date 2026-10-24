import { EventEmitter } from "events";
import type * as fs from "fs";

/** fs.FSWatcher-compatible handle backed by a polling timer. */
export class PollingFsWatcher extends EventEmitter implements fs.FSWatcher {
  private closed = false;
  private readonly closePoll: () => void;
  private readonly timer?: NodeJS.Timeout;

  constructor(timerOrClose: NodeJS.Timeout | (() => void)) {
    super();
    if (typeof timerOrClose === "function") {
      this.closePoll = timerOrClose;
    } else {
      this.timer = timerOrClose;
      this.closePoll = () => clearInterval(timerOrClose);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closePoll();
    this.emit("close");
  }

  ref(): this {
    this.timer?.ref();
    return this;
  }

  unref(): this {
    this.timer?.unref();
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
