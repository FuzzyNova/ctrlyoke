import type { HarnessStatus } from "./HarnessIntegration";
import type { QueueState } from "../types/CtrlYokeTypes";

export interface HarnessDetailedStatus {
  initializationStatus: HarnessStatus;
  isReady: boolean;
  message: string;
  pollingAttempts?: number;
  maxPollingAttempts?: number;
}

/** A host-owned collection to which shared services can register lifetimes. */
export interface DisposableRegistry {
  add(disposable: { dispose(): void }): void;
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
