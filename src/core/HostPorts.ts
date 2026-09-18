import type { HarnessStatus } from "./HarnessIntegration";
import type { QueueState } from "../types/CtrlYokeTypes";

export interface HarnessDetailedStatus {
  initializationStatus: HarnessStatus;
  isReady: boolean;
  message: string;
  pollingAttempts?: number;
  maxPollingAttempts?: number;
}

/** A host-owned lifetime handle. */
export interface Disposable {
  dispose(): void;
}

/** A host-owned collection to which shared services can register lifetimes. */
export interface DisposableRegistry {
  add(disposable: Disposable): void;
}

/** Minimal asynchronous key/value storage used by shared orchestration code. */
export interface KeyValueStore {
  update(key: string, value: unknown): Promise<void>;
}

/** Optional host chrome for workflow status and queue context state. */
export interface StatusBarSink {
  updateStatusBar(
    state?: QueueState,
    harnessStatus?: HarnessDetailedStatus
  ): void;
  setHasQueuedStepsContext(hasQueuedSteps: boolean): void;
}

/** Host-neutral file watcher events, normalized to absolute string paths. */
export interface FileWatcher {
  onDidCreate(listener: (filePath: string) => void): Disposable;
  onDidChange(listener: (filePath: string) => void): Disposable;
  onDidDelete(listener: (filePath: string) => void): Disposable;
  dispose(): void;
}

/** Creates host-neutral file watchers rooted at an absolute base path. */
export interface FileWatcherFactory {
  create(basePath: string, glob: string): FileWatcher;
}
