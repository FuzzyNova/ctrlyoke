import * as fs from "fs";
import * as path from "path";
import {
  WorkflowRunnerLock,
  type WorkflowKey,
  type WorkingFile,
} from "../types/CtrlYokeTypes";
import {
  ACTIVE_EXECUTION_STATES,
  EXECUTION_STATES,
  WORKFLOW_LOCK_LIVENESS,
} from "../types/DashboardConstants";
import type { ExecutionState } from "../types/DashboardConstants";
import { settleInterruptedRun } from "./InterruptedRunSettlement";
import { Log } from "./Log";
import * as WorkflowPaths from "./WorkflowPaths";
import {
  readWorkflowLock,
  readWorkflowLockAtPath,
  readWorkflowLockInspection,
} from "./WorkflowLockInspector";
import { withFileLock } from "./FileLockUtils";
import { writeFileAtomic } from "./AtomicFileUtils";
import { runStateWriteOptions } from "./RunStateWrites";
import {
  hasNewerSchema,
  isNewerRunFile,
  PERSISTED_STORES,
} from "./PersistedSchemaGuard";
import { generateOwnerToken, isOwnerStale } from "./LockSafetyPrimitives";

export {
  HEARTBEAT_INTERVAL_MS,
  STALE_HEARTBEAT_MS,
} from "./LockSafetyPrimitives";

const ACQUIRE_TIMEOUT_MS = 5_000;
const ACQUIRE_RETRY_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reclaim only the stale owner inspected by the caller, under the lock mutex. */
async function reclaimIfStale(
  lockPath: string,
  expectedToken: string | undefined
): Promise<boolean> {
  return withFileLock(lockPath, async () => {
    const current = await readWorkflowLockAtPath(lockPath);
    if ((current?.ownerToken ?? undefined) !== expectedToken) return false;
    if (
      current &&
      (hasNewerSchema(PERSISTED_STORES.RUNNER_LOCK, current) ||
        !isOwnerStale(current.pid, current.lastHeartbeat))
    ) {
      return false;
    }

    await fs.promises.unlink(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return true;
  });
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
   *
   * **The `runner.json` file mutex is taken per attempt, never across the whole
   * wait.** `releaseLock`/`updateHeartbeat` take that same mutex, so holding it
   * for the full retry window makes this method block the very release it is
   * spinning for: the previous owner's release queues behind it and can only
   * land *after* the acquire has already given up, turning every legitimate
   * hand-off into a guaranteed 5s failure. That is what a re-run hits when the
   * previous run is still tearing down a retained PTY — the observed shape is
   * `Timed out waiting for runner lock: <key> (held by a live owner)` followed
   * within ~50ms by the previous owner's `releaseLock` for the same lineage.
   * Correctness does not need the wider hold: each attempt's `open(…, "wx")` is
   * itself the exclusive-create, and the mutex only serializes the
   * read-then-unlink of a stale owner's record against a concurrent writer.
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
    const content = JSON.stringify(lock, null, 2);
    const startTime = Date.now();

    do {
      const acquired = await withFileLock(lockPath, async () => {
        try {
          const handle = await fs.promises.open(lockPath, "wx");
          try {
            await handle.writeFile(content, "utf8");
          } finally {
            await handle.close();
          }
          Log.debug(
            `[WorkflowLockManager] acquireLock: ${workflowKey} ${lock.runRef}`
          );
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
          return false;
        }
      });

      if (acquired) return;
      const existing = await readWorkflowLock(workspaceRoot, workflowKey);
      // Never remove a lock that changed after inspection; revalidate it under
      // the shared mutex before reclaiming.
      await reclaimIfStale(lockPath, existing?.ownerToken);
      await sleep(ACQUIRE_RETRY_DELAY_MS);
    } while (Date.now() - startTime < ACQUIRE_TIMEOUT_MS);

    throw new Error(
      `Timed out waiting for runner lock: ${workflowKey} (held by a live owner)`
    );
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
        const existing = await readWorkflowLock(workspaceRoot, workflowKey);
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
        const existing = await readWorkflowLock(workspaceRoot, workflowKey);
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
   * Normalize stale locks on extension startup.
   *
   * Scans every lineage directory under run storage. For each lineage whose
   * locked `RunRef`'s `_runtime.executionState` is active (running/pausing/paused/cancelling):
   *   - "none" or "stale" lock  → removes the stale lock file and, unless the run is
   *     PAUSED, writes "stopped" to that run's `_runtime.executionState`
   *   - active lock             → preserves the live run and lock
   *
   * PAUSED keeps its state: a pause is only confirmed at a step boundary, so a dead
   * owner left nothing in flight to settle, and PAUSED is how the dashboard tells a
   * run the user deliberately paused apart from one that was stopped or interrupted.
   * Resume re-acquires the lock (and any worktree) on whichever host continues it.
   *
   * Returns the exact run file paths recovered/still-active, keyed by lineage.
   * A paused run is in neither list: it was not interrupted and is not executing.
   */
  static async normalizeStaleLocks(
    workspaceRoot: string,
    workflowKeys: WorkflowKey[]
  ): Promise<{
    activeRunFiles: string[];
    recoveredRunFiles: string[];
  }> {
    const activeRunFiles: string[] = [];
    const recoveredRunFiles: string[] = [];

    for (const workflowKey of workflowKeys) {
      const lockInspection = await readWorkflowLockInspection(
        workspaceRoot,
        workflowKey
      );

      // Older lock records can lack enough fields for the structured inspector
      // to classify them. Keep their existing recovery behavior, while the
      // reclamation helper still verifies the same token and liveness fields.
      const lock =
        lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ABSENT
          ? await readWorkflowLock(workspaceRoot, workflowKey)
          : lockInspection.lock;
      if (!lock) continue;
      try {
        WorkflowPaths.assertValidRunRef(lock.runRef);
      } catch {
        Log.warn(
          `[WorkflowLockManager] normalizeStaleLocks: skipping ${workflowKey} with invalid runRef: ${String(lock.runRef)}`
        );
        continue;
      }

      const runFilePath = WorkflowPaths.runFilePath(
        workspaceRoot,
        workflowKey,
        lock.runRef
      );
      let initialRun: WorkingFile;
      try {
        initialRun = JSON.parse(await fs.promises.readFile(runFilePath, "utf8"));
      } catch {
        continue;
      }
      const initialState = initialRun._runtime?.executionState;
      if (
        isNewerRunFile(initialRun) ||
        !initialState ||
        !ACTIVE_EXECUTION_STATES.has(initialState as ExecutionState)
      ) continue;

      if (lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE) {
        Log.info(
          `[WorkflowLockManager] normalizeStaleLocks: ${workflowKey} has an active lock — preserving live run`
        );
        activeRunFiles.push(runFilePath);
        continue;
      }

      try {
        const reclaimed = await reclaimIfStale(
          WorkflowLockManager.getLockPath(workspaceRoot, workflowKey),
          lock.ownerToken
        );
        if (reclaimed) {
          let runningFile: WorkingFile;
          try {
            runningFile = JSON.parse(
              await fs.promises.readFile(runFilePath, "utf8")
            );
          } catch {
            continue;
          }
          const executionState = runningFile._runtime?.executionState;
          if (
            isNewerRunFile(runningFile) ||
            !executionState ||
            !ACTIVE_EXECUTION_STATES.has(executionState as ExecutionState) ||
            executionState === EXECUTION_STATES.PAUSED
          ) continue;

          runningFile._runtime!.executionState = EXECUTION_STATES.STOPPED;
          settleInterruptedRun(runningFile);
          await writeFileAtomic(
            runFilePath,
            JSON.stringify(runningFile, null, 2),
            runStateWriteOptions(
              runFilePath,
              "WorkflowLockManager.normalizeStaleLocks"
            )
          );
          recoveredRunFiles.push(runFilePath);
          Log.info(
            `[WorkflowLockManager] normalizeStaleLocks: recovered ${workflowKey} from ${lock.runRef}`
          );
        } else {
          const latest = await readWorkflowLockInspection(
            workspaceRoot,
            workflowKey
          );
          if (latest.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE) {
            activeRunFiles.push(
              WorkflowPaths.runFilePath(
                workspaceRoot,
                workflowKey,
                latest.lock.runRef
              )
            );
          }
        }
      } catch (writeErr) {
        Log.warn(
          `[WorkflowLockManager] normalizeStaleLocks: failed to normalize ${workflowKey}:`,
          writeErr
        );
      }
    }

    return { activeRunFiles, recoveredRunFiles };
  }
}
