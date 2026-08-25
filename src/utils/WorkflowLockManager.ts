import * as fs from "fs";
import * as path from "path";
import {
  WorkflowRunnerLock,
  type RunRef,
  type WorkflowKey,
} from "../types/CtrlYokeTypes";
import {
  LOCK_STATUS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PROMPT_TERMINAL_STATUS,
  STEP_STATUS,
} from "../types/DashboardConstants";
import type { LockStatus } from "../types/DashboardConstants";
import { Log } from "./Log";
import * as WorkflowPaths from "./WorkflowPaths";
import { inspectWorkflowLock, readWorkflowLock } from "./WorkflowLockInspector";
import { withFileLock } from "./FileLockUtils";
import { generateOwnerToken, isOwnerStale } from "./LockSafetyPrimitives";

export {
  HEARTBEAT_INTERVAL_MS,
  STALE_HEARTBEAT_MS,
} from "./LockSafetyPrimitives";

export type { LockStatus };

const ACQUIRE_TIMEOUT_MS = 5_000;
const ACQUIRE_RETRY_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WorkflowLockManager
 *
 * Exclusive, owner-token-safe runner-lock CRUD for workflow process coordination.
 * Lock files live in run storage at `<workflowKey>/runner.json` — one per lineage, naming
 * the exact `RunRef` currently executing (never merely the viewed run).
 *
 * Acquire is a true `fs.open(path, "wx")` exclusive create (mirroring `FileLockUtils`),
 * with a bounded retry against a stale owner. Heartbeat and release both read the lock
 * first and compare `ownerToken` before writing/deleting, so a stale process can never
 * refresh or unlink a successor's lock.
 */
export class WorkflowLockManager {
  static getLockPath(workspaceRoot: string, workflowKey: WorkflowKey): string {
    return WorkflowPaths.runnerLockPath(workspaceRoot, workflowKey);
  }

  /** Generates a fresh per-acquire ownership token. */
  static generateOwnerToken(): string {
    return generateOwnerToken();
  }

  /**
   * Exclusively acquires the lineage's runner lock. Retries for up to
   * `ACQUIRE_TIMEOUT_MS` if the existing lock is stale (dead PID or heartbeat older
   * than 30s); throws if a live owner holds it or the timeout elapses.
   */
  static async acquireLock(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    lock: WorkflowRunnerLock
  ): Promise<void> {
    const lockPath = WorkflowLockManager.getLockPath(
      workspaceRoot,
      workflowKey
    );
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    await withFileLock(lockPath, async () => {
      const content = JSON.stringify(lock, null, 2);
      const startTime = Date.now();

      while (Date.now() - startTime < ACQUIRE_TIMEOUT_MS) {
        try {
          const handle = await fs.promises.open(lockPath, "wx");
          try {
            await handle.writeFile(content, "utf8");
          } finally {
            await handle.close();
          }
          Log.debug(
            `[WorkflowLockManager] acquireLock: ${workflowKey} → ${lock.runRef}`
          );
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }

          const existing = await WorkflowLockManager.readLock(
            workspaceRoot,
            workflowKey
          );
          const stale =
            !existing || isOwnerStale(existing.pid, existing.lastHeartbeat);

          if (stale) {
            await fs.promises.unlink(lockPath).catch((unlinkError) => {
              if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
                throw unlinkError;
              }
            });
            continue;
          }

          await sleep(ACQUIRE_RETRY_DELAY_MS);
        }
      }

      throw new Error(
        `Timed out waiting for runner lock: ${workflowKey} (held by a live owner)`
      );
    });
  }

  /**
   * Release a lock, but only if `ownerToken` matches the current holder — a stale
   * process can never unlink a successor's lock. Swallows ENOENT (already gone).
   */
  static async releaseLock(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    ownerToken: string
  ): Promise<void> {
    const lockPath = WorkflowLockManager.getLockPath(
      workspaceRoot,
      workflowKey
    );
    try {
      await withFileLock(lockPath, async () => {
        const existing = await WorkflowLockManager.readLock(
          workspaceRoot,
          workflowKey
        );
        if (!existing) return;
        if (existing.ownerToken !== ownerToken) {
          Log.warn(
            `[WorkflowLockManager] releaseLock: ownerToken mismatch for ${workflowKey} — refusing to release a successor's lock`
          );
          return;
        }
        await fs.promises.unlink(lockPath);
        Log.debug(`[WorkflowLockManager] releaseLock: ${workflowKey}`);
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        Log.warn(
          `[WorkflowLockManager] releaseLock: failed to delete ${workflowKey}:`,
          err
        );
      }
    }
  }

  /**
   * Update the heartbeat timestamp, but only if `ownerToken` matches the current
   * holder. No-ops silently if the lock file is gone (ENOENT) or owned by someone else.
   */
  static async updateHeartbeat(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    ownerToken: string
  ): Promise<void> {
    const lockPath = WorkflowLockManager.getLockPath(
      workspaceRoot,
      workflowKey
    );
    try {
      await withFileLock(lockPath, async () => {
        const existing = await WorkflowLockManager.readLock(
          workspaceRoot,
          workflowKey
        );
        if (!existing) return;
        if (existing.ownerToken !== ownerToken) {
          Log.warn(
            `[WorkflowLockManager] updateHeartbeat: ownerToken mismatch for ${workflowKey} — refusing to touch a successor's lock`
          );
          return;
        }
        const updated: WorkflowRunnerLock = {
          ...existing,
          lastHeartbeat: Date.now(),
        };
        const tmpPath = `${lockPath}.${ownerToken}.tmp`;
        await fs.promises.writeFile(
          tmpPath,
          JSON.stringify(updated, null, 2),
          "utf8"
        );
        await fs.promises.rename(tmpPath, lockPath);
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        Log.warn(
          `[WorkflowLockManager] updateHeartbeat: failed for ${workflowKey}:`,
          err
        );
      }
    }
  }

  /**
   * Read the raw lock data for a lineage.
   * Returns null if the lock file does not exist or cannot be parsed.
   */
  static async readLock(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<WorkflowRunnerLock | null> {
    return readWorkflowLock(workspaceRoot, workflowKey);
  }

  /**
   * Check the status of the lock for a lineage.
   *
   * Returns:
   *   "none"          — no lock file or parse error
   *   "stale"         — lock exists but PID is dead OR heartbeat is older than 30s
   *   "active-vscode" — live VS Code Extension Host holds the lock
   *   "active-cli"    — live CLI process holds the lock
   */
  static async checkLock(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<LockStatus> {
    return inspectWorkflowLock(workspaceRoot, workflowKey);
  }

  /**
   * Normalize stale locks on extension startup.
   *
 * Scans every lineage directory under run storage. For each lineage whose
 * locked `RunRef`'s `_runtime.executionState` is active (running/pausing/cancelling):
 *   - "none" or "stale" lock  → writes "stopped" to that run's `_runtime.executionState`,
 *     cleans up any stale lock file
 *   - "active-vscode"         → preserves the live VS Code-owned run and lock
 *   - "active-cli"            → preserves RUNNING; returns this lineage as CLI-managed
   *
   * Returns the exact run file paths recovered/still-active, keyed by lineage.
   */
  static async normalizeStaleLocks(
    workspaceRoot: string,
    workflowKeys: WorkflowKey[]
  ): Promise<{
    activeCliRunFiles: string[];
    recoveredRunFiles: string[];
  }> {
    const activeCli: string[] = [];
    const recoveredRunFiles: string[] = [];

    for (const workflowKey of workflowKeys) {
      const lock = await WorkflowLockManager.readLock(
        workspaceRoot,
        workflowKey
      );
      if (!lock) {
        continue;
      }

      const runFilePath = WorkflowPaths.runFilePath(
        workspaceRoot,
        workflowKey,
        lock.runRef as RunRef
      );

      let runningFile: {
        _runtime?: {
          executionState?: string;
          currentIndex?: number;
          finalStep?: {
            phase?: string;
            status?: string;
            completedAt?: number;
          };
        };
        steps?: Array<{
          _runtime?: {
            startedAt?: number;
            completedAt?: number;
            terminalStatus?: string;
          };
        }>;
        [key: string]: unknown;
      };

      try {
        const content = await fs.promises.readFile(runFilePath, "utf8");
        runningFile = JSON.parse(content);
      } catch {
        // Race condition: file being written mid-read, or already gone — skip safely
        continue;
      }

      const executionState = runningFile._runtime?.executionState;
      if (
        executionState !== EXECUTION_STATES.RUNNING &&
        executionState !== EXECUTION_STATES.PAUSING &&
        executionState !== EXECUTION_STATES.CANCELLING
      ) {
        continue;
      }

      const status = await WorkflowLockManager.checkLock(
        workspaceRoot,
        workflowKey
      );

      if (status === LOCK_STATUS.ACTIVE_CLI) {
        Log.info(
          `[WorkflowLockManager] normalizeStaleLocks: ${workflowKey} is active-cli — preserving RUNNING`
        );
        activeCli.push(runFilePath);
        continue;
      }

      if (status === LOCK_STATUS.ACTIVE_VSCODE) {
        Log.info(
          `[WorkflowLockManager] normalizeStaleLocks: ${workflowKey} is active-vscode — preserving live VS Code run`
        );
        continue;
      }

      // "none" or "stale"
      Log.info(
        `[WorkflowLockManager] normalizeStaleLocks: normalizing ${workflowKey} from ${executionState} → stopped (lock=${status})`
      );

      if (runningFile._runtime) {
        runningFile._runtime.executionState = EXECUTION_STATES.STOPPED;
        const currentIndex = runningFile._runtime.currentIndex ?? 0;
        const interruptedStep = runningFile.steps?.[currentIndex];
        if (
          interruptedStep?._runtime?.startedAt &&
          !interruptedStep._runtime.completedAt
        ) {
          const stoppedAt = Date.now();
          interruptedStep._runtime = {
            startedAt: interruptedStep._runtime?.startedAt ?? stoppedAt,
            ...interruptedStep._runtime,
            completedAt: stoppedAt,
            terminalStatus: PROMPT_TERMINAL_STATUS.CANCELLED,
          };
          runningFile._runtime.currentIndex = currentIndex + 1;
        } else if (
          currentIndex >= (runningFile.steps?.length ?? 0) &&
          runningFile._runtime.finalStep?.phase ===
            FINAL_STEP_PHASES.FINAL_STEP &&
          runningFile._runtime.finalStep.status !== STEP_STATUS.COMPLETED
        ) {
          runningFile._runtime.finalStep = {
            ...runningFile._runtime.finalStep,
            status: STEP_STATUS.CANCELLED,
            completedAt: Date.now(),
          };
        }
      }
      try {
        const tmpPath = runFilePath + ".tmp";
        await fs.promises.writeFile(
          tmpPath,
          JSON.stringify(runningFile, null, 2),
          "utf8"
        );
        await fs.promises.rename(tmpPath, runFilePath);
        recoveredRunFiles.push(runFilePath);
      } catch (writeErr) {
        Log.warn(
          `[WorkflowLockManager] normalizeStaleLocks: failed to normalize ${workflowKey}:`,
          writeErr
        );
      }

      // Clean up the stale lock file directly (no live owner token to check against).
      try {
        await fs.promises.unlink(
          WorkflowLockManager.getLockPath(workspaceRoot, workflowKey)
        );
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
          Log.warn(
            `[WorkflowLockManager] normalizeStaleLocks: failed to remove stale lock for ${workflowKey}:`,
            unlinkErr
          );
        }
      }
    }

    return { activeCliRunFiles: activeCli, recoveredRunFiles };
  }
}
